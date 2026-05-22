/* ============================================================================
   T&C Portal — Tweaks panel (vanilla JS)
   Exposes a floating bottom-right panel with knobs for input/number fonts,
   sizes, and the global accent. Persists to localStorage. Also implements
   the host edit-mode protocol so the toolbar Tweaks toggle drives it.
   ============================================================================ */
(function () {
  const STORAGE_KEY = 'tc-tweaks-v1';

  const FONT_OPTIONS = {
    input: [
      { id: 'archivo',  label: 'Archivo',         stack: "'Archivo', system-ui, sans-serif" },
      { id: 'inter',    label: 'Inter',           stack: "'Inter', system-ui, sans-serif" },
      { id: 'plex',     label: 'IBM Plex Sans',   stack: "'IBM Plex Sans', system-ui, sans-serif" },
      { id: 'manrope',  label: 'Manrope',         stack: "'Manrope', system-ui, sans-serif" },
      { id: 'geist',    label: 'Geist',           stack: "'Geist', system-ui, sans-serif" },
      { id: 'jakarta',  label: 'Plus Jakarta',    stack: "'Plus Jakarta Sans', system-ui, sans-serif" },
      { id: 'system',   label: 'System UI',       stack: "-apple-system, system-ui, sans-serif" },
    ],
    number: [
      { id: 'archivo',  label: 'Archivo',         stack: "'Archivo', system-ui, sans-serif" },
      { id: 'mono',     label: 'Roboto Mono',     stack: "'Roboto Mono', ui-monospace, monospace" },
      { id: 'jet',      label: 'JetBrains Mono',  stack: "'JetBrains Mono', ui-monospace, monospace" },
      { id: 'inter',    label: 'Inter Tight',     stack: "'Inter Tight', 'Inter', system-ui, sans-serif" },
      { id: 'serif',    label: 'Newsreader (serif)', stack: "'Newsreader', Georgia, serif" },
      { id: 'fraunces', label: 'Fraunces (serif)',   stack: "'Fraunces', Georgia, serif" },
      { id: 'instr',    label: 'Instrument Serif', stack: "'Instrument Serif', Georgia, serif" },
    ],
  };

  // Inject Google Fonts not already loaded
  function ensureFontsLoaded() {
    if (document.getElementById('tweaks-extra-fonts')) return;
    const link = document.createElement('link');
    link.id = 'tweaks-extra-fonts';
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?' + [
      'family=Inter:wght@400;500;600;700',
      'family=Inter+Tight:wght@500;600;700',
      'family=IBM+Plex+Sans:wght@400;500;600;700',
      'family=Manrope:wght@400;500;600;700',
      'family=Geist:wght@400;500;600;700',
      'family=Plus+Jakarta+Sans:wght@400;500;600;700',
      'family=JetBrains+Mono:wght@400;500;600',
      'family=Newsreader:opsz,wght@6..72,500;6..72,600;6..72,700',
      'family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700',
      'family=Instrument+Serif:wght@400',
    ].join('&') + '&display=swap';
    document.head.appendChild(link);
  }

  const DEFAULTS = {
    inputFont:    'archivo',
    numberFont:   'archivo',
    inputSize:    14,
    inputWeight:  500,
    numberSize:   28,
    numberWeight: 600,
    trSubsys:     'mono',
    trStatus:     'mono-dot',
    trBar:        'thin',
  };

  let state = { ...DEFAULTS };
  // Clear any prior tweak overrides — Rail theme defaults win
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}

  // ---------- Test Register badge stamping ----------
  // Each subsystem name gets a stable 0-7 color bucket via a small hash,
  // and 2-letter initials, stamped onto .tag elements inside #test-register-content.
  function _hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i) | 0;
    return Math.abs(h);
  }
  function _initials(s) {
    if (!s) return '·';
    const cleaned = s.replace(/[^a-z0-9 ]/gi, ' ').trim();
    if (!cleaned) return s.slice(0, 2).toUpperCase();
    const parts = cleaned.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  function stampSubsysTags() {
    const root = document.getElementById('test-register-content');
    if (!root) return;
    root.querySelectorAll('.tag').forEach(el => {
      if (el.dataset.trColor !== undefined) return;
      const text = (el.textContent || '').trim();
      el.dataset.trColor = String(_hashStr(text) % 8);
      el.dataset.trInitials = _initials(text);
    });
  }
  // Re-stamp whenever the test-register content re-renders
  function watchTestRegister() {
    const target = document.getElementById('test-register-content');
    if (!target || target._twStamping) return;
    target._twStamping = true;
    stampSubsysTags();
    stampProgressRings();
    new MutationObserver(() => {
      stampSubsysTags();
      stampProgressRings();
    }).observe(target, { childList: true, subtree: true });
  }

  // Ring-style progress bar needs per-element % stamped as a CSS variable.
  // Reads width from .am-progress-fill style="width:NN%" and the fill color
  // from var(--good|--info|--gray-300) → maps to our dot palette.
  function stampProgressRings() {
    const root = document.getElementById('test-register-content');
    if (!root) return;
    root.querySelectorAll('.am-progress-wrap').forEach(wrap => {
      const fill = wrap.querySelector('.am-progress-fill');
      const bar  = wrap.querySelector('.am-progress-bar');
      if (!fill || !bar) return;
      // pct from width
      const w = (fill.style.width || '').trim();
      const pct = parseFloat(w) || 0;
      bar.style.setProperty('--ring-pct', pct);
      // map fill color
      const inline = fill.getAttribute('style') || '';
      let color = 'var(--info-dot)';
      if (inline.includes('var(--good)'))      color = 'var(--good-dot)';
      else if (inline.includes('var(--info)')) color = 'var(--info-dot)';
      else if (inline.includes('var(--gray-300)') || pct === 0) color = 'var(--gray-400)';
      bar.style.setProperty('--ring-color', color);
    });
  }

  function apply() {
    const r = document.documentElement.style;
    const inFont  = FONT_OPTIONS.input.find(o => o.id === state.inputFont)   || FONT_OPTIONS.input[0];
    const numFont = FONT_OPTIONS.number.find(o => o.id === state.numberFont) || FONT_OPTIONS.number[0];
    r.setProperty('--f-input',  inFont.stack);
    r.setProperty('--f-number', numFont.stack);
    r.setProperty('--input-size',    state.inputSize + 'px');
    r.setProperty('--input-weight',  state.inputWeight);
    r.setProperty('--number-size',   state.numberSize + 'px');
    r.setProperty('--number-weight', state.numberWeight);
    document.documentElement.dataset.trSubsys = state.trSubsys;
    document.documentElement.dataset.trStatus = state.trStatus;
    document.documentElement.dataset.trBar    = state.trBar;
    stampSubsysTags();
    stampProgressRings();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
    // refresh UI radio selections
    document.querySelectorAll('[data-tw-key]').forEach(el => {
      const k = el.dataset.twKey;
      if (el.dataset.twVal !== undefined) {
        el.classList.toggle('on', String(state[k]) === el.dataset.twVal);
      } else if (el.type === 'range' || el.type === 'number') {
        el.value = state[k];
      }
    });
    document.querySelectorAll('[data-tw-readout]').forEach(el => {
      el.textContent = state[el.dataset.twReadout];
    });
  }

  function setKey(k, v) {
    state[k] = v;
    apply();
  }

  function reset() {
    state = { ...DEFAULTS };
    apply();
  }

  // ---------- UI ----------
  function buildPanel() {
    if (document.getElementById('tc-tweaks')) return;

    const css = `
      #tc-tweaks {
        position: fixed; right: 18px; bottom: 18px;
        z-index: 99999;
        width: 320px;
        background: var(--white, #fff);
        border: 1px solid var(--gray-200, #ececef);
        border-radius: 14px;
        box-shadow: 0 18px 44px -16px rgba(15,17,21,0.22), 0 0 0 1px rgba(15,17,21,0.02);
        font-family: var(--f-ui, system-ui, sans-serif);
        color: var(--near-black, #131316);
        display: none;
        max-height: calc(100vh - 36px);
        overflow: hidden;
        flex-direction: column;
      }
      #tc-tweaks.open { display: flex; }
      #tc-tweaks .tw-head {
        display: flex; align-items: center; gap: 10px;
        padding: 12px 14px;
        border-bottom: 1px solid var(--gray-100, #f4f4f6);
        background: linear-gradient(180deg, #fff 0%, #fafaf8 100%);
        user-select: none;
      }
      #tc-tweaks .tw-dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: var(--hitachi-red, #e60012);
        box-shadow: 0 0 10px var(--hitachi-red, #e60012);
      }
      #tc-tweaks .tw-title {
        font-family: var(--f-mono, ui-monospace, monospace);
        font-size: 10.5px; font-weight: 600;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--near-black, #131316);
        flex: 1;
      }
      #tc-tweaks .tw-close,
      #tc-tweaks .tw-reset {
        background: none; border: none; cursor: pointer;
        padding: 4px 8px; border-radius: 6px;
        font-family: var(--f-mono, ui-monospace, monospace);
        font-size: 10.5px; font-weight: 500;
        letter-spacing: 0.08em; text-transform: uppercase;
        color: var(--gray-600, #74777f);
      }
      #tc-tweaks .tw-close:hover,
      #tc-tweaks .tw-reset:hover { background: var(--gray-100, #f4f4f6); color: var(--near-black, #131316); }
      #tc-tweaks .tw-body {
        padding: 10px 14px 14px;
        overflow-y: auto;
        display: flex; flex-direction: column; gap: 14px;
      }
      #tc-tweaks .tw-section {
        display: flex; flex-direction: column; gap: 6px;
      }
      #tc-tweaks .tw-section-title {
        font-family: var(--f-mono, ui-monospace, monospace);
        font-size: 10px; font-weight: 600;
        letter-spacing: 0.12em; text-transform: uppercase;
        color: var(--gray-600, #74777f);
        margin-bottom: 2px;
      }
      #tc-tweaks .tw-row {
        display: flex; align-items: center; gap: 8px;
        font-size: 12px;
        color: var(--gray-700, #54575f);
      }
      #tc-tweaks .tw-row label { flex: 1; }
      #tc-tweaks .tw-readout {
        font-family: var(--f-mono, ui-monospace, monospace);
        font-size: 11px; font-weight: 600;
        color: var(--near-black, #131316);
        min-width: 28px; text-align: right;
        font-feature-settings: 'tnum';
      }
      #tc-tweaks input[type="range"] {
        flex: 1.4;
        accent-color: var(--hitachi-red, #e60012);
      }
      #tc-tweaks .tw-opts {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 4px;
      }
      #tc-tweaks .tw-opt {
        background: var(--white, #fff);
        border: 1px solid var(--gray-200, #ececef);
        border-radius: 8px;
        padding: 8px 10px;
        cursor: pointer;
        font-family: var(--f-ui, system-ui, sans-serif);
        font-size: 12px;
        font-weight: 500;
        color: var(--gray-700, #54575f);
        letter-spacing: -0.005em;
        text-align: left;
        display: flex; flex-direction: column; gap: 4px;
        transition: border-color .12s ease, background .12s ease;
      }
      #tc-tweaks .tw-opt:hover {
        border-color: var(--gray-400, #c2c5cb);
        background: var(--gray-50, #fafaf8);
      }
      #tc-tweaks .tw-opt.on {
        background: var(--near-black, #131316);
        border-color: var(--near-black, #131316);
        color: #fff;
      }
      #tc-tweaks .tw-opt-name { font-weight: 600; font-size: 12px; }
      #tc-tweaks .tw-opt-preview {
        font-size: 13px;
        font-weight: 500;
        color: inherit;
        opacity: 0.85;
      }
      #tc-tweaks .tw-opt.on .tw-opt-preview { color: rgba(255,255,255,0.9); }
      #tc-tweaks .tw-foot {
        display: flex; gap: 4px;
        padding: 8px 12px;
        border-top: 1px solid var(--gray-100, #f4f4f6);
        background: var(--gray-50, #fafaf8);
      }
      /* floating launcher button */
      #tc-tweaks-fab {
        position: fixed; right: 18px; bottom: 18px;
        z-index: 99998;
        width: 44px; height: 44px;
        border-radius: 50%;
        background: var(--near-black, #131316);
        color: #fff;
        border: 1px solid rgba(255,255,255,0.08);
        box-shadow: 0 12px 28px -12px rgba(15,17,21,0.35);
        cursor: pointer;
        display: grid; place-items: center;
        font-size: 18px;
      }
      #tc-tweaks-fab:hover { background: var(--gray-900, #2a2c31); }
      #tc-tweaks-fab.hide { display: none; }
    `;
    const style = document.createElement('style');
    style.id = 'tc-tweaks-css';
    style.textContent = css;
    document.head.appendChild(style);

    // Fab
    const fab = document.createElement('button');
    fab.id = 'tc-tweaks-fab';
    fab.title = 'Tweaks';
    fab.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 8H10M6.5 8H2.5M21.5 16H17.5M13.5 16H2.5"/><circle cx="8" cy="8" r="2.5" fill="currentColor"/><circle cx="15.5" cy="16" r="2.5" fill="currentColor"/></svg>`;
    fab.addEventListener('click', () => openPanel(true));
    document.body.appendChild(fab);

    // Panel
    const panel = document.createElement('div');
    panel.id = 'tc-tweaks';
    panel.innerHTML = `
      <div class="tw-head">
        <span class="tw-dot"></span>
        <span class="tw-title">Tweaks</span>
        <button class="tw-reset" type="button" title="Reset">Reset</button>
        <button class="tw-close" type="button" title="Close">×</button>
      </div>
      <div class="tw-body">

        <div class="tw-section">
          <div class="tw-section-title">Input &amp; dropdown font</div>
          <div class="tw-opts">
            ${FONT_OPTIONS.input.map(o => `
              <button class="tw-opt" type="button" data-tw-key="inputFont" data-tw-val="${o.id}">
                <span class="tw-opt-name">${o.label}</span>
                <span class="tw-opt-preview" style="font-family:${o.stack};">Aa Bay Fair 12</span>
              </button>
            `).join('')}
          </div>
          <div class="tw-row">
            <label>Size</label>
            <input type="range" min="11" max="18" step="0.5" data-tw-key="inputSize"
              oninput="window.__twSet('inputSize', parseFloat(this.value))">
            <span class="tw-readout" data-tw-readout="inputSize"></span>
          </div>
          <div class="tw-row">
            <label>Weight</label>
            <input type="range" min="300" max="700" step="100" data-tw-key="inputWeight"
              oninput="window.__twSet('inputWeight', parseInt(this.value))">
            <span class="tw-readout" data-tw-readout="inputWeight"></span>
          </div>
        </div>

        <div class="tw-section">
          <div class="tw-section-title">Number font (KPIs, counts, stats)</div>
          <div class="tw-opts">
            ${FONT_OPTIONS.number.map(o => `
              <button class="tw-opt" type="button" data-tw-key="numberFont" data-tw-val="${o.id}">
                <span class="tw-opt-name">${o.label}</span>
                <span class="tw-opt-preview" style="font-family:${o.stack}; font-size:18px; font-weight:600; letter-spacing:-0.02em;">67.4%</span>
              </button>
            `).join('')}
          </div>
          <div class="tw-row">
            <label>Size</label>
            <input type="range" min="18" max="48" step="1" data-tw-key="numberSize"
              oninput="window.__twSet('numberSize', parseFloat(this.value))">
            <span class="tw-readout" data-tw-readout="numberSize"></span>
          </div>
          <div class="tw-row">
            <label>Weight</label>
            <input type="range" min="400" max="800" step="100" data-tw-key="numberWeight"
              oninput="window.__twSet('numberWeight', parseInt(this.value))">
            <span class="tw-readout" data-tw-readout="numberWeight"></span>
          </div>
        </div>

        <div class="tw-section">
          <div class="tw-section-title">Test Register — Status badges</div>
          <div class="tw-opts">
            <button class="tw-opt" type="button" data-tw-key="trStatus" data-tw-val="default">
              <span class="tw-opt-name">Default</span>
              <span class="tw-opt-preview" style="font-size:11px;">
                <span style="background:#e8f4ee;border:1px solid rgba(13,122,79,0.18);color:#0d7a4f;border-radius:999px;padding:3px 9px;font-weight:600;display:inline-flex;align-items:center;gap:5px;">
                  <span style="width:6px;height:6px;border-radius:50%;background:#16a571;"></span>Closed
                </span>
              </span>
            </button>
            <button class="tw-opt" type="button" data-tw-key="trStatus" data-tw-val="mono">
              <span class="tw-opt-name">Mono Caps</span>
              <span class="tw-opt-preview" style="font-family:'Roboto Mono',monospace;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;font-weight:600;">
                <span style="background:#e8f4ee;color:#0d7a4f;border:1px solid rgba(13,122,79,0.22);border-radius:4px;padding:2px 7px;">CLOSED</span>
              </span>
            </button>
            <button class="tw-opt" type="button" data-tw-key="trStatus" data-tw-val="mono-dot">
              <span class="tw-opt-name">Mono + Dot</span>
              <span class="tw-opt-preview" style="font-family:'Roboto Mono',monospace;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;font-weight:600;">
                <span style="background:#e8f4ee;color:#0d7a4f;border:1px solid rgba(13,122,79,0.22);border-radius:4px;padding:2px 7px 2px 6px;display:inline-flex;align-items:center;gap:5px;">
                  <span style="width:6px;height:6px;border-radius:50%;background:#16a571;"></span>CLOSED
                </span>
              </span>
            </button>
            <button class="tw-opt" type="button" data-tw-key="trStatus" data-tw-val="bar">
              <span class="tw-opt-name">Side Bar</span>
              <span class="tw-opt-preview" style="font-size:12px;border-left:3px solid #16a571;padding-left:9px;color:#131316;font-weight:600;">Closed</span>
            </button>
          </div>
        </div>

        <div class="tw-section">
          <div class="tw-section-title">Test Register — Completion bar</div>
          <div class="tw-opts">
            <button class="tw-opt" type="button" data-tw-key="trBar" data-tw-val="default">
              <span class="tw-opt-name">Default</span>
              <span class="tw-opt-preview" style="display:flex;align-items:center;gap:8px;">
                <span style="flex:1;height:8px;background:#eef2f6;border-radius:99px;overflow:hidden;"><span style="display:block;width:65%;height:100%;background:#1d4eaf;"></span></span>
                <span style="font-family:'Roboto Mono',monospace;font-size:10px;font-weight:600;">65%</span>
              </span>
            </button>
            <button class="tw-opt" type="button" data-tw-key="trBar" data-tw-val="thin">
              <span class="tw-opt-name">Thin</span>
              <span class="tw-opt-preview" style="display:flex;align-items:center;gap:8px;">
                <span style="flex:1;height:4px;background:#f4f4f6;border-radius:4px;overflow:hidden;"><span style="display:block;width:65%;height:100%;background:#1d4eaf;"></span></span>
                <span style="font-family:'Roboto Mono',monospace;font-size:10px;font-weight:600;">65%</span>
              </span>
            </button>
            <button class="tw-opt" type="button" data-tw-key="trBar" data-tw-val="seg">
              <span class="tw-opt-name">Segmented</span>
              <span class="tw-opt-preview" style="display:flex;align-items:center;gap:8px;">
                <span style="flex:1;height:12px;display:flex;gap:3px;">
                  <span style="flex:1;background:#1d4eaf;"></span>
                  <span style="flex:1;background:#1d4eaf;"></span>
                  <span style="flex:1;background:#1d4eaf;"></span>
                  <span style="flex:1;background:#ececef;"></span>
                  <span style="flex:1;background:#ececef;"></span>
                </span>
                <span style="font-family:'Roboto Mono',monospace;font-size:10px;font-weight:600;">65%</span>
              </span>
            </button>
            <button class="tw-opt" type="button" data-tw-key="trBar" data-tw-val="steps">
              <span class="tw-opt-name">10 Steps</span>
              <span class="tw-opt-preview" style="display:flex;align-items:center;gap:8px;">
                <span style="flex:1;height:10px;display:flex;gap:2px;">
                  ${Array.from({length:10},(_,i)=>`<span style="flex:1;background:${i<6?'#1d4eaf':'#ececef'};"></span>`).join('')}
                </span>
                <span style="font-family:'Roboto Mono',monospace;font-size:10px;font-weight:600;">65%</span>
              </span>
            </button>
            <button class="tw-opt" type="button" data-tw-key="trBar" data-tw-val="ring">
              <span class="tw-opt-name">Ring</span>
              <span class="tw-opt-preview" style="display:flex;align-items:center;gap:8px;">
                <span style="width:22px;height:22px;border-radius:50%;background:conic-gradient(#1d4eaf 65%,#ececef 0);position:relative;">
                  <span style="position:absolute;inset:4px;border-radius:50%;background:#fff;"></span>
                </span>
                <span style="font-family:'Roboto Mono',monospace;font-size:10px;font-weight:600;flex:1;">65%</span>
              </span>
            </button>
            <button class="tw-opt" type="button" data-tw-key="trBar" data-tw-val="chip">
              <span class="tw-opt-name">Chip only</span>
              <span class="tw-opt-preview" style="font-family:'Roboto Mono',monospace;font-size:11px;font-weight:600;letter-spacing:0.04em;">
                <span style="background:#fafaf8;border:1px solid #dfe1e5;color:#3a3c43;border-radius:999px;padding:2px 9px;">65%</span>
              </span>
            </button>
          </div>
        </div>

      </div>
    `;
    document.body.appendChild(panel);

    // event delegation for option buttons
    panel.addEventListener('click', (e) => {
      const opt = e.target.closest('.tw-opt');
      if (opt) { setKey(opt.dataset.twKey, opt.dataset.twVal); return; }
    });

    panel.querySelector('.tw-close').addEventListener('click', () => openPanel(false));
    panel.querySelector('.tw-reset').addEventListener('click', () => reset());

    // expose setter for inline range handlers
    window.__twSet = setKey;
  }

  let isOpen = false;
  function openPanel(open) {
    isOpen = !!open;
    const panel = document.getElementById('tc-tweaks');
    const fab = document.getElementById('tc-tweaks-fab');
    if (panel) panel.classList.toggle('open', isOpen);
    if (fab)  fab.classList.toggle('hide', isOpen);
    if (isOpen) apply();
    if (!isOpen) {
      try { window.parent.postMessage({ type: '__edit_mode_dismissed' }, '*'); } catch (_) {}
    }
  }

  // host edit-mode protocol
  window.addEventListener('message', (ev) => {
    const t = ev.data && ev.data.type;
    if (t === '__activate_edit_mode')   openPanel(true);
    if (t === '__deactivate_edit_mode') openPanel(false);
  });

  function init() {
    ensureFontsLoaded();
    buildPanel();
    apply();
    watchTestRegister();
    // Re-watch when the test-register page becomes visible (it mounts late)
    setInterval(watchTestRegister, 1500);
    try { window.parent.postMessage({ type: '__edit_mode_available' }, '*'); } catch (_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
