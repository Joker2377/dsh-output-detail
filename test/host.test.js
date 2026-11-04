import test from 'node:test';
import assert from 'node:assert/strict';
import { applyHost } from '../lib/host.js';
import { appliedLevel, renderInstruction, CONTEXT_KIND } from '../lib/style.js';

test('tool input and output obey the real DSH JSON Schema subset', { skip: !process.env.DSH_RUNTIME_ROOT }, async () => {
	const { createRequire } = await import('node:module');
	const { resolve } = await import('node:path');
	const requireRuntime = createRequire(resolve(process.env.DSH_RUNTIME_ROOT, 'package.json'));
	const { assertSupportedJsonSchema } = requireRuntime('@deepseek-ai/dsh-tools');
	const h = createHarness().apply();
	try {
		const definition = h.tool('output_detail');
		assertSupportedJsonSchema(definition.output.schema);
		assertSupportedJsonSchema(definition.parameters);
		assert.deepEqual(definition.output.schema.properties.level.enum, [1, 2, 3, 4, 5]);
	} finally {
		h.dispose();
	}
});

const text = (value) => ({ type: 'text', text: value });
const human = (id, content, extra = {}) => ({
	id,
	role: 'user',
	source: { kind: 'user' },
	content,
	...extra,
});
const enter = (messages, extra = {}) => ({ kind: 'enter', messages, startsRequestSeries: true, ...extra });

/** Minimal zod-compatible surface: the host builds schemas but tests fold directly. */
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

function once(fn) {
	let called = false;
	return (...args) => {
		if (called) return undefined;
		called = true;
		return fn(...args);
	};
}

/**
 * A minimal but honest harness: the command bus really appends
 * command/run + command/done and the projection really folds every event.
 */
function createHarness({ withAgentsService = true, liveAgents = [] } = {}) {
	const rootListeners = new Map();
	const effects = [];
	const warnings = [];
	const commandDefs = new Map();
	const toolDefs = new Map();
	const sessions = new Map();
	const states = new Map();
	const agents = [...liveAgents];
	const scopes = new WeakMap();
	let projectionDef;
	let commandCounter = 0;
	/** Counts projection reads so a test can prove the subagent path never reads. */
	let projectionReads = 0;

	const context = {
		logger: {
			warn(message) {
				warnings.push(String(message));
			},
			info() {},
			error() {},
		},
		effect(fn) {
			const disposer = fn();
			effects.push(disposer);
			return disposer;
		},
		on(event, fn) {
			const listeners = rootListeners.get(event) ?? [];
			listeners.push(fn);
			rootListeners.set(event, listeners);
			return () => {
				const index = listeners.indexOf(fn);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		get(name) {
			return name === 'agents' && withAgentsService ? agentsService : undefined;
		},
		commands: {
			register(definition) {
				commandDefs.set(definition.name, definition);
				return () => commandDefs.delete(definition.name);
			},
			async execute(agent, line, attachments, signal) {
				const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line);
				if (match === null) return undefined;
				const nameCapture = match[1];
				const definition = commandDefs.get(nameCapture);
				if (definition === undefined) return undefined;
				const rawInput = line.slice(match[0].length);
				const commandId = `cmd-${++commandCounter}`;
				const session = agent.session;
				session.append('command/run', {
					commandId,
					name: nameCapture,
					...(definition.recordInput === false ? {} : { args: rawInput }),
					source: { kind: 'user' },
				});
				const invocation = { commandId, agent, rawInput, attachments: attachments ?? [], signal: signal ?? new AbortController().signal };
				let result;
				try {
					result = await definition.handler(invocation);
				} catch (error) {
					session.append('command/done', { commandId, kind: 'error', text: error instanceof Error ? error.message : String(error) });
					throw error;
				}
				session.append('command/done', {
					commandId,
					kind: result.kind,
					...(result.text === undefined ? {} : { text: result.text }),
				});
				return { commandId, result };
			},
		},
		tools: {
			register(definition) {
				toolDefs.set(definition.name, definition);
				return () => toolDefs.delete(definition.name);
			},
		},
		sessionProjections: {
			register(definition) {
				if (projectionDef !== undefined) throw new Error('duplicate projection registration');
				projectionDef = definition;
				return () => {
					if (projectionDef === definition) projectionDef = undefined;
				};
			},
			stateOf(session, key) {
				projectionReads += 1;
				if (projectionDef === undefined || key !== projectionDef.key) return undefined;
				let state = states.get(session.id);
				if (state === undefined) {
					state = projectionDef.init(session.header, session.inheritedEventCount);
					for (const event of session.events) state = projectionDef.apply(state, event);
					states.set(session.id, state);
				}
				return state;
			},
		},
	};

	const agentsService = {
		list: () => [...agents],
		get: (id) => agents.find((agent) => agent.id === id),
	};

	function project(session, event) {
		if (projectionDef === undefined) return;
		const state = states.get(session.id) ?? projectionDef.init(session.header, session.inheritedEventCount);
		states.set(session.id, projectionDef.apply(state, event));
	}

	function newSession(id, { inheritedEventCount = 0, header = {} } = {}) {
		const session = {
			id,
			inheritedEventCount,
			header: { version: 4, id, createdAt: 0, isSeeded: inheritedEventCount > 0, ...header },
			events: [],
			append(type, data) {
				const seq = session.events.length;
				const event = { type, seq, time: seq, data };
				session.events.push(event);
				project(session, event);
				return event;
			},
		};
		sessions.set(id, session);
		return session;
	}

	/** Push already-inherited fork events without driving the projection. */
	function seed(session, entries) {
		for (const [type, data] of entries) {
			const seq = session.events.length;
			session.events.push({ type, seq, time: seq, data });
		}
		session.inheritedEventCount = session.events.length;
		states.delete(session.id);
		return session;
	}

	function newAgent(session) {
		const scope = { preStep: [], effects: [] };
		const agent = {
			id: session.id,
			session,
			inbox: {
				replace() {
					throw new Error('inbox.replace must never be called by this plugin');
				},
				insert() {
					throw new Error('inbox.insert must never be called by this plugin');
				},
				remove() {
					throw new Error('inbox.remove must never be called by this plugin');
				},
			},
			ctx: {
				on(event, fn) {
					if (event !== 'agent/pre-step') throw new Error(`unexpected scoped event: ${event}`);
					scope.preStep.push(fn);
					return () => {
						const index = scope.preStep.indexOf(fn);
						if (index >= 0) scope.preStep.splice(index, 1);
					};
				},
				effect(fn) {
					let active = true;
					const disposer = fn();
					const wrapped = () => {
						if (!active) return;
						active = false;
						try {
							disposer?.();
						} finally {
							const index = scope.effects.indexOf(wrapped);
							if (index >= 0) scope.effects.splice(index, 1);
						}
					};
					scope.effects.push(wrapped);
					return wrapped;
				},
			},
			dispose() {
				for (const dispose of [...scope.effects]) dispose();
				scope.effects.length = 0;
			},
		};
		scopes.set(agent, scope);
		agents.push(agent);
		return agent;
	}

	function announce(agent) {
		for (const listener of [...(rootListeners.get('agent/created') ?? [])]) listener({ agent, source: 'startup' });
	}

	async function preStep(agent, messages, { signal, onNext, terminal } = {}) {
		const scope = scopes.get(agent);
		const chain = [...(rootListeners.get('agent/pre-step') ?? []), ...(scope?.preStep ?? [])];
		const payload = { agent, messages, turn: 1, step: 1, signal: signal ?? new AbortController().signal };
		let index = 0;
		const next = async () => {
			if (index >= chain.length) {
				if (onNext !== undefined) await onNext();
				return terminal ?? enter(messages);
			}
			const listener = chain[index++];
			return listener(payload, next);
		};
		return next();
	}

	/**
	 * Drive one agent's scoped listener with a payload naming another agent, as a
	 * mis-addressed event would: the listener must leave the batch untouched.
	 */
	function scopedPreStep(agent, payloadAgent, messages) {
		const listener = scopes.get(agent)?.preStep[0];
		assert.ok(listener, 'the agent must have a scoped pre-step listener');
		const payload = { agent: payloadAgent, messages, turn: 1, step: 1, signal: new AbortController().signal };
		return listener(payload, async () => enter(messages));
	}

	function execute(agent, line) {
		return context.commands.execute(agent, line, [], new AbortController().signal);
	}

	function runTool(agent, args) {
		const definition = toolDefs.get('output_detail');
		assert.ok(definition, 'output_detail must be registered');
		return definition.execute(args, {
			agent,
			signal: new AbortController().signal,
			callId: 'call-1',
			name: definition.name,
			arguments: args,
		});
	}

	function levelOfCommand(execution) {
		return JSON.parse(execution.result.text);
	}

	function dispose() {
		for (const disposer of [...effects]) {
			try {
				disposer?.();
			} catch (error) {
				warnings.push(`dispose failed: ${String(error)}`);
			}
		}
	}

	const harness = {
		ctx: context,
		newSession,
		seed,
		newAgent,
		announce,
		preStep,
		scopedPreStep,
		execute,
		runTool,
		levelOfCommand,
		dispose,
		reads: () => projectionReads,
		warnings,
		projection: () => projectionDef,
		tool: (name) => toolDefs.get(name),
		command: (name) => commandDefs.get(name),
		state(agent) {
			return context.sessionProjections.stateOf(agent.session, 'output-detail');
		},
		view(agent) {
			const definition = projectionDef;
			assert.ok(definition, 'projection must be registered');
			return definition.wire.view(harness.state(agent));
		},
		lifecycle(agent) {
			return agent.session.events.map((event) => ({
				type: event.type,
				name: event.data?.name,
				args: event.data?.args,
				kind: event.data?.kind,
			}));
		},
		apply(z = stubZ()) {
			applyHost(context, z);
			return harness;
		},
	};

	return harness;
}

/** The plugin's own non-human context messages, in batch order. */
function injected(decision) {
	if (decision.kind !== 'enter') return [];
	return decision.messages.filter(
		(message) => message.role === 'user' && message.source?.kind === CONTEXT_KIND,
	);
}

function contextFor(decision, targetId) {
	if (decision.kind !== 'enter') return undefined;
	return decision.messages.find(
		(message) => message.role === 'user'
			&& message.source?.kind === CONTEXT_KIND
			&& message.source.targetId === targetId,
	);
}

/** Level carried by the context message that targets `targetId`, or undefined. */
function contextLevel(decision, targetId) {
	const message = contextFor(decision, targetId);
	return message === undefined ? undefined : appliedLevel(message.content);
}

test('applyHost requires a context and the zod module', () => {
	assert.throws(() => applyHost(null, stubZ()), TypeError);
	assert.throws(() => applyHost({}, undefined), TypeError);
});

test('registrations use the shared style constants', () => {
	const harness = createHarness().apply();
	assert.equal(harness.projection().key, 'output-detail');
	assert.equal(harness.command('output-detail').name, 'output-detail');
	const tool = harness.tool('output_detail');
	assert.equal(tool.name, 'output_detail');
	assert.equal(tool.deferLoading, true);
	assert.match(tool.description, /explicitly asks/i);
	assert.deepEqual(Object.keys(tool.output.schema.properties).sort(), [
		'action', 'allowedLevels', 'changed', 'level', 'mode', 'plugin', 'previousLevel',
		'promptVersion', 'requestedLevel', 'status', 'version',
	]);
});

test('the command success text satisfies the client confirmation contract', async () => {
	const harness = createHarness().apply();
	const agent = harness.newAgent(harness.newSession('s-1'));
	harness.announce(agent);
	const execution = await harness.execute(agent, '/output-detail 4');
	// Mirrors client.js parseSuccessPayload.
	const payload = JSON.parse(execution.result.text);
	assert.equal(payload.plugin, 'dsh-output-detail');
	assert.equal(payload.mode, 'best-effort');
	assert.equal(payload.promptVersion, 1);
	assert.equal(payload.level, 4);
	assert.equal(payload.level === 4, true);
});

test('the command reports a JSON envelope and the logged lifecycle changes the projection', async () => {
	const harness = createHarness().apply();
	const agent = harness.newAgent(harness.newSession('s-1'));
	harness.announce(agent);

	const execution = await harness.execute(agent, '/output-detail 4');
	assert.equal(execution.result.kind, 'success');
	assert.deepEqual(harness.levelOfCommand(execution), {
		plugin: 'dsh-output-detail',
		version: 1,
		status: 'ok',
		mode: 'best-effort',
		promptVersion: 1,
		action: 'set',
		level: 4,
		previousLevel: 3,
		changed: true,
		allowedLevels: [1, 2, 3, 4, 5],
	});
	assert.deepEqual(harness.lifecycle(agent).map((entry) => entry.type), ['command/run', 'command/done']);
	assert.equal(harness.state(agent).level, 4);
	assert.deepEqual(harness.view(agent), { level: 4, mode: 'best-effort', promptVersion: 1 });
});

test('a blank command reads the current level without changing it', async () => {
	const harness = createHarness().apply();
	const agent = harness.newAgent(harness.newSession('s-1'));
	harness.announce(agent);
	await harness.execute(agent, '/output-detail 5');

	const read = await harness.execute(agent, '/output-detail');
	const body = harness.levelOfCommand(read);
	assert.equal(read.result.kind, 'success');
	assert.equal(body.action, 'read');
	assert.equal(body.mode, 'best-effort');
	assert.equal(body.promptVersion, 1);
	assert.equal(body.level, 5);
	assert.equal(body.previousLevel, 5);
	assert.equal(body.changed, false);
	assert.equal(harness.state(agent).level, 5);

	const whitespace = await harness.execute(agent, '/output-detail   ');
	assert.equal(harness.levelOfCommand(whitespace).level, 5);
	assert.equal(harness.levelOfCommand(whitespace).action, 'read');
});

test('invalid command input is an error and leaves the selection alone', async () => {
	const harness = createHarness().apply();
	const agent = harness.newAgent(harness.newSession('s-1'));
	harness.announce(agent);
	for (const line of ['/output-detail 9', '/output-detail 0', '/output-detail 4x', '/output-detail 1.5', '/output-detail -1', '/output-detail 1 2']) {
		const execution = await harness.execute(agent, line);
		assert.equal(execution.result.kind, 'error', line);
		const body = JSON.parse(execution.result.text);
		assert.equal(body.status, 'error');
		assert.equal(body.error, 'invalid-level');
		assert.equal(body.mode, 'best-effort');
		assert.equal(body.action, 'set');
		assert.equal(body.level, 3);
		assert.match(body.message, /1 to 5/);
		assert.equal(harness.state(agent).level, 3, line);
	}
	assert.deepEqual(
		harness.lifecycle(agent).filter((entry) => entry.type === 'command/done').map((entry) => entry.kind),
		Array(6).fill('error'),
	);
});

test('out-of-order command settlement keeps the newest run', async () => {
	const harness = createHarness().apply();
	const agent = harness.newAgent(harness.newSession('s-1'));
	harness.announce(agent);
	const session = agent.session;
	session.append('command/run', { commandId: 'cmd-a', name: 'output-detail', args: ' 2', source: { kind: 'user' } });
	session.append('command/run', { commandId: 'cmd-b', name: 'output-detail', args: ' 5', source: { kind: 'user' } });
	session.append('command/done', { commandId: 'cmd-a', kind: 'success' });
	assert.equal(harness.state(agent).level, 3, 'stale completion must not win');
	session.append('command/done', { commandId: 'cmd-b', kind: 'success' });
	assert.equal(harness.state(agent).level, 5);
	session.append('command/done', { commandId: 'cmd-a', kind: 'success' });
	assert.equal(harness.state(agent).level, 5);
});

test('auto mode adds the context only for human messages', async () => {
	const harness = createHarness().apply();
	const agent = harness.newAgent(harness.newSession('s-1'));
	harness.announce(agent);
	await harness.execute(agent, '/output-detail 4');

	const assistant = { ...human('a-1', [text('answer')]), role: 'assistant' };
	const modelSourced = human('m-2', [text('queued reminder')], { source: { kind: 'subagent' } });
	const question = human('m-1', [text('Question')]);
	const decision = await harness.preStep(agent, [assistant, modelSourced, question]);

	assert.equal(decision.messages.length, 4, 'one context message is added and nothing is duplicated');
	assert.equal(decision.messages[0], assistant);
	assert.equal(decision.messages[1], modelSourced);
	assert.equal(decision.messages[2], question);
	const context = decision.messages[3];
	assert.equal(context.role, 'user');
	assert.equal(context.source.kind, CONTEXT_KIND);
	assert.equal(context.source.kind === 'user', false, 'the context is not a human turn');
	assert.equal(context.source.form, 'notice');
	assert.equal(context.source.targetId, 'm-1');
	assert.equal(context.source.level, 4);
	assert.match(context.source.summary, /4\/5/);
	assert.equal(appliedLevel(context.content), 4);
	assert.equal(appliedLevel(assistant.content), undefined);
	assert.equal(appliedLevel(modelSourced.content), undefined);
	assert.equal(question.content.at(-1).text, 'Question');
	assert.equal(injected(decision).length, 1);
});

test('a batch with several human messages gets one context right after each', async () => {
	const harness = createHarness().apply();
	const agent = harness.newAgent(harness.newSession('s-1'));
	harness.announce(agent);
	await harness.execute(agent, '/output-detail 4');
	const one = human('m-1', [text('A')]);
	const two = human('m-2', [text('B')]);
	const decision = await harness.preStep(agent, [one, two]);
	assert.equal(decision.messages.length, 4);
	assert.equal(decision.messages[0], one);
	assert.equal(decision.messages[1].source.targetId, 'm-1');
	assert.equal(decision.messages[2], two);
	assert.equal(decision.messages[3].source.targetId, 'm-2');
	assert.equal(contextLevel(decision, 'm-1'), 4, 'the session level applies to every admitted message');
	assert.equal(contextLevel(decision, 'm-2'), 4);
	assert.equal(injected(decision).length, 2);
});

test('auto mode does not mutate the admitted batch, inbox, or decision fields', async () => {
	const harness = createHarness().apply();
	const agent = harness.newAgent(harness.newSession('s-1'));
	harness.announce(agent);
	const block = Object.freeze(text('Question'));
	const question = Object.freeze(human('m-1', Object.freeze([block])));
	const terminal = enter([question], { custom: Object.freeze({ downstream: true }) });
	const decision = await harness.preStep(agent, [question], { terminal });
	assert.equal(decision.startsRequestSeries, true);
	assert.equal(decision.custom, terminal.custom);
	assert.equal(decision.messages[0], question);
	assert.equal(decision.messages[0].source, question.source);
	assert.equal(decision.messages[0].content, question.content);
	assert.equal(decision.messages[0].content[0], block);
	assert.equal(question.content.length, 1);
	assert.equal(block.text, 'Question');
	assert.equal(decision.messages.length, 2);
	assert.equal(contextLevel(decision, 'm-1'), 3);
	assert.equal(decision.messages[1].content.at(-1).text, renderInstruction(3));
});

test('human attachments, source and extra fields survive the rewrite', async () => {
	const harness = createHarness().apply();
	const agent = harness.newAgent(harness.newSession('s-1'));
	harness.announce(agent);
	const image = { type: 'image', attachment: { attachmentId: 'im-1', bytes: 16 } };
	const file = { type: 'file', attachment: { attachmentId: 'file-1', name: 'data.csv' } };
	const source = Object.freeze({ kind: 'user', rpcId: 'rpc-1' });
	const question = Object.freeze(human('m-1', Object.freeze([image, text('Explain'), file]), {
		source,
		attachments: [{ attachmentId: 'file-1' }],
		createdAt: 42,
	}));
	const decision = await harness.preStep(agent, [question]);
	assert.equal(decision.messages[0], question);
	assert.equal(decision.messages[0].source, source);
	assert.deepEqual(decision.messages[0].content, [image, text('Explain'), file]);
	assert.equal(decision.messages[0].content[0], image);
	assert.equal(decision.messages[0].content[2], file);
	assert.equal(decision.messages[0].createdAt, 42);
	assert.equal(decision.messages[0].attachments, question.attachments);
	assert.equal(question.content.length, 3);
	assert.equal(contextLevel(decision, 'm-1'), 3);
});

test('auto mode snapshots the selection before awaiting the downstream chain', async () => {
	const harness = createHarness().apply();
	const agent = harness.newAgent(harness.newSession('s-1'));
	harness.announce(agent);
	await harness.execute(agent, '/output-detail 4');
	const decision = await harness.preStep(agent, [human('m-1', [text('Question')])], {
		onNext: async () => {
			// A concurrent change landed while this step was awaiting downstream
			// listeners: this step must still use the level it read first.
			await harness.execute(agent, '/output-detail 2');
		},
	});
	assert.equal(contextLevel(decision, 'm-1'), 4);
	assert.equal(harness.state(agent).level, 2);
});

test('reject, abort, and rejected downstream decisions pass through untouched', async () => {
	const harness = createHarness().apply();
	const agent = harness.newAgent(harness.newSession('s-1'));
	harness.announce(agent);
	const rejected = { kind: 'reject' };
	assert.equal(await harness.preStep(agent, [human('m-1', [text('Q')])], { terminal: rejected }), rejected);

	const controller = new AbortController();
	controller.abort();
	const abortedDecision = enter([human('m-1', [text('Q')])]);
	const aborted = await harness.preStep(agent, [human('m-1', [text('Q')])], {
		signal: controller.signal,
		terminal: abortedDecision,
	});
	assert.equal(aborted, abortedDecision);
});

test('the tool gets without changing the selection and renders JSON text', async () => {
	const harness = createHarness().apply();
	const agent = harness.newAgent(harness.newSession('s-1'));
	harness.announce(agent);
	await harness.execute(agent, '/output-detail 4');
	const before = agent.session.events.length;
	const value = await harness.runTool(agent, { action: 'get' });
	assert.deepEqual(value, {
		plugin: 'dsh-output-detail',
		version: 1,
		status: 'ok',
		mode: 'best-effort',
		promptVersion: 1,
		action: 'get',
		level: 4,
		previousLevel: 4,
		changed: false,
		allowedLevels: [1, 2, 3, 4, 5],
	});
	assert.equal(agent.session.events.length, before, 'get is pure');
	assert.deepEqual(harness.tool('output_detail').output.render({}, value), [{ type: 'text', text: JSON.stringify(value) }]);
});

test('the tool set path is exactly the command path', async () => {
	const harness = createHarness().apply();
	const viaTool = harness.newAgent(harness.newSession('s-tool'));
	harness.announce(viaTool);
	const viaCommand = harness.newAgent(harness.newSession('s-command'));
	harness.announce(viaCommand);

	const value = await harness.runTool(viaTool, { action: 'set', level: 4 });
	assert.equal(value.action, 'set');
	assert.equal(value.mode, 'best-effort');
	assert.equal(value.promptVersion, 1);
	assert.equal(value.status, 'ok');
	assert.equal(value.level, 4);
	assert.equal(value.changed, true);
	assert.equal(value.requestedLevel, 4);

	await harness.execute(viaCommand, '/output-detail 4');
	assert.deepEqual(harness.lifecycle(viaTool), harness.lifecycle(viaCommand));
	assert.equal(harness.state(viaTool).level, 4);
});

test('the tool rejects invalid arguments and command failures', async () => {
	const harness = createHarness().apply();
	const agent = harness.newAgent(harness.newSession('s-1'));
	harness.announce(agent);
	const tool = harness.tool('output_detail');
	await assert.rejects(() => harness.runTool(agent, { action: 'set', level: 9 }), /1 to 5/);
	await assert.rejects(() => harness.runTool(agent, { action: 'set' }), /requires an integer/);
	await assert.rejects(() => harness.runTool(agent, { action: 'reset' }), /must be "get" or "set"/);
	await assert.rejects(
		() => tool.execute({ action: 'get' }, { signal: new AbortController().signal }),
		/no agent/,
	);
	const failed = harness.command('output-detail');
	failed.handler = () => ({ kind: 'error', text: 'boom' });
	await assert.rejects(() => harness.runTool(agent, { action: 'set', level: 3 }), /boom/);
});

test('an agent that already exists at mount time is covered without agent/created', async () => {
	const harness = createHarness();
	const agent = harness.newAgent(harness.newSession('s-1'));
	harness.apply();
	const decision = await harness.preStep(agent, [human('m-1', [text('Question')])]);
	assert.equal(contextLevel(decision, 'm-1'), 3);
	await harness.execute(agent, '/output-detail 5');
	const next = await harness.preStep(agent, [human('m-2', [text('Next')])]);
	assert.equal(contextLevel(next, 'm-2'), 5);
});

test('an agent created after mount is attached through agent/created', async () => {
	const harness = createHarness().apply();
	const agent = harness.newAgent(harness.newSession('s-1'));
	harness.announce(agent);
	await harness.execute(agent, '/output-detail 2');
	const decision = await harness.preStep(agent, [human('m-1', [text('Question')])]);
	assert.equal(contextLevel(decision, 'm-1'), 2);
});

test('without the agents service one plugin-owned global listener still covers every agent', async () => {
	const harness = createHarness({ withAgentsService: false }).apply();
	const agent = harness.newAgent(harness.newSession('s-1'));
	// No announce is needed: the fallback listener is global.
	await harness.execute(agent, '/output-detail 2');
	const decision = await harness.preStep(agent, [human('m-1', [text('Question')])]);
	assert.equal(contextLevel(decision, 'm-1'), 2);
	harness.dispose();
	const after = await harness.preStep(agent, [human('m-2', [text('Next')])]);
	assert.equal(injected(after).length, 0);
	assert.equal(after.messages.length, 1);
	assert.equal(after.messages[0].content[0].text, 'Next');
});

test('an agent whose scope cannot host a listener is covered by the fallback', async () => {
	const harness = createHarness();
	const agent = harness.newAgent(harness.newSession('s-1'));
	agent.ctx = undefined;
	harness.apply();
	await harness.execute(agent, '/output-detail 4');
	const decision = await harness.preStep(agent, [human('m-1', [text('Question')])]);
	assert.equal(contextLevel(decision, 'm-1'), 4);
});

test('plugin-first disposal stops rewriting and agent-first disposal is harmless', async () => {
	const harness = createHarness().apply();
	const agent = harness.newAgent(harness.newSession('s-1'));
	harness.announce(agent);
	await harness.execute(agent, '/output-detail 4');
	const before = await harness.preStep(agent, [human('m-1', [text('Q')])]);
	assert.equal(contextLevel(before, 'm-1'), 4);
	harness.dispose();
	const after = await harness.preStep(agent, [human('m-2', [text('Q')])]);
	assert.equal(injected(after).length, 0, 'disposal adds no context');
	assert.equal(after.messages.length, 1);
	agent.dispose();
	assert.deepEqual(harness.warnings, []);
});

test('disposing one agent leaves another agent rewriting', async () => {
	const harness = createHarness().apply();
	const first = harness.newAgent(harness.newSession('s-1'));
	const second = harness.newAgent(harness.newSession('s-2'));
	harness.announce(first);
	harness.announce(second);
	await harness.execute(second, '/output-detail 5');
	first.dispose();
	harness.dispose();
	assert.deepEqual(harness.warnings, []);

	const isolated = createHarness().apply();
	const alive = isolated.newAgent(isolated.newSession('s-3'));
	const dead = isolated.newAgent(isolated.newSession('s-4'));
	isolated.announce(alive);
	isolated.announce(dead);
	await isolated.execute(alive, '/output-detail 2');
	dead.dispose();
	const decision = await isolated.preStep(alive, [human('m-1', [text('Q')])]);
	assert.equal(contextLevel(decision, 'm-1'), 2);
	assert.deepEqual(isolated.warnings, []);
});

test('fork keeps the child level normal and does not replay the parent command', async () => {
	const harness = createHarness().apply();
	const child = harness.newSession('s-fork');
	harness.seed(child, [
		['command/run', { commandId: 'cmd-parent', name: 'output-detail', args: ' 5', source: { kind: 'user' } }],
		['command/done', { commandId: 'cmd-parent', kind: 'success' }],
		['user/message', human('m-parent', [text('Old question')])],
	]);
	const agent = harness.newAgent(child);
	harness.announce(agent);
	assert.equal(child.inheritedEventCount, 3);
	assert.equal(harness.state(agent).level, 3, 'the parent command is inherited, not replayed');
	const decision = await harness.preStep(agent, [human('m-parent', [text('Old question')])]);
	assert.equal(contextLevel(decision, 'm-parent'), 3, 'the child session level applies');
	assert.equal(decision.messages[0].content[0].text, 'Old question');
});

test('sessions are isolated and a new session starts at normal', async () => {
	const harness = createHarness().apply();
	const one = harness.newAgent(harness.newSession('s-1'));
	const two = harness.newAgent(harness.newSession('s-2'));
	harness.announce(one);
	harness.announce(two);
	await harness.execute(one, '/output-detail 5');
	assert.equal(harness.state(one).level, 5);
	assert.equal(harness.state(two).level, 3);
	const decision = await harness.preStep(two, [human('m-1', [text('Q')])]);
	assert.equal(contextLevel(decision, 'm-1'), 3);
});

test('the injected instruction is the style module instruction, not a second policy', async () => {
	const harness = createHarness().apply();
	const agent = harness.newAgent(harness.newSession('s-1'));
	harness.announce(agent);
	await harness.execute(agent, '/output-detail 1');
	const question = human('m-1', [text('Q')]);
	const decision = await harness.preStep(agent, [question]);
	assert.equal(decision.messages[1].content.at(-1).text, renderInstruction(1));
	assert.equal(decision.messages[1].source.kind, CONTEXT_KIND);
	assert.equal(decision.messages[0], question);
	assert.deepEqual(decision.messages[0].content, [text('Q')]);
	assert.equal(appliedLevel(decision.messages[0].content), undefined);
});

test('a delegated subagent passes through untouched, including its source-user task', async () => {
	const harness = createHarness().apply();
	const agent = harness.newAgent(harness.newSession('s-sub', {
		header: { parentSession: 's-parent', origin: 'subagent', delegationDepth: 1 },
	}));
	harness.announce(agent);
	await harness.execute(agent, '/output-detail 5');
	const task = human('m-task', [text('Do the delegated work')]);
	const terminal = enter([task]);
	const readsBefore = harness.reads();
	const decision = await harness.preStep(agent, [task], { terminal });
	assert.equal(decision, terminal, 'the decision object is passed through as-is');
	assert.equal(decision.messages.length, 1);
	assert.equal(decision.messages[0], task);
	assert.equal(decision.messages[0].source.kind, 'user');
	assert.equal(appliedLevel(task.content), undefined);
	assert.equal(injected(decision).length, 0);
	assert.equal(harness.reads(), readsBefore, 'the projection is never read for a subagent');
});

test('a plain fork keeps parentSession without the subagent origin and is still styled', async () => {
	const harness = createHarness().apply();
	const agent = harness.newAgent(harness.newSession('s-fork', { header: { parentSession: 's-parent' } }));
	harness.announce(agent);
	assert.equal(agent.session.header.origin, undefined);
	const question = human('m-1', [text('Continue here')]);
	const decision = await harness.preStep(agent, [question]);
	assert.equal(contextLevel(decision, 'm-1'), 3, 'only origin === "subagent" is excluded');
	assert.equal(injected(decision).length, 1);
	assert.equal(decision.messages[0], question);
});

test('a scoped listener leaves a payload addressed to another agent untouched', async () => {
	const harness = createHarness().apply();
	const first = harness.newAgent(harness.newSession('s-1'));
	const second = harness.newAgent(harness.newSession('s-2'));
	harness.announce(first);
	harness.announce(second);
	await harness.execute(first, '/output-detail 5');
	const question = human('m-1', [text('Q')]);
	const decision = await harness.scopedPreStep(first, second, [question]);
	assert.equal(decision.messages.length, 1);
	assert.equal(decision.messages[0], question);
	assert.equal(injected(decision).length, 0);
});

test('re-running the pre-step on an already-injected batch is idempotent', async () => {
	const harness = createHarness().apply();
	const agent = harness.newAgent(harness.newSession('s-1'));
	harness.announce(agent);
	await harness.execute(agent, '/output-detail 4');
	const question = human('m-1', [text('Q')]);
	const first = await harness.preStep(agent, [question]);
	const second = await harness.preStep(agent, first.messages);
	assert.equal(second.messages, first.messages, 'the covered batch is returned unchanged');
	assert.equal(injected(second).length, 1);
	assert.equal(contextLevel(second, 'm-1'), 4);
	// A retry after persistence sees a JSON copy of the batch.
	const replay = JSON.parse(JSON.stringify(first.messages));
	const third = await harness.preStep(agent, replay);
	assert.equal(injected(third).length, 1);
	assert.equal(contextLevel(third, 'm-1'), 4);
});
