/**
 * Durable, log-folded selection state for the response-detail control.
 *
 * The projection is the only owner of the selected level. A level change is
 * never stored in a side table and never mirrored by the client: it is derived
 * by folding the ordinary `command/run` + `command/done` lifecycle that the
 * command executor already writes, so replay, restore and fork all reproduce
 * the same selection from the Session log alone.
 *
 * Plain JSON state, stable references for unrelated events, no Session event
 * type of its own.
 *
 * @module dsh-output-detail/projection
 */
import {
	DEFAULT_LEVEL,
	PROJECTION_KEY,
	PROMPT_VERSION,
	COMMAND_NAME,
	isLevel,
} from './style.js';

/** Bump together with a state-shape change that needs a full refold. */
const STATE_VERSION = 2;
/** Wire view mode: selection is best-effort, never an authorization boundary. */
const VIEW_MODE = 'best-effort';

/**
 * Strict command argument: one digit from 1 to 5 after trimming.
 * Blank input is a read, not a change.
 *
 * @param {unknown} value logged `command/run.args`
 * @returns {number | undefined} the requested level, or undefined for read/invalid
 */
export function parseLevelArgument(value) {
	if (typeof value !== 'string') return undefined;
	const text = value.trim();
	if (!/^[1-5]$/u.test(text)) return undefined;
	const level = Number(text);
	return isLevel(level) ? level : undefined;
}

/** Local level command run for this exact Session, never one inherited by a fork. */
function applyRun(state, event) {
	const data = event.data;
	if (data === null || typeof data !== 'object') return state;
	if (data.name !== COMMAND_NAME || data.source?.kind !== 'user') return state;
	if (typeof data.commandId !== 'string') return state;
	if (event.seq < state.inheritedEventCount) return state;
	const level = parseLevelArgument(data.args);
	// Read/invalid commands are not a newer selection and must not cancel a pending set.
	if (level === undefined) return state;
	return { ...state, pendingCommandId: data.commandId, pendingLevel: level };
}

/**
 * Settle only the newest run. An older command completing after a newer run is
 * stale: its `command/done` no longer matches the pending id and is ignored.
 */
function applyDone(state, event) {
	const data = event.data;
	if (data === null || typeof data !== 'object') return state;
	if (state.pendingCommandId === null || data.commandId !== state.pendingCommandId) return state;
	const settledLevel = data.kind === 'success' && isLevel(state.pendingLevel) ? state.pendingLevel : null;
	return {
		...state,
		level: settledLevel ?? state.level,
		pendingCommandId: null,
		pendingLevel: null,
	};
}

/**
 * Apply one committed Session event. Every unrelated event returns the same
 * state reference so the projection drive never recomputes an unchanged view.
 *
 * @param {object} state
 * @param {{type: string, seq: number, data: unknown}} event
 */
function apply(state, event) {
	if (event === null || typeof event !== 'object') return state;
	switch (event.type) {
		case 'command/run':
			return applyRun(state, event);
		case 'command/done':
			return applyDone(state, event);
		default:
			return state;
	}
}

/**
 * Build the Session projection unit for one registration.
 *
 * @param {typeof import('zod')} z the caller's real zod module
 */
export function createProjection(z) {
	if (z === null || typeof z !== 'object') {
		throw new TypeError('dsh-output-detail: createProjection(z) needs the zod module');
	}
	const levelSchema = z.number().int().min(1).max(5);
	const stateSchema = z.object({
		level: levelSchema,
		pendingCommandId: z.string().nullable(),
		pendingLevel: levelSchema.nullable(),
		inheritedEventCount: z.number().int().min(0),
	});
	const viewSchema = z.object({
		level: levelSchema,
		mode: z.literal(VIEW_MODE),
		promptVersion: z.literal(PROMPT_VERSION),
	});
	/** One frozen view per level: unchanged selections keep the same reference. */
	const views = new Map();

	return {
		key: PROJECTION_KEY,
		stateVersion: STATE_VERSION,
		stateSchema,
		/**
		 * A new Session starts at the normal level, whatever its parent selected.
		 * The inherited prefix is retained but never re-applies a parent command.
		 */
		init(header, inheritedEventCount) {
			const inherited = Number.isSafeInteger(inheritedEventCount) && inheritedEventCount >= 0
				? inheritedEventCount
				: 0;
			return {
				level: DEFAULT_LEVEL,
				pendingCommandId: null,
				pendingLevel: null,
				inheritedEventCount: inherited,
			};
		},
		apply,
		wire: {
			viewSchema,
			view(state) {
				let view = views.get(state.level);
				if (view === undefined) {
					view = Object.freeze({
						level: state.level,
						mode: VIEW_MODE,
						promptVersion: PROMPT_VERSION,
					});
					views.set(state.level, view);
				}
				return view;
			},
		},
	};
}
