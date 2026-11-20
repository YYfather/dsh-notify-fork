import test from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { buildServerChanBody, buildServerChanPayload, formatServerChanTitle } from '../lib/adapters/serverchan.js';
import { adapterPayloadFor } from '../lib/routes.js';

const event = {
  type: 'conversationCompleted',
  title: '✅ [DSHwork] 对话完成',
  message: 'body',
  metadata: { workspace: 'DSHwork', title: '修通知插件的问题', steps: 12 },
};

test('default title is device · workspace · conversation', () => {
  const title = formatServerChanTitle(event);
  assert.equal(title, `DSH状态更新 · ${hostname()}`);
  assert.ok(title.length <= 100);
});

test('device and template are configurable', () => {
  const title = formatServerChanTitle(event, { device: '书房台式机', titleTemplate: '{status}|{device}|{workspace}|{title}' });
  assert.equal(title, '完成|书房台式机|DSHwork|修通知插件的问题');
});

test('missing pieces degrade to sensible words', () => {
  const title = formatServerChanTitle({ type: 'conversationFailed', metadata: {} }, { device: 'PC' });
  assert.equal(title, 'DSH状态更新 · PC');
});

test('newlines never reach the title', () => {
  const title = formatServerChanTitle({ type: 'conversationCompleted', metadata: { workspace: 'A\nB', title: 'C\nD' } }, { device: 'PC' });
  assert.ok(!title.includes('\n'));
});

test('payload keeps the body and the optional channel', () => {
  const payload = buildServerChanPayload(event, { channel: 2, device: 'PC' });
  assert.equal(payload.desp, 'body');
  assert.equal(payload.channel, '2');
  assert.match(payload.title, /^DSH状态更新 · PC$/);
});

test('serverchan adapter is skipped for wecom-only routes', () => {
  const e = { title: 't', message: 'm', metadata: {} };
  assert.equal(adapterPayloadFor({ name: 'serverchan' }, e, { mode: 'status', via: 'wecom' }), null);
});

test('status mode no longer rewrites the body (adapter owns it)', () => {
  const e = { title: 't', message: 'body', metadata: { steps: 4, title: '会话A' } };
  const payload = adapterPayloadFor({ name: 'serverchan' }, e, { mode: 'status', via: 'serverchan' });
  assert.equal(payload.message, 'body');
});
test('routing leaves the body alone for both channel kinds', () => {
  const event = { title: 't', message: '💬 问题\n🤖 回复', metadata: { workspace: 'DSHwork', title: '会话A' } };
  assert.equal(adapterPayloadFor({ name: 'wecom-aibot', botKey: 'main' }, event, { mode: 'status' }).message, event.message);
  assert.equal(adapterPayloadFor({ name: 'serverchan' }, event, { mode: 'status' }).message, event.message);
});
test('serverchan body is a header list plus the reply with its own breaks', () => {
  const event = { title: 't', message: 'ignored', metadata: { workspace: 'DSHwork', title: '会话A', reply: '第一行\n第二行\n\n空行后的段落' } };
  const body = buildServerChanBody(event);
  assert.ok(body.includes('- 📁 DSHwork'));
  assert.ok(body.includes('- 💬 会话A'));
  const rows = body.split('\n');
  assert.ok(rows.some((row) => row.startsWith('第一行  ')));
  assert.ok(rows.some((row) => row.startsWith('第二行')));
});

test('off still mutes every routed channel', () => {
  const e = { title: 't', message: 'm', metadata: {} };
  assert.equal(adapterPayloadFor({ name: 'serverchan' }, e, { enabled: false }), null);
  assert.equal(adapterPayloadFor({ name: 'wecom-aibot', botKey: 'main' }, e, { mode: 'off' }), null);
});