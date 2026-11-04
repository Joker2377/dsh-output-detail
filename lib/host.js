/**
 * Host half of dsh-output-detail: the projection registration, the human
 * command, the deferred agent tool, and the per-agent best-effort pre-step
 * injection.
 *
 * There is no mutable selection store here. `/output-detail N` only validates
 * and reports; the projection drives the actual selection from the command
 * lifecycle the executor already logs. The tool performs a change by calling
 * the same command operation, so both entry points share one code path.
 *
 * @module dsh-output-detail/host
 */
import {
	DEFAULT_LEVEL,
	PROJECTION_KEY,
	PROMPT_VERSION,
	COMMAND_NAME,
	TOOL_NAME,
	LEVELS,
	isLevel,
	rewriteDecision,
} from './style.js';
import { createProjection, parseLevelArgument } from './projection.js';

const PLUGIN_NAME = 'dsh-output-detail';
/** Envelope version for the JSON text of the command and the tool value. */
const RESULT_VERSION = 1;
/** Wire mode shared with the projection view and the client's reply check. */
const VIEW_MODE = 'best-effort';
const ALLOWED_LEVELS = Object.freeze(LEVELS.map(({ level }) => level));
/** Cap on untrusted input echoed back in an error message. */
const MAX_INPUT_ECHO = 40;

/**
 * Run `fn` at most once and return its first result.
 * Every cleanup path is idempotent because Cordis and our own returned
 * disposer can both reach it.
 */
function once(fn) {
	let called = false;
	return (...args) => {
		if (called) return undefined;
		called = true;
		return fn(...args);
	};
}

/** De-duplicated, never-throwing diagnostics sink. */
function createReporter(ctx) {
	const seen = new Set();
	return (message, error) => {
		const detail = error === undefined
			? ''
			: `: ${error instanceof Error ? error.message : String(error)}`;
		const key = `${message}${detail}`;
		if (seen.has(key)) return;
		seen.add(key);
		try {
			ctx?.logger?.warn?.(`${PLUGIN_NAME}: ${message}${detail}`);
		} catch {
			/* diagnostics must never break the step */
		}
	};
}

/** Optional service lookup that tolerates an already-disposed context. */
function serviceOf(ctx, name) {
	if (ctx === null || typeof ctx !== 'object') return undefined;
	try {
		if (typeof ctx.get === 'function') {
			const service = ctx.get(name);
			if (service !== undefined) return service;
		}
	} catch {
		/* absent optional service */
	}
	try {
		return ctx[name];
	} catch {
		return undefined;
	}
}

/** Current selection from the projection; normal level when unavailable. */
function readState(ctx, session, report) {
	if (session === null || typeof session !== 'object') return undefined;
	const projections = ctx?.sessionProjections;
	if (projections === null || typeof projections !== 'object' || typeof projections.stateOf !== 'function') return undefined;
	try {
		return projections.stateOf(session, PROJECTION_KEY) ?? undefined;
	} catch (error) {
		report('reading the projection failed', error);
		return undefined;
	}
}

function currentLevel(ctx, agent, report) {
	const state = readState(ctx, agent?.session, report);
	return state !== undefined && isLevel(state.level) ? state.level : DEFAULT_LEVEL;
}

/**
 * The settled reply shape the composer control verifies: the client requires
 * `plugin`, `mode: 'best-effort'`, `promptVersion` and the confirmed `level`,
 * exactly like the projection view. `action` and the extra fields are additive.
 */
function resultEnvelope({ action, level, previousLevel, changed, requestedLevel }) {
	return {
		plugin: PLUGIN_NAME,
		version: RESULT_VERSION,
		status: 'ok',
		mode: VIEW_MODE,
		promptVersion: PROMPT_VERSION,
		action,
		level,
		previousLevel,
		changed,
		allowedLevels: ALLOWED_LEVELS,
		...(requestedLevel === undefined ? {} : { requestedLevel }),
	};
}

function errorEnvelope({ level, code, message }) {
	return {
		plugin: PLUGIN_NAME,
		version: RESULT_VERSION,
		status: 'error',
		mode: VIEW_MODE,
		promptVersion: PROMPT_VERSION,
		action: 'set',
		level,
		previousLevel: level,
		changed: false,
		allowedLevels: ALLOWED_LEVELS,
		error: code,
		message,
	};
}

/** @param {unknown} rawInput trailing text of `/output-detail ...` */
function parseCommandInput(rawInput) {
	if (typeof rawInput !== 'string') return { kind: 'invalid', echo: '<non-text input>' };
	const text = rawInput.trim();
	if (text === '') return { kind: 'read' };
	const level = parseLevelArgument(text);
	if (level === undefined) return { kind: 'invalid', echo: text.slice(0, MAX_INPUT_ECHO) };
	return { kind: 'set', level };
}

/** The human command. It validates and reports; it never stores a selection. */
function createCommand(ctx, report) {
	return {
		name: COMMAND_NAME,
		description: 'Set or read how detailed replies are (1-5). Blank input reads the current level.',
		input: { hint: '1-5 (blank reads)' },
		handler(invocation) {
			const current = currentLevel(ctx, invocation?.agent, report);
			const parsed = parseCommandInput(invocation?.rawInput);
			if (parsed.kind === 'invalid') {
				return {
					kind: 'error',
					text: JSON.stringify(errorEnvelope({
						level: current,
						code: 'invalid-level',
						message: `Detail level must be a whole number from 1 to 5; received "${parsed.echo}". `
							+ 'Leave the command blank to read the current level.',
					})),
				};
			}
			if (parsed.kind === 'read') {
				return {
					kind: 'success',
					text: JSON.stringify(resultEnvelope({
						action: 'read',
						level: current,
						previousLevel: current,
						changed: false,
					})),
				};
			}
			return {
				kind: 'success',
				text: JSON.stringify(resultEnvelope({
					action: 'set',
					level: parsed.level,
					previousLevel: current,
					changed: parsed.level !== current,
				})),
			};
		},
	};
}

/** Best-effort human-readable failure from the command's own JSON error text. */
function explainCommandError(text) {
	if (typeof text !== 'string') return 'output_detail: the detail command failed.';
	try {
		const parsed = JSON.parse(text);
		if (parsed !== null && typeof parsed === 'object' && typeof parsed.message === 'string') return parsed.message;
	} catch {
		/* not our envelope */
	}
	return text;
}

const OUTPUT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['plugin', 'version', 'status', 'mode', 'promptVersion', 'action', 'level', 'previousLevel', 'changed', 'allowedLevels'],
	properties: {
		plugin: { type: 'string', description: 'Stable plugin id.' },
		version: { type: 'integer', description: 'Result envelope version.' },
		status: { type: 'string', enum: ['ok'], description: 'Errors are reported as tool errors instead.' },
		mode: { type: 'string', enum: [VIEW_MODE], description: 'Wire mode, shared with the projection view.' },
		promptVersion: { type: 'integer', description: 'Instruction prompt version in effect.' },
		action: { type: 'string', enum: ['get', 'set', 'read'], description: 'Whether the call read or changed the level.' },
		level: { type: 'integer', enum: [1, 2, 3, 4, 5], description: 'Selection now in effect.' },
		previousLevel: { type: 'integer', enum: [1, 2, 3, 4, 5], description: 'Selection before the call.' },
		changed: { type: 'boolean', description: 'Whether the selection changed.' },
		allowedLevels: { type: 'array', items: { type: 'integer', enum: [1, 2, 3, 4, 5] } },
		requestedLevel: { type: 'integer', enum: [1, 2, 3, 4, 5] },
	},
};

/** Deferred tool: read freely, change only on an explicit user request. */
function createTool(ctx, report) {
	return {
		name: TOOL_NAME,
		description: 'Read or set the response detail level (1-5) for this session. '
			+ 'Call action "set" only when the user explicitly asks to change how detailed replies are; '
			+ 'never pick a level on your own. action "get" only reads and never changes the selection.',
		deferLoading: true,
		parameters: {
			type: 'object',
			additionalProperties: false,
			required: ['action'],
			properties: {
				action: {
					type: 'string',
					enum: ['get', 'set'],
					description: 'get reads the current level; set applies an explicit user-requested level.',
				},
				level: {
					type: 'integer',
					enum: [1, 2, 3, 4, 5],
					description: 'Required for set: the requested response detail level.',
				},
			},
		},
		output: {
			schema: OUTPUT_SCHEMA,
			render(_args, value) {
				return [{ type: 'text', text: JSON.stringify(value ?? null) }];
			},
		},
		async execute(args, exec) {
			const agent = exec?.agent;
			if (agent === undefined || agent === null) throw new Error('output_detail: no agent in the tool execution context.');
			const action = args !== null && typeof args === 'object' ? args.action : undefined;
			if (action === 'get') {
				const level = currentLevel(ctx, agent, report);
				return resultEnvelope({ action: 'get', level, previousLevel: level, changed: false });
			}
			if (action !== 'set') throw new Error('output_detail: action must be "get" or "set".');
			const requested = args?.level;
			if (!isLevel(requested)) throw new Error('output_detail: set requires an integer level from 1 to 5.');
			const previous = currentLevel(ctx, agent, report);
			// Parity: the tool performs the change by running the very same command,
			// so the durable command/run + command/done lifecycle is the only path.
			const execution = await ctx.commands.execute(agent, `/${COMMAND_NAME} ${requested}`, [], exec.signal);
			if (execution === undefined) throw new Error(`output_detail: /${COMMAND_NAME} is not available for this agent.`);
			if (execution.result?.kind === 'error') throw new Error(explainCommandError(execution.result.text));
			const level = currentLevel(ctx, agent, report);
			return resultEnvelope({
				action: 'set',
				level,
				previousLevel: previous,
				changed: level !== previous,
				requestedLevel: requested,
			});
		},
	};
}

/**
 * A delegated subagent's session records `origin: 'subagent'`; a fork shares
 * `parentSession` but keeps the origin unset and is an independent
 * conversation. The subagent's initial task is queued as an ordinary
 * `source.kind: 'user'` message (`dsh-subagent`: submitMaterialized), so
 * without this guard a preference would style a task the user never wrote.
 */
function isSubagentSession(agent) {
	const header = agent?.session?.header;
	return header !== null && typeof header === 'object' && header.origin === 'subagent';
}

/**
 * Best-effort auto mode for one agent: read the selection once, before the
 * downstream chain runs, then rewrite the admitted batch with that level.
 */
function makePreStep(ctx, fixedAgent, report) {
	return async (payload, next) => {
		// A scoped listener only serves the agent it was attached to; a payload
		// addressed elsewhere belongs to that agent's listener (or the fallback).
		if (fixedAgent !== undefined && payload?.agent !== undefined && payload.agent !== fixedAgent) return next();
		const agent = fixedAgent ?? (payload !== null && typeof payload === 'object' ? payload.agent : undefined);
		// Pass through before reading the projection: a subagent must not be
		// styled, and must not pay for a state read it can never use.
		if (isSubagentSession(agent)) return next();
		// Deliberately a pre-step snapshot, not a Send-time snapshot: the UI's
		// Send value is not observable, and this read is what the step will use.
		const state = readState(ctx, agent?.session, report);
		const snapshot = {
			level: state !== undefined && isLevel(state.level) ? state.level : DEFAULT_LEVEL,
		};
		const decision = await next();
		if (decision === null || typeof decision !== 'object' || decision.kind !== 'enter') return decision;
		if (payload?.signal?.aborted === true) return decision;
		try {
			return rewriteDecision(decision, snapshot);
		} catch (error) {
			report('pre-step rewrite failed', error);
			return decision;
		}
	};
}

function isAgentLike(agent) {
	return agent !== null && typeof agent === 'object' && typeof agent.id === 'string';
}

/**
 * Attach the pre-step listener to each live agent's scope so it is disposed
 * with that agent, discover already-active agents through `ctx.agents`, and
 * keep a plugin-owned disposer for unload. If a scope cannot host a listener
 * (or the agents service is absent), one idempotent plugin-owned global
 * listener covers the miss instead of silently skipping the agent.
 */
function installPreStep(ctx, report) {
	const attached = new Map();
	let offGlobal = null;
	let offCreated = null;
	let closed = false;
	const globalListener = makePreStep(ctx, undefined, report);

	const ensureGlobal = () => {
		if (closed || offGlobal !== null) return;
		offGlobal = ctx.on('agent/pre-step', globalListener);
	};

	const attach = (agent) => {
		if (closed || !isAgentLike(agent)) return false;
		if (attached.has(agent.id)) return true;
		const scope = agent.ctx;
		if (scope === null || typeof scope !== 'object' || typeof scope.on !== 'function') return false;
		const listener = makePreStep(ctx, agent, report);
		let effectDisposer;
		try {
			if (typeof scope.effect === 'function') {
				effectDisposer = scope.effect(() => {
					const off = scope.on('agent/pre-step', listener);
					return () => {
						try {
							off();
						} catch (error) {
							report(`removing the pre-step listener for agent "${agent.id}" failed`, error);
						}
						attached.delete(agent.id);
					};
				}, `${PLUGIN_NAME}: pre-step`);
			} else {
				const off = scope.on('agent/pre-step', listener);
				effectDisposer = () => off();
			}
		} catch (error) {
			report(`attaching to agent "${agent.id}" failed`, error);
			return false;
		}
		attached.set(agent.id, once(() => {
			attached.delete(agent.id);
			try {
				effectDisposer?.();
			} catch (error) {
				report(`disposing the pre-step listener for agent "${agent.id}" failed`, error);
			}
		}));
		return true;
	};

	const agents = serviceOf(ctx, 'agents');
	if (agents !== null && typeof agents === 'object' && typeof agents.list === 'function') {
		offCreated = ctx.on('agent/created', (payload) => {
			if (!attach(payload?.agent)) ensureGlobal();
		});
		let live = [];
		try {
			live = agents.list();
		} catch (error) {
			report('listing live agents failed', error);
		}
		for (const agent of Array.isArray(live) ? live : []) {
			if (!attach(agent)) ensureGlobal();
		}
	} else {
		ensureGlobal();
	}

	return once(() => {
		closed = true;
		try {
			offCreated?.();
		} catch (error) {
			report('removing the agent/created listener failed', error);
		}
		try {
			offGlobal?.();
		} catch (error) {
			report('removing the global pre-step listener failed', error);
		}
		for (const dispose of [...attached.values()]) dispose();
		attached.clear();
	});
}

/**
 * Register the whole host half. Registration rides the calling fiber; the
 * returned disposer is idempotent and may be called before or after an owning
 * agent's own disposal.
 *
 * @param {object} ctx plugin context
 * @param {typeof import('zod')} z the real zod module (schemas are built here)
 */
export function applyHost(ctx, z) {
	if (ctx === null || typeof ctx !== 'object') throw new TypeError('dsh-output-detail: a plugin context is required');
	if (z === null || typeof z !== 'object') throw new TypeError('dsh-output-detail: the zod module is required');
	const report = createReporter(ctx);
	const projection = ctx.effect(() => ctx.sessionProjections.register(createProjection(z)), `${PLUGIN_NAME}: projection`);
	const command = ctx.effect(() => ctx.commands.register(createCommand(ctx, report)), `${PLUGIN_NAME}: command`);
	const tool = ctx.effect(() => ctx.tools.register(createTool(ctx, report)), `${PLUGIN_NAME}: tool`);
	const preStep = installPreStep(ctx, report);
	const dispose = once(() => {
		preStep();
		for (const item of [tool, command, projection]) {
			try {
				item?.();
			} catch (error) {
				report('plugin cleanup failed', error);
			}
		}
	});
	try {
		ctx.effect(() => dispose, `${PLUGIN_NAME}: lifetime`);
	} catch (error) {
		report('registering the lifetime cleanup failed', error);
	}
	return dispose;
}
