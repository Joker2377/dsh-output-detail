/** Read-only compatibility checks using an explicitly supplied DSH installation. */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createProjection } from '../lib/projection.js';

if (!process.argv[2]) throw new Error('Usage: node scripts/runtime-check.mjs <DSH-installation-root>');
const root = fileURLToPath(new URL('../', import.meta.url));
const fromRuntime = createRequire(resolve(process.argv[2], 'package.json'));
const { z } = fromRuntime('zod');
const yaml = fromRuntime('yaml');
const definition = createProjection(z);
assert.equal(definition.key, 'output-detail');
const state = definition.init({ id: 'test-session', createdAt: 0, version: 1, isSeeded: false }, 0);
assert.deepEqual(definition.stateSchema.parse(state), state);
assert.equal(definition.wire.view(state).level, 3);
assert.deepEqual(definition.wire.viewSchema.parse(definition.wire.view(state)), definition.wire.view(state));
assert.equal(definition.stateSchema.safeParse({ ...state, level: 8 }).success, false);
assert.equal(definition.wire.viewSchema.safeParse({ level: 8, mode: 'best-effort', promptVersion: 1 }).success, false);
const patch = yaml.parse(await readFile(resolve(root, 'cordis.patch.yml'), 'utf8'));
assert.deepEqual(patch, [{ insert: [{ id: 'output-detail', name: 'dsh-output-detail' }] }]);
console.log('Real Zod state/view schemas and YAML bundle patch passed against supplied DSH dependencies.');

const { Context } = fromRuntime('@deepseek-ai/cordis');
const { Session } = fromRuntime('@deepseek-ai/dsh-session');
const { SessionProjectionRegistry } = fromRuntime('@deepseek-ai/dsh-session-projection');
const context = new Context();
const registry = new SessionProjectionRegistry(context);
const unregister = registry.register(definition);
try {
  const session = Session.create('output-detail-runtime-smoke');
  assert.equal(registry.stateOf(session, definition.key).level, 3);
  // Establish the carrier's initial wire baseline before measuring changes.
  assert.equal(registry.snapshot(session).values[definition.key].level, 3);
  const changed = [];
  const offChanged = registry.onChanged((_session, key, value) => changed.push({ key, value }));
  const run = session.append('command/run', { commandId: 'smoke-command', name: 'output-detail', args: '5', source: { kind: 'user' } });
  await context.parallel('session/event', session, run);
  const done = session.append('command/done', { commandId: 'smoke-command', kind: 'success' });
  await context.parallel('session/event', session, done);
  assert.equal(registry.stateOf(session, definition.key).level, 5);
  assert.equal(registry.snapshot(session).values[definition.key].level, 5);
  // The registry's first eager drive publishes its initial baseline, even after snapshot().
  assert.deepEqual(changed.map(change => change.value.level), [3, 5]);
  const pending = session.append('command/run', { commandId: 'pending-command', name: 'output-detail', args: '4', source: { kind: 'user' } });
  await context.parallel('session/event', session, pending);
  assert.equal(changed.length, 2, 'subsequent internal-only changes keep the same raw wire view');
  const unrelated = session.append('command/run', { commandId: 'other-command', name: 'other', args: '', source: { kind: 'user' } });
  await context.parallel('session/event', session, unrelated);
  assert.equal(changed.length, 2, 'unrelated events must not republish the detail view');
  offChanged();
  console.log('Real Cordis + Session + SessionProjectionRegistry: initial read, eager event fold, wire snapshot, stable view and disposal passed.');
} finally {
  unregister();
  await context.fiber.dispose();
}

