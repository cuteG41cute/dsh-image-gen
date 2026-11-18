// dsh-image-gen — Client half.
//
// One slot: conversation.session.header.utilities -> 「生图」chip with the panel.
// Panel: provider list (add/edit/delete), default provider/model dropdowns,
// quick test (prompt → inline preview + saved path), save button + status line.
// Config is the single source of truth on the host (~/.dsh/image-gen-config.json,
// global — shared by all windows/projects); fetched at startup via get-config.
window.__ModuleLoader__.load({
  id: 'dsh-image-gen',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    let react = require('react');

    let config = null;          // 宿主持久配置（providers/defaultProvider/defaultModel/outputDir）
    const listeners = new Set();
    function notify() { listeners.forEach((fn) => { try { fn(config); } catch { /* ignore */ } }); }
    function subscribe(fn) { listeners.add(fn); fn(config); return () => listeners.delete(fn); }

    function rpc(method, args) {
      return fetch('/dsh-image/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, args: args || {} }),
      }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e && e.message !== undefined ? e.message : e) }));
    }
    rpc('get-config', {}).then((r) => {
      if (r && r.ok === true && r.config && typeof r.config === 'object') { config = r.config; notify(); }
    }).catch(() => { });

    /* ----------------------------- 样式（与 dsh-tts 面板一致） ----------------------------- */
    const chipStyle = {
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px',
      borderRadius: 999, border: '1px solid var(--dsw-alias-divider, rgba(128,128,128,0.35))',
      background: 'transparent', color: 'var(--dsw-alias-label-secondary, #8a8a8a)',
      fontSize: 12, lineHeight: '18px', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
    };
    const cardStyle = {
      position: 'fixed', top: 54, right: 14, zIndex: 60, width: 420, maxWidth: 'calc(100vw - 28px)',
      maxHeight: 'calc(100vh - 90px)', overflow: 'auto', padding: '12px 14px',
      borderRadius: 12, border: '1px solid var(--dsw-alias-divider, rgba(128,128,128,0.35))',
      background: 'var(--dsw-alias-bg-raised, #ffffff)',
      color: 'var(--dsw-alias-label-primary, #222)',
      boxShadow: '0 12px 32px rgba(0,0,0,0.22)', fontSize: 12, lineHeight: '18px',
      fontFamily: 'inherit',
    };
    const fieldStyle = { width: '100%', boxSizing: 'border-box', marginTop: 3, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit', borderRadius: 8, border: '1px solid var(--dsw-alias-divider, rgba(128,128,128,0.4))', background: 'transparent', color: 'inherit' };
    const labelStyle2 = { display: 'block', marginTop: 9, color: 'var(--dsw-alias-label-tertiary, #8a8a8a)' };
    const icon = () => react.createElement('svg', {
      width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, stroke: 'currentColor',
    }, [
      react.createElement('rect', { key: 'r', x: 1.5, y: 2.5, width: 13, height: 11, rx: 2, strokeLinejoin: 'round' }),
      react.createElement('circle', { key: 'c', cx: 5.5, cy: 6.5, r: 1.4, fill: 'currentColor', stroke: 'none' }),
      react.createElement('path', { key: 'm', d: 'M3 12l3.2-3 2.3 2 2.5-2.5L13.5 11', strokeLinejoin: 'round', strokeLinecap: 'round' }),
    ]);

    /* ----------------------------- 设置面板 ----------------------------- */
    function SettingsPanel(props) {
      const [draft, setDraft] = react.useState(config ? JSON.parse(JSON.stringify(config)) : null);
      const [note, setNote] = react.useState('');
      const [noteOk, setNoteOk] = react.useState(true);
      const [testing, setTesting] = react.useState(false);
      const [preview, setPreview] = react.useState(null); // { path, url } 或 { error }
      const [editIdx, setEditIdx] = react.useState(-1);   // 正在编辑的 provider 下标，-1=折叠
      react.useEffect(() => subscribe((c) => {
        if (c && editIdx === -1) setDraft(JSON.parse(JSON.stringify(c)));
      }), [editIdx]);
      if (!draft) return react.createElement('div', { style: cardStyle }, [
        react.createElement('div', { key: 'h', style: { display: 'flex', justifyContent: 'space-between' } }, [
          react.createElement('strong', { key: 't', style: { fontSize: 13 } }, '生图设置'),
          react.createElement('button', { key: 'c', onClick: props.close, style: chipStyle }, '关闭'),
        ]),
        react.createElement('div', { key: 'l', style: { marginTop: 8, color: 'var(--dsw-alias-label-tertiary, #8a8a8a)' } }, '加载配置中…'),
      ]);
      const upd = (fn) => setDraft(fn(JSON.parse(JSON.stringify(draft))));
      const testProvider = draft.providers.find((p) => p.name === draft.defaultProvider);
      const save = () => {
        rpc('save-config', { config: draft }).then((r) => {
          setNoteOk(!!(r && r.ok));
          setNote(r && r.ok ? '已保存到 ~/.dsh/image-gen-config.json（全局，所有窗口/项目共用）' : '保存失败：' + ((r && r.error) || 'unknown'));
          if (r && r.ok && r.config) setDraft(JSON.parse(JSON.stringify(r.config)));
        });
      };
      const runTest = () => {
        const prompt = String((document.getElementById('dsh-image-test-prompt') || {}).value || '').trim();
        if (prompt === '') { setNoteOk(false); setNote('请先输入测试提示词'); return; }
        save();
        setTesting(true); setNoteOk(true); setNote('生成中…（最长 180 秒）'); setPreview(null);
        rpc('generate', {
          prompt,
          provider: draft.defaultProvider,
          model: draft.defaultModel || (testProvider && testProvider.models[0]) || undefined,
        }).then((r) => {
          setTesting(false);
          if (r && r.ok) {
            setNoteOk(true);
            setNote('已生成 ✓ ' + (r.bytes ? Math.round(r.bytes / 1024) + ' KB · ' : '') + r.model);
            setPreview({ path: r.path, url: r.url });
          } else {
            setNoteOk(false);
            setNote('失败：' + ((r && r.error) || 'unknown'));
          }
        });
      };
      return react.createElement('div', { style: cardStyle }, [
        react.createElement('div', { key: 'h', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } }, [
          react.createElement('strong', { key: 't', style: { fontSize: 13 } }, '生图设置（OpenAI 兼容 /images/generations）'),
          react.createElement('button', { key: 'c', onClick: props.close, style: Object.assign({}, chipStyle, { padding: '2px 8px' }) }, '关闭'),
        ]),
        // —— Provider 列表 ——
        react.createElement('div', { key: 'plist', style: { marginTop: 8 } }, draft.providers.map((p, i) => react.createElement('div', {
          key: p.name + i, style: { border: '1px solid var(--dsw-alias-divider, rgba(128,128,128,0.3))', borderRadius: 8, padding: '6px 8px', marginTop: 5 },
        }, [
          react.createElement('div', { key: 'row', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 } }, [
            react.createElement('span', { key: 'n', style: { fontWeight: 600 } }, p.name + '  '),
            react.createElement('span', { key: 'd', style: { color: 'var(--dsw-alias-label-tertiary, #8a8a8a)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, p.baseURL + ' · ' + (p.models || []).length + ' 模型'),
            react.createElement('button', { key: 'e', onClick: () => setEditIdx(editIdx === i ? -1 : i), style: Object.assign({}, chipStyle, { padding: '1px 7px' }) }, editIdx === i ? '收起' : '编辑'),
            react.createElement('button', {
              key: 'x', onClick: () => upd((d) => { d.providers.splice(i, 1); if (d.defaultProvider === p.name && d.providers.length) { d.defaultProvider = d.providers[0].name; d.defaultModel = (d.providers[0].models || [])[0] || ''; } }), style: Object.assign({}, chipStyle, { padding: '1px 7px', color: 'var(--dsw-alias-state-error-primary, #d92d20)' }),
            }, '删除'),
          ]),
          editIdx === i ? react.createElement('div', { key: 'edit' }, [
            react.createElement('label', { style: labelStyle2 }, '名称'),
            react.createElement('input', { style: fieldStyle, value: p.name, onChange: (e) => upd((d) => { d.providers[i].name = e.target.value; }) }),
            react.createElement('label', { style: labelStyle2 }, 'BaseURL'),
            react.createElement('input', { style: fieldStyle, value: p.baseURL, placeholder: 'https://api.example.com/v1', onChange: (e) => upd((d) => { d.providers[i].baseURL = e.target.value; }) }),
            react.createElement('label', { style: labelStyle2 }, 'API Key'),
            react.createElement('input', { style: fieldStyle, value: p.apiKey || '', placeholder: 'sk-…', onChange: (e) => upd((d) => { d.providers[i].apiKey = e.target.value; }) }),
            react.createElement('label', { style: labelStyle2 }, '模型列表（逗号分隔）'),
            react.createElement('input', { style: fieldStyle, value: (p.models || []).join(', '), placeholder: 'model-a, model-b', onChange: (e) => upd((d) => { d.providers[i].models = e.target.value.split(',').map((s) => s.trim()).filter((s) => s !== ''); }) }),
          ]) : null,
        ]))),
        react.createElement('button', {
          key: 'add', onClick: () => { upd((d) => d.providers.push({ name: 'new-provider', baseURL: 'https://api.example.com/v1', apiKey: '', models: [] })); setEditIdx(draft.providers.length); },
          style: Object.assign({}, chipStyle, { marginTop: 8 }),
        }, '＋ 添加 Provider'),
        // —— 默认 provider / model ——
        react.createElement('div', { key: 'defs', style: { display: 'flex', gap: 8 } }, [
          react.createElement('div', { key: 'c1', style: { flex: 1 } }, [
            react.createElement('label', { style: labelStyle2 }, '默认 Provider'),
            react.createElement('select', {
              style: fieldStyle, value: draft.defaultProvider,
              onChange: (e) => upd((d) => { d.defaultProvider = e.target.value; const np = d.providers.find((p) => p.name === e.target.value); d.defaultModel = (np && np.models && np.models[0]) || ''; }),
            }, draft.providers.map((p, i) => react.createElement('option', { key: p.name + i, value: p.name }, p.name))),
          ]),
          react.createElement('div', { key: 'c2', style: { flex: 1 } }, [
            react.createElement('label', { style: labelStyle2 }, '默认模型'),
            react.createElement('select', {
              style: fieldStyle, value: draft.defaultModel || '',
              onChange: (e) => upd((d) => { d.defaultModel = e.target.value; }),
            }, (testProvider && testProvider.models || []).map((m) => react.createElement('option', { key: m, value: m }, m))),
          ]),
        ]),
        // —— 快速测试 ——
        react.createElement('label', { key: 'lt', style: labelStyle2 }, '快速测试（提示词）'),
        react.createElement('textarea', { key: 't-in', id: 'dsh-image-test-prompt', rows: 2, style: fieldStyle, defaultValue: '一只戴宇航员头盔的柴犬，扁平插画风格', onChange: (e) => { /* 保留用户输入 */ } }),
        react.createElement('div', { key: 'btns', style: { display: 'flex', gap: 8, marginTop: 10 } }, [
          react.createElement('button', { key: 'g', onClick: runTest, disabled: testing, style: Object.assign({}, chipStyle, { color: 'var(--dsw-static-deepseek-500, #4d6bfe)', borderColor: 'currentColor' }) }, testing ? '生成中…' : '生成测试图'),
          react.createElement('button', { key: 's', onClick: save, style: Object.assign({}, chipStyle, { padding: '2px 8px' }) }, '保存配置'),
        ]),
        // —— 预览 + 状态 ——
        preview && preview.url && /^https?:/.test(preview.url) ? react.createElement('img', {
          key: 'img', src: preview.url, alt: '生成的测试图',
          style: { display: 'block', marginTop: 10, maxWidth: '100%', maxHeight: 220, borderRadius: 8, border: '1px solid var(--dsw-alias-divider, rgba(128,128,128,0.35))' },
        }) : null,
        preview && preview.path ? react.createElement('div', { key: 'p', style: { marginTop: 6, wordBreak: 'break-all', color: 'var(--dsw-alias-label-tertiary, #8a8a8a)' } }, '已保存：' + preview.path) : null,
        note !== '' ? react.createElement('div', { key: 'n', style: { marginTop: 8, color: noteOk ? 'var(--dsw-alias-label-tertiary, #8a8a8a)' : 'var(--dsw-alias-state-error-primary, #d92d20)', wordBreak: 'break-all' } }, note) : null,
      ]);
    }

    /* ----------------------------- 头部「生图」芯片 ----------------------------- */
    function ImageGenChip(props) {
      const [open, setOpen] = react.useState(false);
      const [, setTick] = react.useState(0);
      react.useEffect(() => subscribe(() => setTick((t) => t + 1)), []);
      const status = !config ? '加载中' : '就绪';
      return react.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, position: 'relative' } }, [
        react.createElement('button', {
          key: 'chip', className: 'dsh-image-gen-chip',
          onClick: () => setOpen(!open),
          title: '生图（image-gen）：' + status + '。点开配置 Provider / 模型，或快速生成一张测试图。',
          style: Object.assign({}, chipStyle, open ? {
            color: 'var(--dsw-static-deepseek-500, #4d6bfe)',
            borderColor: 'currentColor',
            background: 'color-mix(in srgb, var(--dsw-static-deepseek-500, #4d6bfe) 10%, transparent)',
          } : null),
        }, [
          react.createElement('span', { key: 'i', style: { display: 'inline-flex' } }, icon()),
          react.createElement('span', { key: 't' }, '生图'),
        ]),
        open ? react.createElement(SettingsPanel, { key: 'panel', close: () => setOpen(false) }) : null,
      ]);
    }

    /* ----------------------------- 装配（与 dsh-tts 相同的 slot 机制） ----------------------------- */
    function apply(ctx) {
      const slots = ctx.get('slots');
      if (slots === undefined) return;
      slots.inject('conversation.session.header.utilities', () => slots.register(
        { name: 'conversation.session.header.utilities', id: 'dsh-image-gen-chip', order: 13 },
        (props) => ImageGenChip(props),
      ));
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    window.__dshImageGen = {
      config: () => config,
      generate: (prompt, extra) => rpc('generate', Object.assign({ prompt }, extra || {})),
      list: () => rpc('list', {}),
    };
    return module.exports;
  },
});
