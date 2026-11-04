import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = path.join(HERE, '..', 'client.js');
const SOURCE = fs.readFileSync(CLIENT_PATH, 'utf8');

/* ----------------------------------------------------------------------------
 * Minimal React runtime: real hook slots keyed by fiber identity, one render
 * pass at a time, effects flushed between passes. Enough to drive the actual
 * component callbacks instead of string-matching the bundle.
 * ------------------------------------------------------------------------- */

function sameDeps(previous, next) {
  if (previous === undefined || next === undefined) return previous === next;
  if (previous.length !== next.length) return false;
  return previous.every((value, index) => Object.is(value, next[index]));
}

function createReactRuntime() {
  const React = {};
  const fibers = new Map();
  let currentFiber = null;
  let cursor = 0;
  let dirty = false;
  let queuedEffects = [];
  let fiberSeq = 0;

  function slotsOf() {
    let slots = fibers.get(currentFiber);
    if (slots === undefined) {
      slots = [];
      fibers.set(currentFiber, slots);
    }
    return slots;
  }

  function useSlot(initialize) {
    const slots = slotsOf();
    const index = cursor;
    cursor += 1;
    if (!(index in slots)) slots[index] = initialize();
    return { slots, index, entry: slots[index] };
  }

  React.createElement = (type, props, ...children) => {
    const next = { ...(props === null || props === undefined ? {} : props) };
    if (children.length === 1) next.children = children[0];
    else if (children.length > 1) next.children = children;
    return { type, props: next };
  };

  React.useState = (initial) => {
    const { slots, index } = useSlot(() => ({
      value: typeof initial === 'function' ? initial() : initial,
    }));
    const entry = slots[index];
    const setState = (next) => {
      entry.value = typeof next === 'function' ? next(entry.value) : next;
      dirty = true;
    };
    return [entry.value, setState];
  };

  React.useRef = (initial) => useSlot(() => ({ current: initial })).entry;

  React.useMemo = (factory, deps) => {
    const { slots, index } = useSlot(() => ({ init: true, deps: undefined, value: undefined }));
    const entry = slots[index];
    if (entry.init || !sameDeps(entry.deps, deps)) {
      entry.value = factory();
      entry.deps = deps;
      entry.init = false;
    }
    return entry.value;
  };

  React.useCallback = (factory, deps) => React.useMemo(() => factory, deps);

  React.useEffect = (effect, deps) => {
    const { slots, index } = useSlot(() => ({ init: true, deps: undefined, cleanup: undefined }));
    const entry = slots[index];
    if (entry.init || !sameDeps(entry.deps, deps)) {
      entry.deps = deps;
      entry.init = false;
      queuedEffects.push({ entry, effect });
    }
  };

  React.useSyncExternalStore = (subscribe, getSnapshot) => {
    const value = getSnapshot();
    useSlot(() => ({ subscribed: subscribe }));
    React.useEffect(() => {
      const unsubscribe = subscribe(() => {
        dirty = true;
      });
      return typeof unsubscribe === 'function' ? unsubscribe : undefined;
    }, [subscribe]);
    return value;
  };

  function renderTree(node, trace) {
    if (node === null || node === undefined || typeof node === 'boolean') return null;
    if (Array.isArray(node)) {
      const rendered = [];
      for (let index = 0; index < node.length; index += 1) {
        const child = renderTree(node[index], `${trace}:${index}`);
        if (child !== null) rendered.push(child);
      }
      return rendered;
    }
    if (typeof node === 'string' || typeof node === 'number') return { type: '#text', text: String(node) };
    if (typeof node.type === 'function') {
      const fiber = `${trace}<${node.type.name || 'anonymous'}#${fiberSeq}>`;
      fiberSeq += 1;
      const previousFiber = currentFiber;
      const previousCursor = cursor;
      currentFiber = fiber;
      cursor = 0;
      let output;
      try {
        output = node.type(node.props || {});
      } finally {
        currentFiber = previousFiber;
        cursor = previousCursor;
      }
      return renderTree(output, fiber);
    }
    const props = { ...(node.props || {}) };
    if (props.children !== undefined) props.children = renderTree(props.children, `${trace}/${String(node.type)}`);
    return { type: node.type, props };
  }

  function flushEffects() {
    const effects = queuedEffects;
    queuedEffects = [];
    for (const { entry, effect } of effects) {
      if (typeof entry.cleanup === 'function') {
        entry.cleanup();
        entry.cleanup = undefined;
      }
      const cleanup = effect();
      entry.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    }
  }

  function mount(Component, initialProps) {
    let props = initialProps;
    let tree = null;
    const runPass = () => {
      dirty = false;
      queuedEffects = [];
      fiberSeq = 0;
      currentFiber = null;
      cursor = 0;
      tree = renderTree(React.createElement(Component, props), 'root');
      flushEffects();
    };
    let guard = 0;
    do {
      runPass();
    } while (dirty && (guard += 1) < 12);

    return {
      get tree() {
        return tree;
      },
      rerender(nextProps) {
        if (nextProps !== undefined) props = nextProps;
        let loop = 0;
        do {
          runPass();
        } while (dirty && (loop += 1) < 12);
        return tree;
      },
      unmount() {
        for (const slots of fibers.values()) {
          for (let index = slots.length - 1; index >= 0; index -= 1) {
            const entry = slots[index];
            if (entry !== null && typeof entry === 'object' && typeof entry.cleanup === 'function') {
              entry.cleanup();
              entry.cleanup = undefined;
            }
          }
        }
      },
    };
  }

  return { React, mount };
}

/* ----------------------------------------------------------------------------
 * Loader / service fakes
 * ------------------------------------------------------------------------- */

function loadBundle(React) {
  let definition = null;
  const requireCalls = [];
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(loaded) {
          definition = loaded;
        },
      },
    },
    AbortController,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'client.js' });
  assert.ok(definition !== null, 'bundle must call window.__ModuleLoader__.load');
  const bundle = definition.factory((name) => {
    requireCalls.push(name);
    if (name === 'react') return React;
    throw new Error(`unexpected require: ${name}`);
  });
  return { definition, bundle, requireCalls };
}

function createLocaleService() {
  const dicts = new Map();
  const listeners = new Set();
  let active = 'zh';
  let revision = 0;

  const announce = () => {
    revision += 1;
    for (const listener of [...listeners]) listener();
  };

  const translate = (namespace, key, params) => {
    const chain = active === 'zh' ? ['zh', 'en'] : ['en'];
    let template;
    for (const locale of chain) {
      const entry = dicts.get(namespace)?.get(locale)?.[key];
      if (entry !== undefined) {
        template = entry;
        break;
      }
    }
    if (template === undefined) return key;
    if (params === undefined) return template;
    return template.replace(/\{(\w+)\}/gu, (match, name) => (name in params ? String(params[name]) : match));
  };

  return {
    dicts,
    register(namespace, localeOrDicts, dict) {
      const pairs = typeof localeOrDicts === 'string' ? [[localeOrDicts, dict]] : Object.entries(localeOrDicts);
      for (const [locale, entries] of pairs) {
        if (!dicts.has(namespace)) dicts.set(namespace, new Map());
        const byLocale = dicts.get(namespace);
        if (byLocale.has(locale)) throw new Error(`duplicate locale ${locale}`);
        byLocale.set(locale, entries);
      }
      announce();
      return () => {
        const byLocale = dicts.get(namespace);
        if (byLocale === undefined) return;
        for (const [locale] of pairs) byLocale.delete(locale);
        announce();
      };
    },
    bind(namespace) {
      return (key, params) => translate(namespace, key, params);
    },
    getSnapshot() {
      return { active, revision };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setActive(next) {
      active = next;
      announce();
    },
  };
}

function createSlotsService() {
  const registrations = [];
  const injections = [];
  return {
    registrations,
    injections,
    inject(key, callback) {
      const record = { key, disposer: undefined, active: true };
      injections.push(record);
      record.disposer = callback();
      return () => {
        if (!record.active) return;
        record.active = false;
        if (typeof record.disposer === 'function') record.disposer();
      };
    },
    register(options, component) {
      const record = { options, component, disposed: false };
      registrations.push(record);
      return () => {
        record.disposed = true;
      };
    },
  };
}

function createRemote() {
  const calls = [];
  let handler = async () => undefined;
  return {
    calls,
    commands: {
      execute(sessionId, line, attachments, signal) {
        calls.push({ sessionId, line, attachments, signal });
        return handler({ sessionId, line, attachments, signal });
      },
    },
    reply(next) {
      handler = next;
    },
  };
}

function applyBundle(bundle, remote) {
  const locale = createLocaleService();
  const slots = createSlotsService();
  const effects = [];
  const ctx = {
    locale,
    slots,
    remote,
    effect(fn, label) {
      const disposer = fn();
      effects.push({ label, dispose: disposer });
      return disposer;
    },
  };
  bundle.apply(ctx);
  return { ctx, locale, slots, effects };
}

function projectionOf(level) {
  return { level, mode: 'best-effort', promptVersion: 1 };
}

function successText(level, overrides) {
  return JSON.stringify({
    plugin: 'dsh-output-detail',
    version: 1,
    status: 'ok',
    mode: 'best-effort',
    promptVersion: 1,
    action: 'set',
    level,
    previousLevel: 3,
    changed: true,
    allowedLevels: [1, 2, 3, 4, 5],
    ...(overrides || {}),
  });
}

function successReply(level) {
  return async () => ({
    ok: true,
    value: { commandId: 'cmd-1', result: { kind: 'success', text: successText(level) } },
  });
}

/** One seat: registration + inject face + mounted component over mutable state. */
function seat({ runtime, remote, projection, extra }) {
  const { bundle } = loadBundle(runtime.React);
  const origin = applyBundle(bundle, remote);
  const registration = origin.slots.registrations[0];
  assert.ok(registration, 'the bundle must register its composer control');
  const face = registration.options.inject('s1');
  const state = { projection: projection === undefined ? projectionOf(3) : projection };
  const projectionKeys = [];
  const propsFor = () => ({
    sessionId: 's1',
    ...face,
    useProjection: (key) => {
      projectionKeys.push(key);
      return state.projection;
    },
    localeFace: origin.locale,
    t: origin.locale.bind('output-detail'),
    ...(extra || {}),
  });
  const mounted = runtime.mount(registration.component, propsFor());
  return {
    ...origin,
    registration,
    face,
    state,
    mounted,
    projectionKeys,
    rerender(next) {
      mounted.rerender(next === undefined ? propsFor() : { ...propsFor(), ...next });
    },
  };
}

/* ----------------------------------------------------------------------------
 * Tree helpers
 * ------------------------------------------------------------------------- */

function findAll(tree, predicate, out = []) {
  if (tree === null || tree === undefined) return out;
  if (Array.isArray(tree)) {
    for (const node of tree) findAll(node, predicate, out);
    return out;
  }
  if (predicate(tree)) out.push(tree);
  if (tree.props !== undefined && tree.props !== null) findAll(tree.props.children, predicate, out);
  return out;
}

function findOne(tree, predicate) {
  return findAll(tree, predicate)[0];
}

function textOf(tree) {
  if (tree === null || tree === undefined) return '';
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (Array.isArray(tree)) return tree.map(textOf).join('');
  if (tree.type === '#text') return tree.text;
  return textOf(tree.props === undefined ? undefined : tree.props.children);
}

/** The control root, the level steps and the pin button, by their stable data hooks. */
function rootOf(tree) {
  return findOne(tree, (node) => node.props !== undefined && node.props !== null
    && Object.hasOwn(node.props, 'data-dsh-output-detail')) ?? null;
}

function stepsOf(tree) {
  return findAll(tree, (node) => node.type === 'button' && node.props !== undefined
    && node.props !== null && Object.hasOwn(node.props, 'data-level'));
}

function stepAt(tree, level) {
  return stepsOf(tree).find((node) => node.props['data-level'] === level);
}

function selectedLevel(tree) {
  const root = rootOf(tree);
  assert.ok(root, 'the control root must render');
  const raw = root.props['data-level'];
  return raw === '' || raw === undefined ? undefined : Number(raw);
}

function pick(view, level) {
  const step = stepAt(view.mounted.tree, level);
  assert.ok(step, `level ${level} must render a step`);
  step.props.onClick();
}

function statusNode(tree) {
  return findOne(tree, (node) => node.props !== undefined && node.props !== null
    && Object.hasOwn(node.props, 'data-tone')) ?? null;
}

/** Visible status/notice text plus the full detail carried by its title. */
function messagesOf(tree) {
  const node = statusNode(tree);
  if (node === null) return '';
  return `${textOf(node)} ${typeof node.props.title === 'string' ? node.props.title : ''}`;
}

const flush = async () => {
  for (let index = 0; index < 12; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

/* ----------------------------------------------------------------------------
 * Tests
 * ------------------------------------------------------------------------- */

test('loader contract: id, factory, single react import, apply/inject exports', () => {
  const runtime = createReactRuntime();
  const { definition, bundle, requireCalls } = loadBundle(runtime.React);

  assert.equal(definition.id, 'dsh-output-detail');
  assert.equal(typeof definition.factory, 'function');
  assert.deepEqual(requireCalls, ['react']);
  assert.equal(typeof bundle.apply, 'function');
  assert.ok(Array.isArray(bundle.inject));
  assert.deepEqual([...bundle.inject].sort(), ['locale', 'remote', 'remote.commands', 'slots']);
  assert.deepEqual(Object.keys(bundle).sort(), ['apply', 'inject']);
});

test('register: conversation.input.left, locale namespace, dictionaries and disposal', () => {
  const runtime = createReactRuntime();
  const remote = createRemote();
  const { bundle } = loadBundle(runtime.React);
  const { locale, slots, effects } = applyBundle(bundle, remote);

  assert.equal(slots.injections.length, 1);
  assert.equal(slots.injections[0].key, 'conversation.input.left');
  assert.equal(slots.registrations.length, 1);

  const registration = slots.registrations[0];
  assert.equal(registration.options.name, 'conversation.input.left');
  assert.equal(registration.options.id, 'output-detail');
  assert.equal(registration.options.locale, 'output-detail');
  assert.equal(typeof registration.component, 'function');

  const byLocale = locale.dicts.get('output-detail');
  assert.ok(byLocale instanceof Map);
  assert.ok(byLocale.has('en'));
  assert.ok(byLocale.has('zh'));
  for (const key of ['label', 'hint', 'value', 'level.1', 'level.5', 'status.syncing', 'error.transport']) {
    assert.ok(Object.hasOwn(byLocale.get('en'), key), `en dictionary must define ${key}`);
    assert.ok(Object.hasOwn(byLocale.get('zh'), key), `zh dictionary must define ${key}`);
  }

  const control = effects.find((effect) => String(effect.label).includes('composer control'));
  assert.ok(control, 'the control effect must be registered on the plugin fiber');
  const dictionaries = effects.find((effect) => String(effect.label).includes('dictionaries'));
  assert.ok(dictionaries, 'the dictionary effect must be registered on the plugin fiber');
  control.dispose();
  assert.equal(registration.disposed, true);
  dictionaries.dispose();
  assert.equal(locale.dicts.get('output-detail').size, 0, 'dictionary disposal clears the namespace');
});

test('injected executeLevel uses the native three-argument remote command contract', async () => {
  const runtime = createReactRuntime();
  const remote = createRemote();
  remote.reply(successReply(4));
  const { bundle } = loadBundle(runtime.React);
  const { slots } = applyBundle(bundle, remote);
  const face = slots.registrations[0].options.inject('s7');

  const controller = new AbortController();
  const outcome = await face.executeLevel(4, controller.signal);

  assert.equal(remote.calls.length, 1);
  const call = remote.calls[0];
  assert.equal(call.sessionId, 's7');
  assert.equal(call.line, '/output-detail 4');
  assert.ok(Array.isArray(call.attachments));
  assert.equal(call.attachments.length, 0, 'the command carries no attachments');
  assert.equal(call.signal, undefined, 'the native remote accepts three arguments; it does not offer transport abort');
  assert.equal(outcome.value.result.kind, 'success');
});
test('meter control: five named steps, localized label and value, default level 3', () => {
  const runtime = createReactRuntime();
  const remote = createRemote();
  const view = seat({ runtime, remote });
  const tree = view.mounted.tree;

  const steps = stepsOf(tree);
  assert.equal(steps.length, 5, 'one step per level, no slider');
  assert.deepEqual(steps.map((node) => node.props['data-level']), [1, 2, 3, 4, 5]);
  for (const step of steps) {
    assert.equal(step.props.role, 'radio');
    assert.equal(step.props.type, 'button');
    assert.equal(step.props.disabled, false);
  }
  assert.equal(stepAt(tree, 3).props['aria-checked'], 'true');
  assert.equal(stepAt(tree, 3).props['aria-label'], '標準 · 3/5');
  assert.equal(stepAt(tree, 3).props.tabIndex, 0, 'the selected step owns the tab stop');
  assert.equal(stepAt(tree, 5).props['aria-checked'], 'false');
  assert.equal(stepAt(tree, 5).props.tabIndex, -1);

  assert.equal(selectedLevel(tree), 3);
  assert.match(textOf(tree), /回答詳略/u);
  assert.match(textOf(tree), /標準/u);
  assert.equal(rootOf(tree).props['data-sync'], 'idle');
  assert.equal(statusNode(tree), null, 'an idle control says nothing; the value already carries the level');
  assert.equal(stepsOf(tree).length, 5, 'there is no second action button');
  assert.ok(view.projectionKeys.length > 0);
  assert.ok(view.projectionKeys.every((key) => key === 'output-detail'), 'reads the output-detail projection key');
});

test('the control explains itself through the label tooltip instead of permanent chrome', () => {
  const runtime = createReactRuntime();
  const view = seat({ runtime, remote: createRemote() });
  assert.match(rootOf(view.mounted.tree).props.title, /草稿/u);
});

test('locale service subscription re-renders into English', () => {
  const runtime = createReactRuntime();
  const remote = createRemote();
  const view = seat({ runtime, remote });

  view.locale.setActive('en');
  view.mounted.rerender();

  const tree = view.mounted.tree;
  assert.equal(stepAt(tree, 3).props['aria-label'], 'Standard · 3/5');
  assert.match(textOf(tree), /Response detail/u);
  assert.match(textOf(tree), /Standard/u);
  assert.equal(statusNode(tree), null);
});

test('a missing projection reports unavailable and never claims a level', () => {
  const runtime = createReactRuntime();
  const remote = createRemote();
  const view = seat({ runtime, remote, projection: null });

  assert.equal(selectedLevel(view.mounted.tree), undefined, 'no fake level 3');
  for (const step of stepsOf(view.mounted.tree)) {
    assert.equal(step.props.disabled, true);
    assert.equal(step.props['aria-checked'], 'false');
  }
  assert.match(textOf(view.mounted.tree), /不可用/u);
  assert.equal(rootOf(view.mounted.tree).props['data-sync'], 'unavailable');
});

test('a click sends the command and the meter only ever shows the projection', async () => {
  const runtime = createReactRuntime();
  const remote = createRemote();
  let release = null;
  remote.reply(() => new Promise((resolve) => {
    release = () => resolve({
      ok: true,
      value: { commandId: 'cmd-2', result: { kind: 'success', text: successText(4) } },
    });
  }));
  const view = seat({ runtime, remote });

  pick(view, 4);
  view.rerender();

  assert.equal(remote.calls.length, 1);
  assert.equal(remote.calls[0].line, '/output-detail 4');
  assert.equal(remote.calls[0].attachments.length, 0);
  assert.equal(selectedLevel(view.mounted.tree), 3, 'no local level state: the projection still says 3');
  assert.equal(stepAt(view.mounted.tree, 4).props['aria-checked'], 'false');
  assert.equal(textOf(statusNode(view.mounted.tree)), '儲存中…');

  release();
  await flush();
  view.rerender();
  assert.equal(selectedLevel(view.mounted.tree), 3, 'the Host confirmation alone does not move the meter');

  view.state.projection = projectionOf(4);
  view.rerender();
  assert.equal(selectedLevel(view.mounted.tree), 4);
  assert.equal(stepAt(view.mounted.tree, 4).props['aria-checked'], 'true');
  assert.equal(rootOf(view.mounted.tree).props['data-sync'], 'idle');
  assert.equal(statusNode(view.mounted.tree), null);
});

test('choosing the level already in the projection sends nothing', () => {
  const runtime = createReactRuntime();
  const remote = createRemote();
  const view = seat({ runtime, remote });
  pick(view, 3);
  view.rerender();
  assert.equal(remote.calls.length, 0);
  assert.equal(selectedLevel(view.mounted.tree), 3);
});

test('the radiogroup answers arrow, home and end keys with one command per change', async () => {
  const runtime = createReactRuntime();
  const remote = createRemote();
  remote.reply(async ({ line }) => ({
    ok: true,
    value: { commandId: 'k', result: { kind: 'success', text: successText(Number(line.slice(-1))) } },
  }));
  const view = seat({ runtime, remote });

  const meterOf = () => findOne(view.mounted.tree, (node) => node.props && node.props.role === 'radiogroup');
  const press = async (key) => {
    let prevented = 0;
    meterOf().props.onKeyDown({ key, preventDefault: () => { prevented += 1; } });
    view.rerender();
    await flush();
    view.rerender();
    return prevented;
  };

  assert.equal(await press('ArrowRight'), 1);
  assert.equal(remote.calls[0].line, '/output-detail 4');
  view.state.projection = projectionOf(4);
  view.rerender();
  await press('End');
  assert.equal(remote.calls.at(-1).line, '/output-detail 5');
  view.state.projection = projectionOf(5);
  view.rerender();
  await press('Home');
  assert.equal(remote.calls.at(-1).line, '/output-detail 1');

  const before = remote.calls.length;
  const unrelated = await press('Tab');
  assert.equal(unrelated, 0, 'unhandled keys keep their default');
  assert.equal(remote.calls.length, before);
});

test('a failed request reports the Host message and leaves the meter alone', async () => {
  const runtime = createReactRuntime();
  const remote = createRemote();
  remote.reply(async () => ({ ok: false, error: { code: 'E_DENIED', message: 'denied by host' } }));
  const view = seat({ runtime, remote });

  pick(view, 5);
  view.rerender();
  await flush();
  view.rerender();

  assert.equal(selectedLevel(view.mounted.tree), 3, 'the projection is untouched');
  const status = statusNode(view.mounted.tree);
  assert.equal(textOf(status), '同步失敗');
  assert.match(status.props.title, /denied by host/u);
  assert.equal(status.props['aria-label'], 'denied by host', 'assistive tech gets the full reason');
  assert.equal(status.props['data-tone'], 'error');
});

test('a success reply that does not confirm the plugin contract is treated as a failure', async () => {
  const runtime = createReactRuntime();
  const remote = createRemote();
  remote.reply(async () => ({
    ok: true,
    value: { commandId: 'cmd-x', result: { kind: 'success', text: successText(4, { plugin: 'someone-else' }) } },
  }));
  const view = seat({ runtime, remote });

  pick(view, 4);
  view.rerender();
  await flush();
  view.rerender();

  assert.equal(selectedLevel(view.mounted.tree), 3);
  assert.match(messagesOf(view.mounted.tree), /主機回覆未確認這個等級/u);
});

test('a host error envelope surfaces the Host message', async () => {
  const runtime = createReactRuntime();
  const remote = createRemote();
  remote.reply(async () => ({
    ok: true,
    value: {
      commandId: 'cmd-err',
      result: {
        kind: 'error',
        text: JSON.stringify({
          plugin: 'dsh-output-detail',
          version: 1,
          status: 'error',
          mode: 'set',
          level: 3,
          error: 'invalid-level',
          message: 'Detail level must be a whole number from 1 to 5.',
        }),
      },
    },
  }));
  const view = seat({ runtime, remote });

  pick(view, 4);
  view.rerender();
  await flush();
  view.rerender();

  assert.equal(selectedLevel(view.mounted.tree), 3);
  assert.match(messagesOf(view.mounted.tree), /Detail level must be a whole number from 1 to 5\./u);
});

test('an unresolved command reports it is unavailable instead of claiming success', async () => {
  const runtime = createReactRuntime();
  const remote = createRemote();
  remote.reply(async () => ({ ok: true, value: undefined }));
  const view = seat({ runtime, remote });

  pick(view, 4);
  view.rerender();
  await flush();
  view.rerender();

  assert.equal(selectedLevel(view.mounted.tree), 3);
  assert.match(messagesOf(view.mounted.tree), /沒有 \/output-detail 指令/u);
});

test('every click is sent directly: no queue, and the projection decides', async () => {
  const runtime = createReactRuntime();
  const remote = createRemote();
  const resolvers = [];
  remote.reply(({ line }) => new Promise((resolve) => {
    resolvers.push(() => resolve({
      ok: true,
      value: { commandId: `cmd-${resolvers.length}`, result: { kind: 'success', text: successText(Number(line.slice(-1))) } },
    }));
  }));
  const view = seat({ runtime, remote });

  pick(view, 2);
  pick(view, 4);
  pick(view, 5);

  assert.equal(remote.calls.length, 3, 'each click is one command; there is no client queue');
  assert.deepEqual(remote.calls.map((call) => call.line), ['/output-detail 2', '/output-detail 4', '/output-detail 5']);
  assert.equal(selectedLevel(view.mounted.tree), 3, 'none of them moved the meter by itself');

  for (const resolve of resolvers) resolve();
  await flush();
  view.state.projection = projectionOf(5);
  view.rerender();
  assert.equal(selectedLevel(view.mounted.tree), 5);
  assert.equal(statusNode(view.mounted.tree), null);
});

test('a stale reply cannot report an error over a newer request', async () => {
  const runtime = createReactRuntime();
  const remote = createRemote();
  const pending = [];
  remote.reply(({ line }) => new Promise((resolve) => {
    pending.push({ line, resolve });
  }));
  const view = seat({ runtime, remote });

  pick(view, 4);
  pick(view, 5);
  assert.equal(pending.length, 2);

  pending[1].resolve({ ok: true, value: { commandId: 'newer', result: { kind: 'success', text: successText(5) } } });
  await flush();
  view.rerender();
  assert.equal(textOf(statusNode(view.mounted.tree)), '儲存中…', 'the older request is still in flight');

  pending[0].resolve({ ok: false, error: { code: 'E_OLD', message: 'stale failure' } });
  await flush();
  view.rerender();
  assert.equal(statusNode(view.mounted.tree), null, 'a stale failure is ignored');
});

test('session change drops the in-flight reply of the previous session', async () => {
  const runtime = createReactRuntime();
  const remote = createRemote();
  let release = null;
  remote.reply(() => new Promise((resolve) => {
    release = () => resolve({ ok: false, error: { code: 'E', message: 'old session failure' } });
  }));
  const view = seat({ runtime, remote });

  pick(view, 4);
  view.rerender();
  assert.equal(remote.calls.length, 1);

  const asSessionTwo = () => view.rerender({
    sessionId: 's2',
    executeLevel: (next) => remote.commands.execute('s2', `/output-detail ${next}`, []),
    useProjection: () => projectionOf(2),
  });
  asSessionTwo();
  assert.equal(selectedLevel(view.mounted.tree), 2, 'the new session keeps its projected level');
  assert.equal(statusNode(view.mounted.tree), null);

  release();
  await flush();
  asSessionTwo();
  assert.equal(selectedLevel(view.mounted.tree), 2);
  assert.equal(statusNode(view.mounted.tree), null, 'the old reply cannot surface in the new session');
  assert.equal(remote.calls.length, 1);
});

test('the bundle never touches the composer and keeps no level of its own', () => {
  for (const forbidden of ['innerHTML', 'localStorage', 'sessionStorage', 'fetch(', 'XMLHttpRequest', 'setDraft', 'submit(', 'insertText', 'captureInsertion', 'inputActions', 'useInput', 'marker', 'optimistic', 'setHeld', 'queueRef']) {
    assert.ok(!SOURCE.includes(forbidden), `client.js must not reference ${forbidden}`);
  }
  assert.ok(!/\bsetInterval\s*\(/u.test(SOURCE), 'no polling timers');
  assert.ok(!/require\(\s*['"](?!react['"])/u.test(SOURCE), 'the bundle may only import react');

  const start = SOURCE.indexOf('function injectStyles()');
  assert.ok(start > 0, 'the style installer must exist');
  const end = SOURCE.indexOf('/** @param {unknown} value @returns', start);
  assert.ok(end > start, 'the style installer region must be bounded');
  const outside = `${SOURCE.slice(0, start)}${SOURCE.slice(end)}`;
  assert.ok(!/\bdocument\b/u.test(outside), 'only the guarded style installer may reference the document');
  assert.match(SOURCE.slice(start, end), /typeof document === 'undefined'/u, 'the installer must survive a DOM-less runtime');
});

test('the stylesheet uses Host design tokens and real interaction states', () => {
  const start = SOURCE.indexOf('/* dsh-output-detail:control-css */');
  const end = SOURCE.indexOf('/* end dsh-output-detail:control-css */');
  assert.ok(start > 0 && end > start, 'the control stylesheet must be delimited');
  const css = SOURCE.slice(start, end);
  assert.match(css, /--dsw-alias-/u, 'colours come from the Host theme');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/iu, 'no hard-coded colours');
  assert.doesNotMatch(css, /rgba?\(/u, 'no ad-hoc colour mixes');
  assert.match(css, /:focus-visible/u, 'keyboard focus must be visible');
  assert.match(css, /:hover/u);
  assert.doesNotMatch(css, /transition-all/u);
  for (const selector of ['.dsh-od', '.dsh-od__step', '.dsh-od__value', '.dsh-od__status']) {
    assert.ok(css.includes(selector), `stylesheet must style ${selector}`);
  }
  assert.ok(!css.includes('dsh-od__pin'), 'the pin button is gone');
});
