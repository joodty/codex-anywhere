import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { useNewSessionModel } from '../web/src/new-session-model.js';
import type { BridgeRequest } from '../web/src/bridge-request-manager.js';

const model = { model: 'chosen', displayName: 'Chosen', description: '', isDefault: true, defaultReasoningEffort: 'low',
  supportedReasoningEfforts: ['low', 'high'].map(reasoningEffort => ({ reasoningEffort, description: '' })),
  serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }], defaultServiceTier: null };
async function fixture(t: test.TestContext, request: BridgeRequest) {
  const keys = ['window', 'document', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const saved = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  const stored = new Map<string, string>();
  const storage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
  for (const [key, value] of [['window', window], ['document', document], ['localStorage', storage], ['IS_REACT_ACT_ENVIRONMENT', true]] as const) Object.defineProperty(globalThis, key, { configurable: true, value });
  const root = createRoot(document.getElementById('root')!); let state!: ReturnType<typeof useNewSessionModel>;
  function Harness(props: any) { state = useNewSessionModel({ environmentId: 'a', online: true, active: true, request, ...props }); return null; }
  t.after(async () => { await act(async () => root.unmount()); for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  return { stored, state: () => state, render: async (props = {}) => { await act(async () => root.render(createElement(Harness, props))); } };
}

test('new-chat model draft loads without a task, keeps immutable submission snapshots and scopes preferences to the environment', async t => {
  const calls: string[] = [];
  const f = await fixture(t, (async action => { calls.push(action); return { models: [model] }; }) as BridgeRequest);
  await f.render(); assert.deepEqual(calls, ['models.list']);
  assert.deepEqual(f.state().snapshot(), { model: 'chosen', reasoningEffort: 'low', fastMode: false });
  await act(async () => f.state().save({ model: 'chosen', reasoningEffort: 'high', fastMode: true }));
  const submission = f.state().snapshot(); assert.equal(Object.isFrozen(submission), true);
  await act(async () => f.state().save({ model: 'chosen', reasoningEffort: 'low', fastMode: false }));
  assert.equal(submission.reasoningEffort, 'high'); assert.equal(submission.fastMode, true);
  assert.equal(f.stored.size, 1);
  await f.render({ environmentId: 'b' }); assert.equal(f.state().snapshot().reasoningEffort, 'low');
  await act(async () => f.state().save({ model: 'chosen', reasoningEffort: 'high', fastMode: false })); assert.equal(f.stored.size, 2);
  await f.render({ environmentId: 'a' }); assert.equal(f.state().snapshot().fastMode, false);
  assert.ok(calls.every(action => action === 'models.list'));
});

test('stale catalogs are ignored across environments, aborted on close, and failures have an explicit retry', async t => {
  const reads: Array<{ resolve: (value: any) => void; reject: (error: Error) => void; signal: AbortSignal }> = [];
  const f = await fixture(t, (async (_action, _payload, options) => new Promise((resolve, reject) => reads.push({ resolve, reject, signal: options.signal }))) as BridgeRequest);
  await f.render(); await f.render({ environmentId: 'b' }); assert.equal(reads[0].signal.aborted, true);
  await act(async () => reads[0].resolve({ models: [model] })); assert.equal(f.state().config, null);
  await act(async () => reads[1].reject(new Error('request_timeout'))); assert.ok(f.state().error); assert.throws(() => f.state().snapshot(), /model_not_available/);
  await act(async () => f.state().refresh()); await act(async () => reads[2].resolve({ models: [model] })); assert.equal(f.state().snapshot().model, 'chosen');
  await f.render({ environmentId: 'b', active: false }); assert.equal(reads[2].signal.aborted, true);
  await f.render({ environmentId: 'b', active: false, online: false }); assert.throws(() => f.state().snapshot(), /model_not_available/);
});
