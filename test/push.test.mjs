import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'notify-routes-'));
process.env.DSH_HOME = home;

const {
  routesFilePath, readRoutesRaw, writeRoutesRaw, setWorkspaceRoute,
  describeWorkspaces, loadRoutesCached, modeLabel,
} = await import('../lib/routes.js');

test('routing file lives under DSH_HOME', () => {
  assert.equal(routesFilePath(), join(home, 'notify', 'routes.json'));
});

test('setWorkspaceRoute persists and preserves unrelated keys', () => {
  writeRoutesRaw({ aibots: [{ id: 'main', botId: 'x', secret: 'y' }], workspaceRoutes: {} });
  setWorkspaceRoute('E:\\studywork\\DSHwork', { mode: 'status' });
  const raw = readRoutesRaw();
  assert.equal(raw.aibots.length, 1);
  assert.equal(raw.workspaceRoutes['E:\\studywork\\DSHwork'].mode, 'status');
});

test('setWorkspaceRoute updates an existing key regardless of slash style', () => {
  setWorkspaceRoute('e:/STUDYWORK/dshwork', { mode: 'off' });
  const raw = readRoutesRaw();
  const keys = Object.keys(raw.workspaceRoutes);
  assert.equal(keys.length, 1);
  assert.equal(raw.workspaceRoutes[keys[0]].mode, 'off');
});

test('default removes the override', () => {
  setWorkspaceRoute('E:\\studywork\\DSHwork', { mode: 'default' });
  assert.equal(Object.keys(readRoutesRaw().workspaceRoutes).length, 0);
});

test('describeWorkspaces reports effective mode and whether it is explicit', () => {
  writeRoutesRaw({ workspaceRoutes: { '*': { mode: 'status' }, 'D:\\paper': { mode: 'off' } } });
  const rows = describeWorkspaces({ '*': { mode: 'status' }, 'D:\\paper': { mode: 'off' } }, [
    { title: 'paper', path: 'D:\\paper' },
    { title: 'api', path: 'E:\\code\\api' },
  ]);
  assert.deepEqual(rows.map((r) => r.mode), ['off', 'status']);
  assert.deepEqual(rows.map((r) => r.explicit), [true, false]);
});

test('cached loader picks up an external edit', async () => {
  writeRoutesRaw({ workspaceRoutes: { '*': { mode: 'full' } } });
  assert.equal(loadRoutesCached().workspaceRoutes['*'].mode, 'full');
  await new Promise((resolve) => setTimeout(resolve, 20));
  writeRoutesRaw({ workspaceRoutes: { '*': { mode: 'off' } } });
  assert.equal(loadRoutesCached().workspaceRoutes['*'].mode, 'off');
});

test('mode labels', () => {
  assert.match(modeLabel('off'), /off/);
  assert.match(modeLabel('status'), /status/);
  assert.match(modeLabel('full'), /full/);
});