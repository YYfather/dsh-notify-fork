import test from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { buildServerChanPayload, formatServerChanTitle } from '../lib/adapters/serverchan.js';
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

test('status mode strips the body but keeps counts', () => {
  const e = { title: 't', message: '💬 SECRET', metadata: { steps: 4, title: '会话A' } };
  const payload = adapterPayloadFor({ name: 'serverchan' }, e, { mode: 'status', via: 'serverchan' });
  assert.ok(!payload.message.includes('SECRET'));
  assert.match(payload.message, /💬 会话A/);
});
test('企业微信 passes through while Server酱 stays brief', () => {
  const event = { title: 't', message: '💬 问题\n🤖 回复', metadata: { workspace: 'DSHwork', title: '会话A', steps: 3 } };
  assert.equal(adapterPayloadFor({ name: 'wecom-aibot', botKey: 'main' }, event, { mode: 'status' }).message, event.message);
  const brief = adapterPayloadFor({ name: 'serverchan' }, event, { mode: 'status' });
  assert.ok(brief.message.startsWith('📁 DSHwork'));
  assert.ok(!brief.message.includes('💬 问题'));
});
test('default brief body carries counts plus a gist', () => {
  const briefEvent = { title: 't', message: '💬 问题\n🤖 我改了通知插件的路由表并跑通了测试', metadata: { workspace: 'DSHwork', steps: 12, title: '会话A', reply: '我改了通知插件的路由表并跑通了测试' } };
  const payload = adapterPayloadFor({ name: 'serverchan' }, briefEvent, { mode: 'status' }, {});
  assert.equal(payload.message.split('\n').length, 3);
  assert.match(payload.message.split('\n')[0], /^📁 /);
  assert.match(payload.message.split('\n')[1], /^💬 会话A/);
  assert.match(payload.message.split('\n')[2], /^🗒 我改了通知插件/);
  assert.ok(!payload.message.includes('💬 问题'));
});

test('off still mutes every routed channel', () => {
  const e = { title: 't', message: 'm', metadata: {} };
  assert.equal(adapterPayloadFor({ name: 'serverchan' }, e, { enabled: false }), null);
  assert.equal(adapterPayloadFor({ name: 'wecom-aibot', botKey: 'main' }, e, { mode: 'off' }), null);
});