import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MessageQueue, type QueueState, type QueuedMessage } from '../src/connector/message-queue.js';

const idle = (): QueueState => ({ status: 'idle', turnId: null, blocked: false, turns: [] });
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-message-queue-'));
  const queues: MessageQueue[] = [];
  t.after(async () => { for (const queue of queues) await queue.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, path: join(directory, 'queue.json'), queues };
}
const message = (id: string, text = id, threadId = 'chat') => ({ id, threadId, text });

test('queued messages wait for completion, preserve edits/order and survive page closure or connector restart without resending', async t => {
  const f = await fixture(t);
  let state: QueueState = { ...idle(), status: 'active', turnId: 'original', turns: [{ id: 'original', status: 'inProgress' }] };
  const sent: QueuedMessage[] = [];
  const deps = { path: f.path, state: async () => state, send: async (item: QueuedMessage) => {
    sent.push(item); state = { ...state, status: 'active', turnId: 'turn-' + item.id, turns: [...state.turns, { id: 'turn-' + item.id, status: 'inProgress' }] };
    return { turnId: 'turn-' + item.id };
  } };
  const first = new MessageQueue(deps); f.queues.push(first);
  first.add(message('b')); first.add(message('c'));
  await first.tick(); assert.equal(sent.length, 0, 'never steer the original turn');
  const c = first.list('chat').items[1]; first.edit({ ...c, text: 'edited-c' });
  state.status = 'idle'; state.turnId = null;
  await first.tick(); assert.equal(sent.length, 0, 'idle alone is not evidence that the predecessor completed');
  state.turns[0].status = 'completed'; await first.tick(); assert.equal(sent[0].text, 'b');
  await first.tick(); assert.equal(sent.length, 1, 'wait for the actual queued turn, not just the send acknowledgement');
  assert.throws(() => first.edit({ ...first.list('chat').items[0], text: 'changed' }), /queue_message_locked/);
  await first.close();
  const restarted = new MessageQueue(deps); f.queues.push(restarted);
  await restarted.tick(); assert.equal(sent.length, 1, 'a known dispatched turn must not be sent twice after restart');
  state.status = 'idle'; state.turnId = null; state.turns.at(-1)!.status = 'completed';
  await restarted.tick(); await restarted.tick();
  assert.deepEqual(sent.map(item => item.text), ['b', 'edited-c']);
  state.status = 'idle'; state.turnId = null; state.turns.at(-1)!.status = 'completed'; await restarted.tick();
  assert.equal(restarted.list('chat').items.length, 0);
  restarted.add(message('b')); await restarted.tick(); assert.equal(sent.length, 2, 'lost enqueue acknowledgement is idempotent even after completion');
  assert.throws(() => restarted.add(message('b', 'other', 'other-chat')), /queue_message_changed/);
});

test('approvals, unknown state and active goals block dispatch; stopped predecessors require explicit resume', async t => {
  const f = await fixture(t); let state = idle(); let calls = 0;
  const queue = new MessageQueue({ path: f.path, state: async () => state, send: async () => { calls++; return { turnId: 'queued-turn' }; } }); f.queues.push(queue);
  queue.add({ ...message('next'), afterTurnId: 'original' });
  state = { ...idle(), blocked: true }; await queue.tick(); assert.equal(calls, 0);
  state = { ...idle(), status: 'unknown' }; await queue.tick(); assert.equal(calls, 0);
  state = { ...idle(), turns: [{ id: 'original', status: 'interrupted' }] }; await queue.tick();
  assert.equal(queue.list('chat').paused, true); assert.equal(calls, 0);
  queue.resume('chat'); await queue.tick(); assert.equal(calls, 1);
  state = { ...idle(), turns: [{ id: 'queued-turn', status: 'failed' }] }; await queue.tick();
  assert.equal(queue.list('chat').paused, true);
});

test('unknown delivery is never retried automatically, including after restarting the connector', async t => {
  const f = await fixture(t); let calls = 0;
  const deps = { path: f.path, state: async () => idle(), send: async (): Promise<{ turnId: string }> => { calls++; throw new Error('desktop_delivery_unknown'); } };
  const queue = new MessageQueue(deps); f.queues.push(queue); queue.add(message('unknown')); await queue.tick(); await queue.tick();
  assert.equal(calls, 1); assert.equal(queue.list('chat').items[0].status, 'uncertain');
  const restored = new MessageQueue(deps); f.queues.push(restored); await restored.tick();
  assert.equal(calls, 1); assert.throws(() => restored.resume('chat'), /queue_needs_review/);
  const item = restored.list('chat').items[0]; restored.remove(item); restored.resume('chat'); await restored.tick(); assert.equal(calls, 1);
});

test('a crash while dispatching restores a review state and never sends the uncertain message again', async t => {
  const f = await fixture(t); let started!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; }); const barrier = new Promise<void>(resolve => { release = resolve; });
  const queue = new MessageQueue({ path: f.path, state: async () => idle(), send: async () => { started(); await barrier; throw new Error('desktop_delivery_unknown'); } }); f.queues.push(queue);
  queue.add(message('pending')); const sending = queue.tick(); await entered;
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).threads.chat.items[0].status, 'dispatching');
  const recovered = new MessageQueue({ path: f.path, state: async () => idle(), send: async () => assert.fail('must not replay') }); f.queues.push(recovered);
  assert.equal(recovered.list('chat').items[0].status, 'uncertain'); await recovered.tick(); release(); await sending;
});

test('edits and removals are revision checked; removing or pausing during state lookup prevents dispatch', async t => {
  const f = await fixture(t); let release!: (state: QueueState) => void; let sends = 0;
  const queue = new MessageQueue({ path: f.path, state: () => new Promise(resolve => { release = resolve; }), send: async () => { sends++; return { turnId: 'x' }; } }); f.queues.push(queue);
  queue.add(message('a')); const item = queue.list('chat').items[0]; queue.edit({ ...item, text: 'new' });
  assert.throws(() => queue.remove(item), /queue_message_changed/);
  const reading = queue.tick(); queue.remove(queue.list('chat').items[0]); release(idle()); await reading; assert.equal(sends, 0);
  queue.add(message('b')); const paused = queue.tick(); queue.pause('chat'); release(idle()); await paused; assert.equal(sends, 0);
  assert.equal(queue.list('another-chat').items.length, 0);
});

test('storage failure blocks all automatic dispatch instead of acknowledging an unsaved message', async t => {
  const f = await fixture(t); const notDirectory = join(f.directory, 'file'); await writeFile(notDirectory, 'x');
  const queue = new MessageQueue({ path: join(notDirectory, 'queue.json'), state: async () => idle(), send: async () => assert.fail('unsaved messages must not send') }); f.queues.push(queue);
  assert.throws(() => queue.add(message('a')), /queue_storage_unavailable/); await queue.tick();
});

test('manual pause stays paused after a completed item is removed and a new message is added', async t => {
  const f = await fixture(t); let state = idle(), sends = 0;
  const queue = new MessageQueue({ path: f.path, state: async () => state, send: async () => { sends++; return { turnId: 'a-turn' }; } }); f.queues.push(queue);
  queue.add(message('a')); await queue.tick(); queue.pause('chat');
  state = { ...idle(), turns: [{ id: 'a-turn', status: 'completed' }] }; await queue.tick();
  queue.add(message('b')); await queue.tick(); assert.equal(sends, 1); assert.equal(queue.list('chat').paused, true);
  queue.resume('chat'); await queue.tick(); assert.equal(sends, 2);
});

test('message bounds count UTF-8 bytes so a queue response stays within transport limits', async t => {
  const f = await fixture(t);
  const queue = new MessageQueue({ path: f.path, state: async () => idle(), send: async () => assert.fail() }); f.queues.push(queue);
  assert.throws(() => queue.add(message('long', '中'.repeat(35000))), /queue_message_invalid/);
  assert.equal(queue.list('chat').items.length, 0);
});
