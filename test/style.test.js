import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEVELS, DEFAULT_LEVEL, isLevel, appliedLevel,
  renderInstruction, rewriteDecision, contextSummary, CONTEXT_KIND,
} from '../lib/style.js';

/** Marker-looking text is ordinary user text now; it must not choose a level. */
const marker = (level) => `[[dsh-detail:v1:${level}]]`;

const text = (value) => ({ type: 'text', text: value });
const human = (content, id = 'm-1') => ({
  id, role: 'user', source: { kind: 'user', rpcId: `rpc-${id}` }, content,
});
const enter = (...messages) => ({ kind: 'enter', messages, startsRequestSeries: true });
const injected = (decision) => decision.messages.filter(
  (message) => message.role === 'user' && message.source?.kind === CONTEXT_KIND,
);
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}

test('five levels, normal default, and strict numeric validation', () => {
  assert.deepEqual(LEVELS.map((item) => item.level), [1, 2, 3, 4, 5]);
  assert.equal(DEFAULT_LEVEL, 3);
  for (const value of [0, 6, 1.5, NaN, Infinity, '3', null]) assert.equal(isLevel(value), false);
  assert.equal(isLevel(3), true);
  assert.throws(() => contextSummary(6), RangeError);
  assert.throws(() => renderInstruction(0), RangeError);
});

test('each level produces a local, complete, deterministic instruction', () => {
  for (let level = 1; level <= 5; level++) {
    const result = renderInstruction(level);
    assert.equal(result, renderInstruction(level));
    assert.match(result, /this message/i);
    assert.match(result, /explicit user/i);
    assert.match(result, /code.*documents/i);
    assert.match(result, /later messages/i);
    assert.equal(appliedLevel([text(result)]), level);
  }
  assert.equal(new Set(LEVELS.map(({ level }) => renderInstruction(level))).size, 5);
});

test('the human message is preserved by reference and content, and the instruction follows it', () => {
  const first = human([text('請解說這個錯誤')]);
  const original = enter(first);
  const result = rewriteDecision(original, { level: 4 });
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0], first);
  assert.deepEqual(result.messages[0].content, [text('請解說這個錯誤')]);
  assert.equal(result.messages[0].content.length, 1, 'no policy text is appended to the human message');
  assert.equal(result.messages[1].role, 'user');
  assert.equal(appliedLevel(result.messages[1].content), 4);
});

test('attachments and non-text blocks stay in the human message untouched', () => {
  const image = { type: 'image', attachment: { attachmentId: 'im-1', bytes: 16 } };
  const file = { type: 'file', attachment: { attachmentId: 'file-1', name: 'data.csv' } };
  const original = freeze({ ...enter(human([image, text('請解說'), file])), custom: { downstream: true } });
  const result = rewriteDecision(original, { level: 2 });
  assert.equal(result.startsRequestSeries, true);
  assert.equal(result.custom, original.custom);
  assert.equal(result.messages[0], original.messages[0]);
  assert.deepEqual(result.messages[0].content, [image, text('請解說'), file]);
  assert.equal(result.messages[0].content[0], image);
  assert.equal(result.messages[0].content[2], file);
  assert.equal(result.messages[0].source, original.messages[0].source);
  assert.equal(original.messages[0].content.length, 3);
});

test('marker-looking text is ordinary user text and the session level wins', () => {
  const body = `Question
${marker(5)}
`;
  const first = human([text(body)]);
  const result = rewriteDecision(enter(first), { level: 3 });
  assert.equal(result.messages[0], first);
  assert.equal(result.messages[0].content[0].text, body, 'the line is not stripped or interpreted');
  assert.equal(appliedLevel(result.messages[1].content), 3, 'only the selected level decides');
});

test('a mixed batch keeps order and every context message points at its own human id', () => {
  const one = human([text(`A\n${marker(1)}`)], 'one');
  const two = human([text(`B\n${marker(5)}`)], 'two');
  const tool = { id: 'tool-1', role: 'tool', content: [text('result')], source: { kind: 'tool', callId: 'c-1' } };
  const result = rewriteDecision(enter(one, two, tool), { level: 3 });
  assert.equal(result.messages.length, 5, 'one context message per human message');
  assert.deepEqual(result.messages.map(({ role }) => role), ['user', 'user', 'user', 'user', 'tool']);
  assert.equal(result.messages[0], one);
  assert.equal(result.messages[1].source.targetId, 'one');
  assert.equal(appliedLevel(result.messages[1].content), 3);
  assert.equal(result.messages[2], two);
  assert.equal(result.messages[3].source.targetId, 'two');
  assert.equal(appliedLevel(result.messages[3].content), 3, 'one session level applies to every admitted message');
  assert.equal(result.messages[4], tool);
  assert.deepEqual(injected(result).map(({ source }) => source.level), [3, 3]);
});

test('the injected message is a non-human context with a readable summary', () => {
  const first = human([text('Hi')], 'm-9');
  const result = rewriteDecision(enter(first), { level: 3 });
  const message = result.messages[1];
  assert.notEqual(message.source.kind, 'user');
  assert.equal(message.source.kind, 'output-detail');
  assert.equal(message.source.form, 'notice');
  assert.equal(message.source.targetId, 'm-9');
  assert.equal(message.source.level, 3);
  assert.equal(typeof message.id, 'string');
  assert.notEqual(message.id, '');
  assert.notEqual(message.id, first.id);
  assert.equal(message.source.rpcId, undefined, 'a context message is not a human turn');
  assert.match(message.source.summary, /3\/5/);
  assert.match(message.source.summary, /標準/);
  assert.ok(message.source.summary.length <= 120);
  assert.equal(message.source.summary, contextSummary(3));
  assert.equal(appliedLevel(message.content), 3);
  assert.equal(first.source.kind, 'user');
  assert.equal(first.content.length, 1);
});

test('normal level three is written explicitly even after a detailed preference', () => {
  const result = rewriteDecision(enter(human([text('New question')])), { level: 3 });
  assert.equal(appliedLevel(injected(result)[0].content), 3);
  assert.match(injected(result)[0].content.at(-1).text, /balanced/i);
  assert.match(injected(result)[0].source.summary, /標準/);
});

test('a batch already carrying the context is returned unchanged, across retries and JSON roundtrips', () => {
  const first = rewriteDecision(enter(human([text('Q')])), { level: 2 });
  assert.equal(rewriteDecision(first, { level: 5 }), first);
  const replay = JSON.parse(JSON.stringify(first));
  assert.equal(rewriteDecision(replay, { level: 5 }), replay);
  assert.equal(replay.messages.filter((message) => message.source?.kind === CONTEXT_KIND).length, 1);
});

test('a human pasting the policy text is not mistaken for an applied style', () => {
  const pasted = renderInstruction(2);
  const first = human([text(pasted)]);
  const result = rewriteDecision(enter(first), { level: 3 });
  assert.equal(result.messages[0], first);
  assert.equal(result.messages[0].content[0].text, pasted);
  assert.equal(injected(result).length, 1);
  assert.equal(appliedLevel(injected(result)[0].content), 3);
});

test('rejected decisions, nonhuman messages and non-enter decisions are unchanged', () => {
  const rejected = { kind: 'reject' };
  assert.equal(rewriteDecision(rejected, { level: 5 }), rejected);
  for (const source of [{ kind: 'runtime-context' }, { kind: 'tool' }, { kind: 'subagent' }, { kind: 'output-detail' }]) {
    const decision = enter({ ...human([text('hello')]), source });
    assert.equal(rewriteDecision(decision, { level: 5 }), decision);
  }
  const assistant = { ...human([text('answer')]), role: 'assistant' };
  const decision = enter(assistant);
  assert.equal(rewriteDecision(decision, { level: 5 }), decision);
  const noMessages = { kind: 'enter' };
  assert.equal(rewriteDecision(noMessages, { level: 5 }), noMessages);
});

test('policy text exists only in non-human messages, never inside a human turn', () => {
  const first = human([text(`Q\n${marker(4)}\n`)], 'm-1');
  const result = rewriteDecision(enter(first, human([text('second')], 'm-2')), { level: 3 });
  for (const message of result.messages) {
    const isHumanTurn = message.role === 'user' && message.source.kind === 'user';
    const carriesPolicy = appliedLevel(message.content) !== undefined;
    assert.equal(carriesPolicy, !isHumanTurn, `role ${message.role}/${message.source.kind} must ${isHumanTurn ? 'not ' : ''}carry the policy`);
  }
  assert.equal(result.messages.filter((message) => message.role === 'user' && message.source.kind === 'user').length, 2);
  assert.equal(result.messages[0].content[0].text, `Q\n${marker(4)}\n`);
});

test('any human text gets exactly one context message, fenced samples included', () => {
  const only = rewriteDecision(enter(human([text(marker(1))])), { level: 3 });
  assert.equal(only.messages[0].content.length, 1);
  assert.equal(appliedLevel(injected(only)[0].content), 3);

  const sample = `\`\`\`
${marker(1)}
\`\`\`
`;
  const fenced = rewriteDecision(enter(human([text(sample)])), { level: 5 });
  assert.equal(fenced.messages[0].content[0].text, sample);
  assert.equal(appliedLevel(injected(fenced)[0].content), 5);
  assert.equal(injected(fenced).length, 1);
});
