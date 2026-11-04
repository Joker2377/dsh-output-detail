import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjection, parseLevelArgument } from '../lib/projection.js';
import { DEFAULT_LEVEL } from '../lib/style.js';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const text = (value) => ({ type: 'text', text: value });
const human = (id, content, extra = {}) => ({
	id,
	role: 'user',
	source: { kind: 'user' },
	content,
	...extra,
});
const run = (seq, commandId, args) => ({
	type: 'command/run',
	seq,
	time: seq,
	data: { commandId, name: 'output-detail', ...(args === undefined ? {} : { args }), source: { kind: 'user' } },
});
const done = (seq, commandId, kind = 'success') => ({
	type: 'command/done',
	seq,
	time: seq,
	data: { commandId, kind },
});
const message = (seq, id, content, extra = {}) => ({
	type: 'user/message',
	seq,
	time: seq,
	data: human(id, content, extra),
});
const spliced = (seq, inserted) => ({
	type: 'agent/inbox/spliced',
	seq,
	time: seq,
	data: { target: 'queue', start: 0, inserted },
});

/** Minimal zod-compatible surface used by createProjection when zod is not installed. */
function stubZ() {
	const chainable = (kind) => {
		const node = { kind };
		node.int = () => node;
		node.min = () => node;
		node.max = () => node;
		node.nullable = () => node;
		return node;
	};
	return {
		number: () => chainable('number'),
		string: () => chainable('string'),
		literal: (value) => ({ kind: 'literal', value }),
		object: (shape) => ({ kind: 'object', shape }),
		array: (item) => ({ kind: 'array', item }),
	};
}

const projection = () => createProjection(stubZ());

function fold(definition, events, { inheritedEventCount = 0 } = {}) {
	let state = definition.init({ isSeeded: inheritedEventCount > 0 }, inheritedEventCount);
	for (const event of events) state = definition.apply(state, event);
	return state;
}

test('init starts at the normal level with a stable best-effort view', () => {
	const definition = projection();
	const state = definition.init({}, 0);
	assert.equal(definition.key, 'output-detail');
	assert.equal(definition.stateVersion, 2);
	assert.equal(state.level, DEFAULT_LEVEL);
	assert.equal(state.pendingCommandId, null);
	assert.equal(state.pendingLevel, null);
	const view = definition.wire.view(state);
	assert.deepEqual(view, { level: 3, mode: 'best-effort', promptVersion: 1 });
	assert.equal(definition.wire.view(state), view, 'unchanged level reuses the same view reference');
	assert.notEqual(definition.wire.view({ ...state, level: 4 }), view);
	assert.equal(definition.wire.view({ ...state, level: 4 }), definition.wire.view({ ...state, level: 4 }));
});

test('strict argument parsing accepts only one digit from 1 to 5', () => {
	for (const value of ['1', '5', ' 3 ', '\t4\n']) assert.equal(typeof parseLevelArgument(value), 'number');
	for (const value of ['', '  ', '0', '6', '-1', '3.0', '4x', '1 2', '+3', null, 3, undefined]) {
		assert.equal(parseLevelArgument(value), undefined, `rejects ${String(value)}`);
	}
});

test('a logged command/run + success command/done changes the level', () => {
	const definition = projection();
	const state = fold(definition, [run(0, 'cmd-1', ' 4'), done(1, 'cmd-1')]);
	assert.equal(state.level, 4);
	assert.equal(state.pendingCommandId, null);
	assert.equal(state.pendingLevel, null);
	assert.equal(definition.wire.view(state).level, 4);
});

test('read and invalid commands do not cancel an overlapping valid level change', () => {
  for (const [args, outcome] of [['', 'success'], ['bad', 'error']]) {
    const definition = projection();
    const state = fold(definition, [
      run(0, 'valid-set', '5'),
      run(1, 'non-setting-command', args),
      done(2, 'non-setting-command', outcome),
      done(3, 'valid-set'),
    ]);
    assert.equal(state.level, 5, `non-setting argument ${JSON.stringify(args)} must not supersede a pending set`);
  }
});

test('blank input is a read: the lifecycle is logged but the level is unchanged', () => {
	const definition = projection();
	const state = fold(definition, [run(0, 'cmd-1', ''), done(1, 'cmd-1')]);
	assert.equal(state.level, 3);
	assert.equal(state.pendingCommandId, null);
});

test('invalid or failed runs never change the level', () => {
	const definition = projection();
	for (const args of [' 9', ' 4x', ' 0']) {
		const state = fold(definition, [run(0, 'cmd-1', args), done(1, 'cmd-1')]);
		assert.equal(state.level, 3, `args ${JSON.stringify(args)}`);
	}
	const aborted = fold(definition, [run(0, 'cmd-1', ' 2'), done(1, 'cmd-1', 'error')]);
	assert.equal(aborted.level, 3);
	const failed = fold(definition, [run(0, 'cmd-1', ' 2'), done(1, 'cmd-1', 'success')]);
	assert.equal(failed.level, 2);
});

test('an older run completing after a newer run is stale and ignored', () => {
	const definition = projection();
	const stale = fold(definition, [
		run(0, 'cmd-a', ' 2'),
		run(1, 'cmd-b', ' 5'),
		done(2, 'cmd-a'),
	]);
	assert.equal(stale.level, 3, 'the newer run is still pending');
	assert.equal(stale.pendingCommandId, 'cmd-b');

	const settled = fold(definition, [
		run(0, 'cmd-a', ' 2'),
		run(1, 'cmd-b', ' 5'),
		done(2, 'cmd-a'),
		done(3, 'cmd-b'),
		done(4, 'cmd-a'),
	]);
	assert.equal(settled.level, 5);
});

test('command/done does not change the selection after its run was matched', () => {
	const definition = projection();
	const state = fold(definition, [
		run(0, 'cmd-a', ' 4'),
		done(1, 'cmd-a'),
		done(2, 'cmd-a'),
	]);
	assert.equal(state.level, 4);
});

test('events for other commands and non-user sources are ignored', () => {
	const definition = projection();
	const otherCommand = fold(definition, [
		{ type: 'command/run', seq: 0, time: 0, data: { commandId: 'c', name: 'goal', args: ' 2', source: { kind: 'user' } } },
		done(1, 'c'),
	]);
	assert.equal(otherCommand.level, 3);
	const nonUser = fold(definition, [
		{ type: 'command/run', seq: 0, time: 0, data: { commandId: 'c', name: 'output-detail', args: ' 2', source: { kind: 'model' } } },
		done(1, 'c'),
	]);
	assert.equal(nonUser.level, 3);
});

test('unrelated events keep the same state reference', () => {
	const definition = projection();
	const state = definition.init({}, 0);
	for (const type of ['turn/start', 'step/start', 'assistant/message', 'tool/result', 'session/end-seed']) {
		assert.equal(definition.apply(state, { type, seq: 0, time: 0, data: {} }), state, type);
	}
});

test('fork starts at normal and ignores inherited command updates', () => {
	const definition = projection();
	const state = fold(definition, [
		run(0, 'parent-cmd', ' 4'),
		done(1, 'parent-cmd'),
		run(2, 'child-cmd', ' 2'),
		done(3, 'child-cmd'),
	], { inheritedEventCount: 2 });
	assert.equal(state.level, 2, 'only the child command applies');
	assert.equal(state.inheritedEventCount, 2);
});

test('replay is deterministic and the state is structured-clone safe', () => {
	const events = [
		run(0, 'cmd-1', ' 4'),
		done(1, 'cmd-1'),
		message(2, 'm-1', [text('Plain question')]),
		message(3, 'm-2', [text('Another')]),
	];
	const first = fold(projection(), events);
	const second = fold(projection(), events);
	assert.deepEqual(first, second);
	assert.deepEqual(structuredClone(first), first);
	const viewA = projection();
	assert.deepEqual(viewA.wire.view(first), { level: 4, mode: 'best-effort', promptVersion: 1 });
});

test('a reset session folds back to the normal level', () => {
	const definition = projection();
	const completed = fold(definition, [run(0, 'c', ' 5'), done(1, 'c')]);
	assert.equal(completed.level, 5);
	assert.equal(definition.init({}, 0).level, 3);
});

test('real zod accepts the folded state and the wire view when available', async (t) => {
	let zod;
	if (process.env.DSH_RUNTIME_ROOT) {
		// Explicit, read-only use of an existing trusted DSH installation; no install or symlink.
		zod = createRequire(resolve(process.env.DSH_RUNTIME_ROOT, 'package.json'))('zod');
	} else {
		try {
			zod = await import('zod');
		} catch (error) {
			if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
			t.skip('zod is supplied by the host profile, not this bare source directory');
			return;
		}
	}
	const definition = createProjection(zod);
	const state = fold(definition, [
		run(0, 'cmd-1', ' 4'),
		done(1, 'cmd-1'),
		message(2, 'm-1', [text('Plain question')]),
	]);
	const parsed = definition.stateSchema.parse(state);
	assert.equal(parsed.level, 4);
	assert.equal(parsed.pendingCommandId, null);
	const view = definition.wire.viewSchema.parse(definition.wire.view(parsed));
	assert.deepEqual(view, { level: 4, mode: 'best-effort', promptVersion: 1 });
});
