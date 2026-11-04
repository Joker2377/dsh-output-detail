/**
 * Pure, versioned response-style policy. No runtime state or model settings.
 *
 * The policy never edits the human message. For every admitted human message it
 * appends a separate user-role message whose source kind is ours, carrying the
 * instruction as its own content. DSH logs that message under a non-`user`
 * source, so Chat renders it as an injected context row and the human bubble
 * keeps exactly what the user typed.
 *
 * The selection is session-scoped and lives in the Session log alone (see
 * projection.js). There is no per-message override: `/output-detail N` is the
 * only way to choose a level.
 */
import { randomUUID } from 'node:crypto';

export const DEFAULT_LEVEL = 3;
export const PROMPT_VERSION = 1;
export const PROJECTION_KEY = 'output-detail';
export const COMMAND_NAME = 'output-detail';
export const TOOL_NAME = 'output_detail';
/**
 * Durable message-source kind of the injected context message. Producer-owned
 * direct kinds are the current convention (`plan-mode`, `tool-goal`, `schedule`)
 * and are preserved by the session-format migrations; never `user`.
 */
export const CONTEXT_KIND = 'output-detail';
export const LEVELS = Object.freeze([
  { level: 1, id: 'minimal', label: '極簡' },
  { level: 2, id: 'concise', label: '精簡' },
  { level: 3, id: 'balanced', label: '標準' },
  { level: 4, id: 'detailed', label: '深入' },
  { level: 5, id: 'comprehensive', label: '完整剖析' },
].map(Object.freeze));

const LABELS = new Map(LEVELS.map(({ level, label }) => [level, label]));

const GUIDANCE = Object.freeze({
  1: 'Minimal: answer first; include only the result, essential caveats, and a next step if needed.',
  2: 'Concise: answer first with the key reason or steps; omit ceremony, repetition, and tangents.',
  3: 'Balanced: answer directly with enough explanation to understand or act; avoid unnecessary depth.',
  4: 'Detailed: explain relevant mechanisms, assumptions, a useful example, and important tradeoffs or limitations.',
  5: 'Comprehensive: systematically cover relevant mechanisms, alternatives, edge cases, failure modes, and supporting evidence; omit irrelevant filler.',
});

export function isLevel(value) {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}

function assertLevel(level) {
  if (!isLevel(level)) throw new RangeError('Detail level must be an integer from 1 to 5.');
}

export function renderInstruction(level) {
  assertLevel(level);
  return [
    `[[dsh-detail-applied:v${PROMPT_VERSION}:${level}]]`,
    `For replies to the human message immediately preceding this message only: ${GUIDANCE[level]} Explicit user format, length, or language requests take precedence over this preference. Keep essential facts, caveats, and the user's language. This controls explanation length, not work quality or the completeness of code and documents. Do not carry this style to later messages.`,
    '[[/dsh-detail-applied]]',
  ].join('\n');
}

/** One short, human-readable line for the collapsed context row. */
export function contextSummary(level) {
  assertLevel(level);
  return `回覆詳細度 ${level}/5 · ${LABELS.get(level)}（僅本則訊息）`;
}

const INSTRUCTIONS = new Map(LEVELS.map(({ level }) => [renderInstruction(level), level]));

/** Only a dedicated, exact instruction block qualifies as our previous injection. */
export function appliedLevel(content) {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    const found = INSTRUCTIONS.get(block.text);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The only message our policy may inject after: a real human turn. */
function humanMessage(message) {
  return message?.role === 'user'
    && message.source?.kind === 'user'
    && Array.isArray(message.content)
    && typeof message.id === 'string'
    && message.id !== '';
}

/**
 * A message is our earlier injection only when its kind, its target and an exact
 * instruction block all check out. Human content is never consulted, so a user
 * pasting the policy text is not mistaken for an applied style.
 */
function injectedTarget(message) {
  if (message?.role !== 'user' || message.source?.kind !== CONTEXT_KIND) return undefined;
  const targetId = message.source.targetId;
  if (typeof targetId !== 'string' || targetId === '') return undefined;
  return appliedLevel(message.content) === undefined ? undefined : targetId;
}

function injection(level, targetId) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: renderInstruction(level) }],
    source: {
      kind: CONTEXT_KIND,
      form: 'notice',
      summary: contextSummary(level),
      targetId,
      level,
    },
  };
}

/**
 * Only called on the admitted batch. Never mutates inbox, source, attachments,
 * decision fields, or prior history. Each admitted human message keeps its exact
 * identity and content; a new non-human context message follows it. A batch
 * already carrying our context message for that id is returned unchanged.
 */
export function rewriteDecision(decision, { level = DEFAULT_LEVEL } = {}) {
  if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision;
  assertLevel(level);
  const covered = new Set();
  for (const message of decision.messages) {
    const target = injectedTarget(message);
    if (target !== undefined) covered.add(target);
  }
  const messages = [];
  let changed = false;
  for (const message of decision.messages) {
    messages.push(message);
    if (!humanMessage(message) || covered.has(message.id)) continue;
    covered.add(message.id);
    messages.push(injection(level, message.id));
    changed = true;
  }
  return changed ? { ...decision, messages } : decision;
}
