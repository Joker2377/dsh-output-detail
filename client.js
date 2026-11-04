window.__ModuleLoader__.load({
  id: 'dsh-output-detail',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace and projection key owned by this plugin. */
    const NS = 'output-detail';
    const PROJECTION_KEY = 'output-detail';
    const SLOT = 'conversation.input.left';
    const COMMAND = 'output-detail';
    const PLUGIN_ID = 'dsh-output-detail';

    const MIN_LEVEL = 1;
    const MAX_LEVEL = 5;
    const DEFAULT_LEVEL = 3;
    const LEVEL_NUMBERS = Object.freeze([1, 2, 3, 4, 5]);
    /** Style tag identity, so a stale copy from a previous load is reused. */
    const STYLE_KEY = 'dsh-output-detail/control.css';

    const EN = Object.freeze({
      label: 'Response detail',
      hint: 'Applies to the replies this session processes next. The control never edits your draft.',
      'level.1': 'Minimal',
      'level.2': 'Brief',
      'level.3': 'Standard',
      'level.4': 'Detailed',
      'level.5': 'Most detailed',
      value: '{name} · {level}/5',
      unknown: '—',
      'status.syncing': 'Saving…',
      'status.error': 'Sync failed',
      'status.unavailable': 'Unavailable',
      'error.badResponse': 'The Host reply did not confirm this level.',
      'error.unknownCommand': 'The /output-detail command is not available in this session.',
      'error.transport': 'The detail-level request failed.',
    });

    const ZH = Object.freeze({
      label: '回答詳略',
      hint: '只影響本會話接下來處理的回覆；控制項不會改動你的草稿。',
      'level.1': '極簡',
      'level.2': '精簡',
      'level.3': '標準',
      'level.4': '深入',
      'level.5': '完整剖析',
      value: '{name} · {level}/5',
      unknown: '—',
      'status.syncing': '儲存中…',
      'status.error': '同步失敗',
      'status.unavailable': '不可用',
      'error.badResponse': '主機回覆未確認這個等級。',
      'error.unknownCommand': '此會話沒有 /output-detail 指令。',
      'error.transport': '詳略請求失敗。',
    });

    /**
     * Component styles. The Host renders the composer as a strip of small
     * controls, so this control is one compact row: label, a five-step meter,
     * the current level name, and a transient status. Only design-token colours
     * are used so the control follows the Host theme.
     */
    const CONTROL_CSS = [
      '/* dsh-output-detail:control-css */',
      '.dsh-od{display:inline-flex;align-items:center;gap:2px;height:26px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;max-width:100%;overflow:hidden}',
      '.dsh-od__label{margin:0 4px 0 0;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dsh-od__meter{display:inline-flex;align-items:center;gap:2px;margin:0;padding:0;border:0}',
      '.dsh-od__step{display:inline-flex;align-items:flex-end;justify-content:center;width:15px;height:22px;padding:0 0 3px;border:0;border-radius:4px;background:transparent;cursor:pointer;transition:background-color .12s ease}',
      '.dsh-od__step:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-od__step:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dsh-od__step:disabled{cursor:default}',
      '.dsh-od__bar{display:block;width:9px;border-radius:2px;background:var(--dsw-alias-label-caption)}',
      '.dsh-od__step[data-on="true"] .dsh-od__bar{background:var(--dsw-alias-brand-primary)}',
      '.dsh-od__step[aria-checked="true"] .dsh-od__bar{width:11px}',
      '.dsh-od__value{max-width:6.5em;margin-left:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}',
      '.dsh-od__status{max-width:8em;margin-left:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
      '.dsh-od__status[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}',
      '.dsh-od[data-sync="unavailable"]{color:var(--dsw-alias-label-secondary)}',
      '.dsh-od[data-sync="unavailable"] .dsh-od__value{color:var(--dsw-alias-label-secondary)}',
      '.dsh-od[data-sync="syncing"] .dsh-od__meter{opacity:.72}',
      '.dsh-od[data-sync="syncing"] .dsh-od__value{color:var(--dsw-alias-label-secondary)}',
      '/* end dsh-output-detail:control-css */',
    ].join('\n');

    /** Stable fallback face so hook order never depends on prop presence. */
    const EMPTY_FACE = Object.freeze({
      subscribe: () => () => {},
      getSnapshot: () => 0,
      bind: () => (key) => key,
    });

    const useStore = typeof React.useSyncExternalStore === 'function'
      ? React.useSyncExternalStore
      : function fallbackUseSyncExternalStore(subscribe, getSnapshot) {
        const [value, setValue] = React.useState(getSnapshot);
        React.useEffect(() => {
          setValue(getSnapshot);
          return subscribe(() => {
            setValue(getSnapshot);
          });
        }, [subscribe]);
        return value;
      };

    /* ---------------------------------------------------------------- *
     * Styles: injected once per page through a guarded, minimal DOM
     * touch. Without a DOM (tests, SSR) the control still renders and
     * behaves identically; only the visual layer is skipped.
     * ---------------------------------------------------------------- */

    let stylesInstalled = false;

    function injectStyles() {
      if (stylesInstalled) return;
      if (typeof document === 'undefined' || document === null) return;
      const head = document.head;
      if (head === null || head === undefined || typeof head.appendChild !== 'function') return;
      if (typeof document.createElement !== 'function') return;
      stylesInstalled = true;
      const selector = `style[data-dsh-style="${STYLE_KEY}"]`;
      if (typeof document.querySelector === 'function' && document.querySelector(selector) !== null) return;
      const tag = document.createElement('style');
      tag.setAttribute('data-dsh-style', STYLE_KEY);
      tag.textContent = CONTROL_CSS;
      head.appendChild(tag);
    }

    /** @param {unknown} value @returns {number|undefined} an integer 1..5, or undefined. */
    function normalizeLevel(value) {
      return typeof value === 'number' && Number.isInteger(value) && value >= MIN_LEVEL && value <= MAX_LEVEL
        ? value
        : undefined;
    }

    /** @param {unknown} projection @returns {number|undefined} the Host-confirmed level. */
    function readProjectionLevel(projection) {
      if (projection === null || typeof projection !== 'object') return undefined;
      return normalizeLevel(projection.level);
    }

    /**
     * Read the Host's message when the command settled as an error.
     * @param {unknown} execution @returns {string|undefined}
     */
    function commandFailureMessage(execution) {
      if (execution === null || typeof execution !== 'object') return undefined;
      const result = execution.result;
      if (result === null || typeof result !== 'object' || result.kind !== 'error') return undefined;
      if (typeof result.text !== 'string' || result.text === '') return undefined;
      try {
        const payload = JSON.parse(result.text);
        if (payload !== null && typeof payload === 'object' && typeof payload.message === 'string' && payload.message !== '') {
          return payload.message;
        }
      } catch {
        /* not our envelope: surface the raw text */
      }
      return result.text;
    }

    /**
     * Validate the settled command execution the Host returns.
     * @param {unknown} execution
     * @returns {{ level: number }|null}
     */
    function parseSuccessPayload(execution) {
      if (execution === null || typeof execution !== 'object') return null;
      const result = execution.result;
      if (result === null || typeof result !== 'object' || result.kind !== 'success') return null;
      if (typeof result.text !== 'string' || result.text.trim() === '') return null;
      let payload;
      try {
        payload = JSON.parse(result.text);
      } catch {
        return null;
      }
      if (payload === null || typeof payload !== 'object' || payload.plugin !== PLUGIN_ID) return null;
      if (payload.status !== 'ok' || payload.version !== 1 || payload.mode !== 'best-effort' || payload.promptVersion !== 1 || payload.action !== 'set') return null;
      const level = normalizeLevel(payload.level);
      if (level === undefined) return null;
      return { level };
    }

    /**
     * Locale-seat translate function: bound to the declared namespace and refreshed
     * through the locale service's own subscribe/getSnapshot pair.
     * @param {unknown} face @param {unknown} seatT
     * @returns {(key: string, params?: Record<string, unknown>) => string}
     */
    function useTranslate(face, seatT) {
      const activeFace = face !== null && typeof face === 'object' && typeof face.bind === 'function' ? face : EMPTY_FACE;
      const subscribe = React.useCallback((listener) => activeFace.subscribe(listener), [activeFace]);
      const getSnapshot = React.useCallback(() => {
        const snapshot = activeFace.getSnapshot();
        return snapshot !== null && typeof snapshot === 'object' ? snapshot.revision : snapshot;
      }, [activeFace]);
      const revision = useStore(subscribe, getSnapshot, getSnapshot);
      return React.useMemo(() => {
        if (activeFace === EMPTY_FACE) return typeof seatT === 'function' ? seatT : (key) => key;
        const translate = activeFace.bind(NS);
        return (key, params) => translate(key, params);
      }, [activeFace, revision, seatT]);
    }

    /**
     * Entry component: reads the session scope's projection when the framework
     * provides the hook, and degrades to an honest unavailable state when it
     * does not.
     * @param {Record<string, unknown>} props
     */
    function OutputDetailControl(props) {
      if (typeof props.useProjection === 'function') return h(SessionConnected, props);
      return h(DetailControl, props);
    }

    /** @param {Record<string, unknown>} props */
    function SessionConnected(props) {
      const projection = props.useProjection(PROJECTION_KEY);
      const { useProjection, ...rest } = props;
      return h(DetailControl, { ...rest, projection });
    }

    /**
     * The projection is the only stored selection. This component keeps no
     * level of its own: a step click sends the command and the meter follows
     * whatever the Host folds into the Session log. Only request bookkeeping
     * (in flight, last error) is local, because it is not selection state.
     *
     * @param {Record<string, unknown>} props
     */
    function DetailControl(props) {
      const { sessionId, projection, executeLevel, localeFace, t: seatT } = props;
      const t = useTranslate(localeFace, seatT);

      const level = readProjectionLevel(projection);
      const canExecute = typeof executeLevel === 'function';
      const supported = canExecute && sessionId !== undefined && level !== undefined && props.readOnly !== true;

      const [pending, setPending] = React.useState(0);
      const [failure, setFailure] = React.useState(null);

      const seqRef = React.useRef(0);
      const epochRef = React.useRef(0);
      const disposedRef = React.useRef(false);
      const translateRef = React.useRef(t);
      translateRef.current = t;

      React.useEffect(() => {
        epochRef.current += 1;
        seqRef.current += 1;
        setPending(0);
        setFailure(null);
      }, [sessionId]);

      React.useEffect(() => {
        disposedRef.current = false;
        return () => {
          disposedRef.current = true;
          epochRef.current += 1;
          seqRef.current += 1;
        };
      }, []);

      const change = React.useCallback(async (next) => {
        if (!supported || next === level) return;
        const seq = seqRef.current + 1;
        seqRef.current = seq;
        const epoch = epochRef.current;
        setFailure(null);
        setPending((count) => count + 1);
        let outcome;
        try {
          outcome = await executeLevel(next);
        } catch (error) {
          if (disposedRef.current || epoch !== epochRef.current) return;
          setPending((count) => Math.max(0, count - 1));
          if (seq === seqRef.current) {
            setFailure(error !== null && typeof error === 'object' && typeof error.message === 'string' && error.message !== ''
              ? error.message
              : translateRef.current('error.transport'));
          }
          return;
        }
        if (disposedRef.current || epoch !== epochRef.current) return;
        setPending((count) => Math.max(0, count - 1));
        if (seq !== seqRef.current) return;
        if (outcome === null || typeof outcome !== 'object' || outcome.ok !== true) {
          const detail = outcome !== null && typeof outcome === 'object' ? outcome.error : undefined;
          setFailure(detail !== null && typeof detail === 'object' && typeof detail.message === 'string' && detail.message !== ''
            ? detail.message
            : translateRef.current('error.transport'));
          return;
        }
        if (outcome.value === undefined || outcome.value === null) {
          setFailure(translateRef.current('error.unknownCommand'));
          return;
        }
        const payload = parseSuccessPayload(outcome.value);
        if (payload === null || payload.level !== next) {
          const message = commandFailureMessage(outcome.value);
          setFailure(message === undefined ? translateRef.current('error.badResponse') : message);
        }
      }, [supported, level, executeLevel]);

      const onStepClick = (next) => () => void change(next);

      const onStepKeyDown = (event) => {
        const key = event !== null && typeof event === 'object' ? event.key : undefined;
        if (typeof key !== 'string' || !supported) return;
        const current = level === undefined ? DEFAULT_LEVEL : level;
        let next;
        if (key === 'ArrowRight' || key === 'ArrowUp') next = Math.min(MAX_LEVEL, current + 1);
        else if (key === 'ArrowLeft' || key === 'ArrowDown') next = Math.max(MIN_LEVEL, current - 1);
        else if (key === 'Home') next = MIN_LEVEL;
        else if (key === 'End') next = MAX_LEVEL;
        else return;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        void change(next);
      };

      const syncState = !supported ? 'unavailable' : pending > 0 ? 'syncing' : failure !== null ? 'error' : 'idle';
      const statusText = !supported
        ? t('status.unavailable')
        : pending > 0
          ? t('status.syncing')
          : failure !== null
            ? t('status.error')
            : null;
      const statusDetail = failure !== null ? failure : undefined;

      const levelName = level === undefined ? t('unknown') : t(`level.${level}`);
      const valueText = level === undefined ? t('unknown') : t('value', { name: levelName, level });

      const steps = LEVEL_NUMBERS.map((step) => {
        const name = t(`level.${step}`);
        const caption = t('value', { name, level: step });
        const checked = level === step;
        return h('button', {
          key: `level-${step}`,
          type: 'button',
          role: 'radio',
          className: 'dsh-od__step',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': caption,
          'data-level': step,
          'data-on': level !== undefined && step <= level ? 'true' : 'false',
          tabIndex: checked ? 0 : -1,
          disabled: !supported,
          title: caption,
          onMouseDown: (event) => event.preventDefault(),
          onClick: onStepClick(step),
        }, h('span', {
          key: 'bar',
          className: 'dsh-od__bar',
          style: { height: `${4 + (step - 1) * 2.75}px` },
        }));
      });

      return h('div', {
        className: 'dsh-od',
        'data-dsh-output-detail': '',
        'data-level': level === undefined ? '' : level,
        'data-sync': syncState,
        title: t('hint'),
        style: { display: 'inline-flex' },
      }, [
        h('span', { key: 'label', className: 'dsh-od__label' }, t('label')),
        h('div', {
          key: 'meter',
          className: 'dsh-od__meter',
          role: 'radiogroup',
          'aria-label': t('label'),
          'aria-disabled': supported ? undefined : 'true',
          onKeyDown: onStepKeyDown,
        }, steps),
        h('span', {
          key: 'value',
          className: 'dsh-od__value',
          title: valueText,
        }, levelName),
        statusText === null ? null : h('span', {
          key: 'status',
          className: 'dsh-od__status',
          role: 'status',
          'aria-live': 'polite',
          'aria-label': statusDetail === undefined ? statusText : statusDetail,
          'data-tone': syncState === 'error' ? 'error' : 'muted',
          title: statusDetail === undefined ? statusText : statusDetail,
        }, statusText),
      ]);
    }

    /**
     * Register the dictionaries and the composer-bar control.
     * @param {Record<string, any>} ctx client root context.
     */
    function apply(ctx) {
      ctx.effect(() => {
        try {
          injectStyles();
        } catch {
          /* styling must never break the control */
        }
        return undefined;
      }, 'output-detail: control styles');
      ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'output-detail: dictionaries');
      ctx.effect(() => ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: PROJECTION_KEY,
        locale: NS,
        inject: (sessionId) => ({
          executeLevel: (next) => ctx.remote.commands.execute(sessionId, `/${COMMAND} ${next}`, []),
          localeFace: ctx.locale,
        }),
      }, OutputDetailControl)), 'output-detail: composer control');
    }

    return {
      inject: ['slots', 'remote', 'remote.commands', 'locale'],
      apply,
    };
  },
});
