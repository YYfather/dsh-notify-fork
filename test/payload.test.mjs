import test from 'node:test';
import assert from 'node:assert/strict';
import { adapterPayloadFor } from '../lib/routes.js';

test('dedicated bot receives only its own workspace at full detail', () => {
  const route = { key: 'D:\\paper', mode: 'full', bot: 'paper' };
  const event = { title: '✅ [paper] 对话完成', message: 'FULL', metadata: { title: 't' } };
  assert.equal(adapterPayloadFor({ name: 'wecom-aibot', botKey: 'paper' }, event, route), event);
  assert.equal(adapterPayloadFor({ name: 'wecom-aibot', botKey: 'main' }, event, route).message.includes('paper'), true);
});

test('main bot collapses to a pointer when a dedicated bot owns the workspace', () => {
  const route = { key: 'D:\\paper', mode: 'full', bot: 'paper' };
  const payload = adapterPayloadFor({ name: 'wecom-aibot', botKey: 'main' }, { title: 'x', message: 'SECRET' }, route);
  assert.ok(!payload.message.includes('SECRET'));
  assert.match(payload.message, /paper/);
});

test('企业微信 keeps the upstream body untouched', () => {
  const route = { key: '*', mode: 'status' };
  const event = { title: '✅ [DSHwork] 对话完成', message: '💬 问题\n🤖 回复', metadata: { steps: 3, title: '会话A' } };
  const payload = adapterPayloadFor({ name: 'wecom-aibot', botKey: 'main' }, event, route);
  assert.equal(payload.message, event.message);
  assert.equal(payload.title, event.title);
});

test('non-aibot channels always receive the untouched event', () => {
  const event = { title: 'x', message: 'FULL', metadata: {} };
  assert.equal(adapterPayloadFor({ name: 'system' }, event, { mode: 'status' }), event);
});