import test from 'node:test';
import assert from 'node:assert/strict';
import { channelConfig, bindingList, eventKeyOf, inScope, resolveAdapterPayload } from '../lib/routes.js';

const rules = {
  channels: {
    wecom: { enabled: true, events: ['completed', 'failed'], workspaces: ['*'] },
    serverchan: { enabled: true, events: ['completed'], workspaces: ['*'] },
  },
  bindings: [{ workspace: 'D:\\paper', bot: 'paper', events: ['completed'] }],
};

const base = (extra = {}) => ({ type: 'conversationCompleted', title: 't', message: 'm', metadata: { workspace: 'DSHwork', title: '会话A', ...extra } });

test('event types map to filter keys', () => {
  assert.equal(eventKeyOf('conversationCompleted'), 'completed');
  assert.equal(eventKeyOf('unknown'), '');
});

test('channel event filter gates each channel', () => {
  const failed = { type: 'conversationFailed', title: 't', message: 'm', metadata: {} };
  assert.ok(resolveAdapterPayload({ name: 'wecom-aibot', botKey: 'main' }, failed, rules));
  assert.equal(resolveAdapterPayload({ name: 'serverchan' }, failed, rules), null);
});

test('bound workspace goes through its own bot; Server酱 is unaffected', () => {
  const event = { type: 'conversationCompleted', title: 't', message: 'm', metadata: { cwd: 'D:\\paper' } };
  assert.ok(resolveAdapterPayload({ name: 'serverchan' }, event, rules));
  assert.ok(resolveAdapterPayload({ name: 'wecom-aibot', botKey: 'paper' }, event, rules));
  const main = resolveAdapterPayload({ name: 'wecom-aibot', botKey: 'main' }, event, rules);
  // The general bot degrades to a status line instead of the full body.
  assert.notEqual(main.message, event.message);
});

test('dedicated bot sends every event type in full', () => {
  const event = { type: 'conversationFailed', title: 't', message: 'm', metadata: { cwd: 'D:\\paper' } };
  const payload = resolveAdapterPayload({ name: 'wecom-aibot', botKey: 'paper' }, event, rules);
  assert.equal(payload.message, 'm');
});

test('scope and defaults', () => {
  assert.equal(inScope(['*'], 'X:\\a', 'a'), true);
  assert.equal(inScope(['X:\\a'], 'X:\\a', 'a'), true);
  assert.equal(inScope(['X:\\a'], 'Y:\\b', 'b'), false);
  const cfg = channelConfig({});
  assert.ok(cfg.wecom.enabled);
  assert.deepEqual(bindingList({}), []);
});
