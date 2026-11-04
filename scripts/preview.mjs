/**
 * Design preview for the composer control.
 *
 * Mounts the real client bundle in a minimal React runtime, serialises the
 * resulting tree to HTML, and writes a self-contained review page next to the
 * Host's own design tokens (sampled from dsh-client-ui-theme). It renders the
 * control as the composer strip does, at 1x and 2x, in both themes, so the
 * layout and state styling can be looked at instead of inferred.
 *
 * Development aid only: not part of the published bundle.
 *
 *   node scripts/preview.mjs   →   demo/preview.html
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');

/* ---------------------------------------------------------------- runtime */

function sameDeps(previous, next) {
  if (previous === undefined || next === undefined) return previous === next;
  if (previous.length !== next.length) return false;
  return previous.every((value, index) => Object.is(value, next[index]));
}

function createRuntime() {
  const React = {};
  const fibers = new Map();
  let current;
  let cursor = 0;
  let dirty = false;
  let queued = [];
  let seq = 0;

  const slots = () => {
    if (!fibers.has(current)) fibers.set(current, []);
    return fibers.get(current);
  };
  const slot = (init) => {
    const list = slots();
    const index = cursor;
    cursor += 1;
    if (!(index in list)) list[index] = init();
    return { list, index, entry: list[index] };
  };

  React.createElement = (type, props, ...children) => {
    const next = { ...(props || {}) };
    if (children.length === 1) next.children = children[0];
    else if (children.length > 1) next.children = children;
    return { type, props: next };
  };
  React.useState = (initial) => {
    const { entry } = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }));
    return [entry.value, (next) => {
      const value = typeof next === 'function' ? next(entry.value) : next;
      if (Object.is(value, entry.value)) return;
      entry.value = value;
      dirty = true;
    }];
  };
  React.useRef = (initial) => slot(() => ({ current: initial })).entry;
  React.useMemo = (factory, deps) => {
    const { entry } = slot(() => ({ init: true, deps: undefined, value: undefined }));
    if (entry.init || !sameDeps(entry.deps, deps)) {
      entry.value = factory();
      entry.deps = deps;
      entry.init = false;
    }
    return entry.value;
  };
  React.useCallback = (factory, deps) => React.useMemo(() => factory, deps);
  React.useEffect = (effect, deps) => {
    const { entry } = slot(() => ({ init: true, deps: undefined, cleanup: undefined }));
    if (entry.init || !sameDeps(entry.deps, deps)) {
      entry.deps = deps;
      entry.init = false;
      queued.push({ entry, effect });
    }
  };
  React.useSyncExternalStore = (subscribe, getSnapshot) => {
    const value = getSnapshot();
    slot(() => ({ subscribed: subscribe }));
    React.useEffect(() => subscribe(() => { dirty = true; }), [subscribe]);
    return value;
  };

  const renderNode = (node, trace) => {
    if (node === null || node === undefined || typeof node === 'boolean') return null;
    if (Array.isArray(node)) {
      return node.map((child, index) => renderNode(child, `${trace}:${index}`)).filter((child) => child !== null);
    }
    if (typeof node === 'string' || typeof node === 'number') return { type: '#text', text: String(node) };
    if (typeof node.type === 'function') {
      const fiber = `${trace}<${node.type.name || 'anonymous'}#${seq}>`;
      seq += 1;
      const previous = current;
      const previousCursor = cursor;
      current = fiber;
      cursor = 0;
      let output;
      try {
        output = node.type(node.props || {});
      } finally {
        current = previous;
        cursor = previousCursor;
      }
      return renderNode(output, fiber);
    }
    const props = { ...(node.props || {}) };
    if (props.children !== undefined) props.children = renderNode(props.children, `${trace}/${String(node.type)}`);
    return { type: node.type, props };
  };

  const flush = () => {
    const effects = queued;
    queued = [];
    for (const { entry, effect } of effects) {
      if (typeof entry.cleanup === 'function') entry.cleanup();
      const cleanup = effect();
      entry.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    }
  };

  return {
    React,
    mount(Component, props) {
      let tree = null;
      const pass = () => {
        dirty = false;
        queued = [];
        seq = 0;
        current = null;
        cursor = 0;
        tree = renderNode(React.createElement(Component, props), 'root');
        flush();
      };
      let guard = 0;
      do pass(); while (dirty && (guard += 1) < 12);
      return {
        get tree() { return tree; },
        rerender(next) {
          if (next !== undefined) props = next;
          let loop = 0;
          do pass(); while (dirty && (loop += 1) < 12);
          return tree;
        },
      };
    },
  };
}

/* ---------------------------------------------------------------- bundle */

function loadBundle(React) {
  let definition = null;
  const sandbox = { window: { __ModuleLoader__: { load: (loaded) => { definition = loaded; } } }, AbortController, console };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'client.js' });
  return definition.factory((name) => {
    if (name === 'react') return React;
    throw new Error(`unexpected require: ${name}`);
  });
}

const DICT = {
  zh: {
    label: '回答詳略',
    hint: '只影響接下來這一輪：Agent 處理本會話時採用目前檔位。單次固定請用「釘住本則」；檔位不會改動你的草稿。',
    level1: '極簡', level2: '精簡', level3: '標準', level4: '深入', level5: '完整剖析',
    value: '{name} · {level}/5',
    unknown: '—',
    syncing: '儲存中…',
    unavailable: '不可用',
    error: '同步失敗',
    'error.badResponse': '主機回覆未確認這個等級。',
    'error.unknownCommand': '此會話沒有 /output-detail 指令。',
    'error.transport': '詳略請求失敗。',
  },
  en: {
    label: 'Response detail',
    hint: 'Applies to the next reply while the Agent processes this session. Pick a level once; use pin to fix one message. The level never edits your draft.',
    level1: 'Minimal', level2: 'Brief', level3: 'Standard', level4: 'Detailed', level5: 'Most detailed',
    value: '{name} · {level}/5',
    unknown: '—',
    syncing: 'Saving…',
    unavailable: 'Unavailable',
    error: 'Sync failed',
    'error.badResponse': 'The Host reply did not confirm this level.',
    'error.unknownCommand': 'The /output-detail command is not available in this session.',
    'error.transport': 'The detail-level request failed.',
  },
};

function translate(lang, key, params) {
  const dict = DICT[lang];
  const direct = {};
  for (const key of ['error.badResponse', 'error.unknownCommand', 'error.transport']) {
    direct[key] = dict[key];
  }
  const map = {
    ...direct,
    label: dict.label,
    hint: dict.hint,
    'level.1': dict.level1,
    'level.2': dict.level2,
    'level.3': dict.level3,
    'level.4': dict.level4,
    'level.5': dict.level5,
    value: dict.value,
    unknown: dict.unknown,
    'status.syncing': dict.syncing,
    'status.unavailable': dict.unavailable,
    'status.error': dict.error,
  };
  const template = map[key] ?? dict[key] ?? key;
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/gu, (match, name) => (name in params ? String(params[name]) : match));
}

/* ---------------------------------------------------------------- states */

function makeSeat(runtime, bundle, spec) {
  const registration = { component: null };
  const locale = {
    register: () => () => {},
    bind: () => (key, params) => translate(spec.lang, key, params),
    subscribe: () => () => {},
    getSnapshot: () => 0,
  };
  let remote = spec.remote;
  const ctx = {
    locale,
    effect: (fn) => fn(),
    slots: {
      register: (options, component) => {
        registration.component = component;
        return () => {};
      },
      inject: (_key, factory) => { factory(); return () => {}; },
    },
    remote: { commands: { execute: (...args) => remote(...args) } },
  };
  bundle.apply(ctx);

  const props = {
    sessionId: 'preview',
    executeLevel: (level) => remote(level),
    localeFace: locale,
    t: locale.bind(),
    useProjection: () => spec.projection,
    readOnly: spec.readOnly,
  };
  const mounted = runtime.mount(registration.component, props);
  return { mounted };
}

function pick(mounted, level) {
  const walk = (node, predicate, out = []) => {
    if (node === null || node === undefined) return out;
    if (Array.isArray(node)) { for (const child of node) walk(child, predicate, out); return out; }
    if (predicate(node)) out.push(node);
    if (node.props) walk(node.props.children, predicate, out);
    return out;
  };
  const step = walk(mounted.tree, (node) => node.type === 'button' && node.props && node.props['data-level'] === level)[0];
  step.props.onClick();
}

/* ---------------------------------------------------------------- html */

const ATTRIBUTE_ALIASES = {
  className: 'class',
  htmlFor: 'for',
  tabIndex: 'tabindex',
  strokeWidth: 'stroke-width',
  strokeLinecap: 'stroke-linecap',
  strokeLinejoin: 'stroke-linejoin',
  fillRule: 'fill-rule',
  clipRule: 'clip-rule',
};

function escapeText(value) {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

function styleString(style) {
  return Object.entries(style)
    .map(([name, value]) => `${name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}:${value}`)
    .join(';');
}

function serialize(node, indent = '') {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map((child) => serialize(child, indent)).join('');
  if (node.type === '#text') return escapeText(node.text);
  const attributes = [];
  for (const [name, value] of Object.entries(node.props || {})) {
    if (name === 'children' || value === undefined || value === null) continue;
    if (name.startsWith('on') && typeof value === 'function') continue;
    if (name === 'style' && typeof value === 'object') {
      attributes.push(`style="${escapeText(styleString(value))}"`);
      continue;
    }
    if (value === false) continue;
    if (value === true) {
      attributes.push(name);
      continue;
    }
    const attribute = ATTRIBUTE_ALIASES[name] ?? name;
    attributes.push(`${attribute}="${escapeText(String(value))}"`);
  }
  const open = `<${node.type}${attributes.length ? ` ${attributes.join(' ')}` : ''}>`;
  const inner = serialize(node.props?.children, indent);
  if (inner === '') return `${open}</${node.type}>`;
  return `${open}${inner}</${node.type}>`;
}

/* ---------------------------------------------------------------- build */

const CSS_START = SOURCE.indexOf('/* dsh-output-detail:control-css */');
const CSS_END = SOURCE.indexOf('/* end dsh-output-detail:control-css */');
if (CSS_START < 0 || CSS_END < 0) throw new Error('control stylesheet markers not found');
const CONTROL_CSS = SOURCE.slice(CSS_START, CSS_END)
  .split('\n')
  .filter((line) => !line.includes('dsh-output-detail:control-css'))
  .map((line) => line.replace(/^      '/u, '').replace(/',$/u, ''))
  .join('\n');

const okReply = (level) => async () => ({
  ok: true,
  value: { commandId: 'preview', result: { kind: 'success', text: JSON.stringify({ plugin: 'dsh-output-detail', version: 1, status: 'ok', mode: 'best-effort', promptVersion: 1, action: 'set', level }) } },
});

const SHOTS = [
  {
    id: 'idle',
    title: '標準檔位（預設）',
    note: '未同步時不顯示狀態文字，靠檔位名稱承載資訊；每次點擊直接送命令，畫面只跟主機投影。',
    lang: 'zh',
    projection: { level: 3 },
    remote: okReply(3),
  },
  {
    id: 'top',
    title: '最高檔位',
    note: '五格計量到頂；名稱仍在同一列，不會換行。',
    lang: 'zh',
    projection: { level: 5 },
    remote: okReply(5),
  },
  {
    id: 'syncing',
    title: '儲存中',
    note: '尚未回覆時顯示短狀態；計量條降透明度但檔位名稱保留。',
    lang: 'zh',
    projection: { level: 3 },
    remote: () => new Promise(() => {}),
    pick: 4,
  },
  {
    id: 'error',
    title: '同步失敗',
    note: '短標籤＋錯誤色；完整訊息在 title 與 aria-label，不撐開工具列。',
    lang: 'zh',
    projection: { level: 3 },
    remote: async () => ({ ok: false, error: { code: 'E_DENIED', message: '沒有權限變更此會話的回答詳略。' } }),
    pick: 4,
  },
  {
    id: 'unavailable',
    title: '不可用（無投影）',
    note: '沒有主機投影時不假裝停在 3 級：檔位顯示破折號、五格全灰。',
    lang: 'zh',
    projection: undefined,
    remote: okReply(3),
  },
  {
    id: 'english',
    title: 'English',
    note: '同一元件、同一間距，只換字串。',
    lang: 'en',
    projection: { level: 2 },
    remote: okReply(2),
  },
];

function walk(node, predicate, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) { for (const child of node) walk(child, predicate, out); return out; }
  if (predicate(node)) out.push(node);
  if (node.props) walk(node.props.children, predicate, out);
  return out;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function renderShot(shot) {
  const runtime = createRuntime();
  const bundle = loadBundle(runtime.React);
  const { mounted } = makeSeat(runtime, bundle, shot);
  if (shot.pick !== undefined) {
    pick(mounted, shot.pick);
    mounted.rerender();
    await tick();
    await tick();
    mounted.rerender();
  }
  return serialize(mounted.tree);
}

const rendered = [];
for (const shot of SHOTS) rendered.push(await renderShot(shot));
const panels = SHOTS.map((shot, index) => {
  const markup = rendered[index];
  return `<section class="state" data-state="${shot.id}">
  <header><h2>${shot.title}</h2><code>${shot.id}</code></header>
  <div class="row"><div class="strip"><span class="fake icon">+</span><span class="fake">權限</span>${markup}</div></div>
  <p>${shot.note}</p>
</section>`;
}).join('\n');

const page = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<title>dsh-output-detail · composer control preview</title>
<style>
:root{
  --dsw-static-neutral-bluish-00:#fff;--dsw-static-neutral-bluish-50:#f9fafb;--dsw-static-neutral-bluish-60:#f5f6f7;
  --dsw-static-neutral-bluish-75:#f1f3f5;--dsw-static-neutral-bluish-100:#ebeef2;--dsw-static-neutral-bluish-200:#e1e5ee;
  --dsw-static-neutral-bluish-300:#cfd3d6;--dsw-static-neutral-bluish-400:#adb2b8;--dsw-static-neutral-bluish-500:#979da6;
  --dsw-static-neutral-bluish-600:#81858c;--dsw-static-neutral-bluish-700:#61666b;--dsw-static-neutral-bluish-750:#43454a;
  --dsw-static-neutral-bluish-875:#232324;--dsw-static-neutral-bluish-950:#151517;--dsw-static-neutral-bluish-1000:#0f1115;
  --dsw-static-red-400:#f25a5a;--dsw-static-red-600:#ec1313;
  --dsw-alias-bg-base:var(--dsw-static-neutral-bluish-00);
  --dsw-alias-bg-layer-1:var(--dsw-static-neutral-bluish-00);
  --dsw-alias-bg-layer-2:var(--dsw-static-neutral-bluish-50);
  --dsw-alias-border-l1:#0000000a;--dsw-alias-border-l2:#0000001a;--dsw-alias-border-l4:#00000026;
  --dsw-alias-label-primary:var(--dsw-static-neutral-bluish-1000);
  --dsw-alias-label-secondary:var(--dsw-static-neutral-bluish-700);
  --dsw-alias-label-tertiary:var(--dsw-static-neutral-bluish-600);
  --dsw-alias-label-caption:var(--dsw-static-neutral-bluish-400);
  --dsw-alias-brand-primary:var(--dsw-static-neutral-bluish-1000);
  --dsw-alias-state-error-primary:var(--dsw-static-red-600);
  --dsw-alias-interactive-bg-hover:#2631480f;--dsw-alias-interactive-bg-active:#2631481a;
  --dsw-radius-sm:8px;
}
[data-theme="dark"]{
  --dsw-alias-bg-base:var(--dsw-static-neutral-bluish-950);
  --dsw-alias-bg-layer-1:var(--dsw-static-neutral-bluish-875);
  --dsw-alias-bg-layer-2:var(--dsw-static-neutral-bluish-875);
  --dsw-alias-border-l1:#ffffff0f;--dsw-alias-border-l2:#ffffff1f;--dsw-alias-border-l4:#ffffff33;
  --dsw-alias-label-primary:var(--dsw-static-neutral-bluish-50);
  --dsw-alias-label-secondary:var(--dsw-static-neutral-bluish-300);
  --dsw-alias-label-tertiary:var(--dsw-static-neutral-bluish-400);
  --dsw-alias-label-caption:var(--dsw-static-neutral-bluish-600);
  --dsw-alias-brand-primary:var(--dsw-static-neutral-bluish-50);
  --dsw-alias-state-error-primary:var(--dsw-static-red-400);
  --dsw-alias-interactive-bg-hover:#ffffff14;--dsw-alias-interactive-bg-active:#ffffff24;
}
*{box-sizing:border-box}
body{margin:0;padding:32px 36px 64px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font-family:system-ui,-apple-system,"Segoe UI","Noto Sans TC",sans-serif;font-size:13px;line-height:1.5}
h1{font-size:18px;font-weight:500;margin:0 0 4px}
.lede{color:var(--dsw-alias-label-secondary);max-width:70ch;margin:0 0 24px}
.controls{display:flex;gap:8px;margin:0 0 24px}
.controls button{font:inherit;padding:4px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);
  background:transparent;color:inherit;cursor:pointer}
.controls button[aria-pressed="true"]{background:var(--dsw-alias-interactive-bg-active)}
.state{padding:16px 0 20px;border-top:1px solid var(--dsw-alias-border-l1)}
.state header{display:flex;align-items:baseline;gap:8px;margin:0 0 10px}
.state h2{font-size:13px;font-weight:500;margin:0}
.state code{font-size:11px;color:var(--dsw-alias-label-caption)}
.state p{color:var(--dsw-alias-label-secondary);margin:8px 0 0;max-width:76ch}
.row{display:flex;align-items:center;gap:10px;min-height:38px}
/* A composer-like strip: the toolbar the control actually lives in. */
.strip{display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:12px;
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.fake{display:inline-flex;align-items:center;justify-content:center;height:26px;padding:0 8px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px}
.fake.icon{width:26px;padding:0}
${CONTROL_CSS}
/* Forced interaction states, preview only: a static page cannot hover. */
.demo-hover .dsh-od__step:nth-child(4){background:var(--dsw-alias-interactive-bg-hover)}
.demo-focus .dsh-od__step[aria-checked="true"]{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
</style>
</head>
<body>
<h1>回答詳略控制 · composer strip 預覽</h1>
<p class="lede">由 <code>client.js</code> 的實際 bundle 渲染（同一份 CSS、同一份 DOM），只把宿主主題變數換成本機取樣值。左側兩個假元件示意工具列中相鄰的 <code>+</code> 與權限控制；頁面本身以 3x 像素密度截圖，所以細部可直接看。</p>
<div class="controls">
  <button type="button" id="theme" aria-pressed="false">切換深色主題</button>
</div>
<div id="sheet">
${panels}
<section class="state" data-state="interaction">
  <header><h2>hover / focus 狀態</h2><code>interaction</code></header>
  <div class="row"><div class="strip demo-hover"><span class="fake icon">+</span><span class="fake">權限</span>${rendered[0]}</div></div>
  <div class="row"><div class="strip demo-focus"><span class="fake icon">+</span><span class="fake">權限</span>${rendered[0]}</div></div>
  <p>左：第 4 格滑過（背景提亮）。右：鍵盤聚焦在選取格（品牌色描邊，與主機按鈕一致）。</p>
</section>
</div>
<script>
const params = new URLSearchParams(location.search);
if (params.get('only')) {
  const wanted = new Set(params.get('only').split(','));
  for (const section of document.querySelectorAll('[data-state]')) {
    if (!wanted.has(section.dataset.state)) section.remove();
  }
  const lede = document.querySelector('.lede');
  if (lede) lede.remove();
}
if (params.get('theme') === 'dark') {
  document.body.dataset.theme = 'dark';
}
const button = document.getElementById('theme');
button.addEventListener('click', () => {
  const dark = document.body.dataset.theme !== 'dark';
  document.body.dataset.theme = dark ? 'dark' : 'light';
  button.setAttribute('aria-pressed', String(dark));
  button.textContent = dark ? '切換淺色主題' : '切換深色主題';
});
</script>
</body>
</html>
`;

fs.mkdirSync(path.join(ROOT, 'demo'), { recursive: true });
const target = path.join(ROOT, 'demo', 'preview.html');
fs.writeFileSync(target, page, 'utf8');
console.log(`wrote ${path.relative(ROOT, target)} (${page.length} bytes, ${SHOTS.length} states)`);
