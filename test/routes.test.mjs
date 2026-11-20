import test from 'node:test';
import assert from 'node:assert/strict';
import { basenameOf, buildStatusMessage, formatDuration, resolveWorkspaceRoute, routeBotId, routeMode } from '../lib/routes.js';

const table = {
  '*': { mode: 'status' },
  'D:\\paper': { mode: 'full', bot: 'paper' },
  'E:\\code\\api': { mode: 'off' },
};

test('exact path wins over wildcard', () => {
  const route = resolveWorkspaceRoute(table, 'd:/paper', undefined);
  assert.equal(route.key, 'D:\\paper');
  assert.equal(routeMode(route), 'full');
  assert.equal(routeBotId(route), 'paper');
});

test('windows and posix separators normalise', () => {
  assert.equal(resolveWorkspaceRoute(table, 'D:/paper/sub', undefined).key, '*');
  assert.equal(resolveWorkspaceRoute(table, '/x/E:/paper', undefined).key, 'D:\\paper');
});

test('off route disables the push', () => {
  assert.equal(routeMode(resolveWorkspaceRoute(table, 'E:\\code\\api', undefined)), 'off');
});

test('basename fallback matches when cwd is missing', () => {
  assert.equal(resolveWorkspaceRoute(table, undefined, 'paper').key, 'D:\\paper');
});

test('empty table keeps legacy behaviour', () => {
  const route = resolveWorkspaceRoute({}, 'D:\\paper', 'paper');
  assert.equal(routeMode(route), 'full');
  assert.equal(routeBotId(route), 'main');
});

test('unknown workspace falls back to wildcard', () => {
  assert.equal(resolveWorkspaceRoute(table, 'F:\\other', 'other').key, '*');
});

test('status message carries counts and title only', () => {
  const text = buildStatusMessage({ steps: 12, tools: ['a', 'b'], durationMs: 134000, title: '修通知插件', userPrompt: 'SECRET', reply: 'SECRET' });
  assert.match(text, /12 步/);
  assert.match(text, /2 类工具/);
  assert.match(text, /2 分 14 秒/);
  assert.match(text, /会话：修通知插件/);
  assert.ok(!text.includes('SECRET'));
});

test('basename and duration helpers', () => {
  assert.equal(basenameOf('E:\\studywork\\DSHwork'), 'DSHwork');
  assert.equal(formatDuration(9000), '9 秒');
  assert.equal(formatDuration(65000), '1 分 5 秒');
});
