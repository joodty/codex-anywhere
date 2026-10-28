import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexAppServer } from '../src/connector/codex-app-server.js';
import { initialModelSettings, resolveModelSettings, type ModelOption } from '../src/shared/model-config.js';

const model: ModelOption = { model: 'chosen', displayName: 'Chosen', description: '', isDefault: true,
  supportedReasoningEfforts: ['low', 'high'].map(reasoningEffort => ({ reasoningEffort, description: '' })),
  defaultReasoningEffort: 'low', serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }], defaultServiceTier: null };
const draft = { model: 'chosen', reasoningEffort: 'high', fastMode: true };
function fixture(t: test.TestContext) {
  const app = new CodexAppServer({ allowedRoots: [process.cwd()], allowFullAccess: true, networkAccess: true });
  t.after(() => app.close()); app.ensureStarted = async () => {};
  const calls: Array<{ method: string; params: any }> = [];
  app.listModels = async () => [model];
  app.rpcRaw = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'created', cwd: process.cwd() } };
    if (method === 'turn/start') return { turn: { id: 'first-turn' } };
    return {};
  };
  return { app, calls };
}

test('new chat applies the validated model, effort and speed to creation and its first turn while retaining permissions', async t => {
  const { app, calls } = fixture(t);
  await app.startTurn({ text: 'first message', cwd: process.cwd(), permissionMode: 'full', modelConfig: draft });
  const created = calls.find(call => call.method === 'thread/start')!.params;
  assert.equal(created.model, 'chosen'); assert.equal(created.serviceTier, 'priority');
  assert.equal(created.config.model_reasoning_effort, 'high');
  assert.equal(created.config.sandbox_mode, 'danger-full-access');
  assert.equal(created.approvalPolicy, 'never');
  const first = calls.find(call => call.method === 'turn/start')!.params;
  assert.equal(first.model, 'chosen'); assert.equal(first.effort, 'high'); assert.equal(first.serviceTier, 'priority');
  assert.deepEqual(first.sandboxPolicy, { type: 'dangerFullAccess' });
  assert.ok(!calls.some(call => call.method === 'config/write' || call.method === 'thread/settings/update'));
});

test('invalid or obsolete creation settings cannot create a chat or fall back to a different model', async t => {
  const { app, calls } = fixture(t);
  for (const invalid of [{ ...draft, model: 'gone' }, { ...draft, reasoningEffort: 'ultra' }, { ...draft, fastMode: 'true' }]) {
    await assert.rejects(app.startTurn({ text: 'first', cwd: process.cwd(), modelConfig: invalid }), /model_not_available|reasoning_effort_not_available|model_config_invalid/);
    assert.equal(app.activeTurns.size, 0);
  }
  assert.equal(calls.length, 0);
  await assert.rejects(app.startTurn({ threadId: 'existing', text: 'next', modelConfig: draft }), /model_config_creation_only/);
});

test('canceling while the catalog loads prevents both conversation creation and the first turn', async t => {
  const { app, calls } = fixture(t); let release!: (models: ModelOption[]) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  app.listModels = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const pending = app.startTurn({ text: 'first', cwd: process.cwd(), modelConfig: draft });
  await started; app.activeTurns.values().next().value!.cancelRequested = true; release([model]);
  await assert.rejects(pending, /turn_cancelled/); assert.equal(calls.length, 0); assert.equal(app.activeTurns.size, 0);
});

test('older clients may omit creation settings without changing default behavior', async t => {
  const { app, calls } = fixture(t); app.listModels = async () => assert.fail('no model override must not request a catalog');
  await app.startTurn({ text: 'first', cwd: process.cwd() });
  assert.equal(calls.find(call => call.method === 'thread/start')!.params.model, undefined);
  assert.equal(calls.find(call => call.method === 'turn/start')!.params.effort, undefined);
});

test('shared resolver enforces advertised capabilities and treats standard speed consistently', () => {
  assert.equal(resolveModelSettings([model], { ...draft, fastMode: false }).serviceTier, 'default');
  assert.throws(() => resolveModelSettings([{ ...model, serviceTiers: [] }], draft), /fast_mode_not_available/);
  assert.equal(initialModelSettings([model], { model: 'removed', reasoningEffort: 'ultra', fastMode: false }).model, 'chosen');
  assert.equal(initialModelSettings([model], { reasoningEffort: 'unsupported' }).reasoningEffort, 'low');
  assert.throws(() => initialModelSettings([], null), /model_not_available/);
});
