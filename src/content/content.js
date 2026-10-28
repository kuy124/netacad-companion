import {
  deepHtmlSearch,
  deepHtmlSearchAll,
  deepHtmlFindByTextContent,
  enableTextSelectionRecursive,
  deepHtmlFindByTextContentPart, findVisibleFromComponents,
  findElementsByIdClassAsync
} from "./domHelper";
import { mountChapterChecklist } from "./chapterChecklist";

let isSuspendRunning = false;
const components = [];
let questions = [];
const componentUrls = [];
const loadingComponentUrls = new Set();
const processedAccordionQuestions = new WeakSet();

const isExtensionContextValid = () => Boolean(globalThis.chrome?.runtime?.id);
const isExtensionContextInvalidatedError = error =>
  /extension context invalidated/i.test(String(error?.message || error));

const QUESTION_REFRESH_DEBOUNCE = 250;
const HIGHLIGHT_CLASS = 'netacad-solver-highlight';
const HIGHLIGHT_ACCENT_CLASS = 'netacad-solver-highlight-accent';
const HIGHLIGHT_CSS = `
  .${HIGHLIGHT_CLASS} {
    outline: var(--netacad-hl-outline, 3px solid #22c55e) !important;
    outline-offset: 2px !important;
    border-radius: 6px !important;
    background-color: var(--netacad-hl-bg, rgba(34, 197, 94, 0.16)) !important;
    box-shadow: var(--netacad-hl-shadow, 0 0 0 3px rgba(34, 197, 94, 0.25)) !important;
    transition: background-color 0.15s ease, outline-color 0.15s ease !important;
  }
  .${HIGHLIGHT_CLASS}.${HIGHLIGHT_ACCENT_CLASS} {
    outline-color: rgba(var(--netacad-hl-accent-rgb, 34, 197, 94), var(--netacad-hl-accent-alpha, 1)) !important;
    background-color: rgba(var(--netacad-hl-accent-rgb, 34, 197, 94), calc(var(--netacad-hl-accent-alpha, 1) * 0.16)) !important;
    box-shadow: 0 0 0 3px rgba(var(--netacad-hl-accent-rgb, 34, 197, 94), calc(var(--netacad-hl-accent-alpha, 1) * 0.25)) !important;
  }
`;
const highlightRoots = new WeakSet();

const HIGHLIGHTS_VISIBLE_KEY = 'netacad-solver-highlights-visible';
const MODE_KEY = 'netacad-solver-mode';
let mode = 'safe';
let brutalForceSubmit = false;
const HIGHLIGHT_VARS_ON = {
  '--netacad-hl-outline': '3px solid #22c55e',
  '--netacad-hl-bg': 'rgba(34, 197, 94, 0.16)',
  '--netacad-hl-shadow': '0 0 0 3px rgba(34, 197, 94, 0.25)',
  // Numeric gate (1 = shown, 0 = hidden) consumed by the per-answer accent
  // colours, so those inherit the same O(1) show/hide toggle.
  '--netacad-hl-accent-alpha': '1',
};
const HIGHLIGHT_VARS_OFF = {
  '--netacad-hl-outline': '0 solid transparent',
  '--netacad-hl-bg': 'transparent',
  '--netacad-hl-shadow': 'none',
  '--netacad-hl-accent-alpha': '0',
};
let highlightsVisible = true;
let lastToggleAt = 0;

const normalizeElementText = text => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
const isObjectReference = value =>
  (typeof value === 'object' && value !== null) || typeof value === 'function';

// Minimal HSL -> RGB (h in degrees, s/l in 0..1) returning rounded 0-255 parts.
const hslToRgb = (h, s, l) => {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;

  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  const m = l - c / 2;
  return [r, g, b].map(v => Math.round((v + m) * 255));
};

// Apply the current visibility state as CSS custom properties on a document
// element. Custom properties inherit across shadow-DOM boundaries, so this
// toggles every highlight inside the document (and its shadow roots) at once.
const applyVisibilityVars = docElement => {
  if (!docElement?.style?.setProperty)
    return;

  const vars = highlightsVisible ? HIGHLIGHT_VARS_ON : HIGHLIGHT_VARS_OFF;

  for (const [name, value] of Object.entries(vars)) {
    try {
      docElement.style.setProperty(name, value);
    } catch (e) {
    }
  }
};

// Custom properties do not cross iframe boundaries, so recurse into every
// same-origin iframe document and apply the variables there too.
const applyVisibilityToDocument = doc => {
  if (!doc?.documentElement)
    return;

  applyVisibilityVars(doc.documentElement);

  let iframes = [];

  try {
    iframes = [...(doc.querySelectorAll?.('iframe') || [])];
  } catch (e) {
    return;
  }

  for (const iframe of iframes) {
    try {
      if (iframe.contentDocument)
        applyVisibilityToDocument(iframe.contentDocument);
    } catch (e) {
    }
  }
};

const ensureHighlightStyle = root => {
  if (!root || highlightRoots.has(root))
    return;

  const isDocument = root.nodeType === Node.DOCUMENT_NODE;
  const ownerDocument = isDocument ? root : root.ownerDocument;

  if (!ownerDocument?.createElement)
    return;

  const target = isDocument ? (root.head || root.documentElement) : root;

  if (!target)
    return;

  highlightRoots.add(root);

  const style = ownerDocument.createElement('style');
  style.setAttribute('data-netacad-solver-highlight', 'true');
  style.textContent = HIGHLIGHT_CSS;
  target.appendChild(style);

  // Ensure the visibility state is applied for this document/scope.
  if (isDocument)
    applyVisibilityVars(root.documentElement);
  else
    applyVisibilityVars(ownerDocument.documentElement);
};

// Spread colours around the hue wheel so any number of answers get visually
// distinct highlights (golden-angle stepping keeps adjacent hues far apart).
const accentRgbForIndex = index => {
  const hue = (Number(index) * 137.508) % 360;
  const [r, g, b] = hslToRgb(hue, 0.72, 0.5);
  return `${r}, ${g}, ${b}`;
};

const highlightElement = (element, { accentIndex } = {}) => {
  if (!element)
    return;

  if (element.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    [...element.children].forEach(child => highlightElement(child, { accentIndex }));
    return;
  }

  if (element.nodeType !== Node.ELEMENT_NODE)
    return;

  try {
    ensureHighlightStyle(element.getRootNode());
    element.classList.add(HIGHLIGHT_CLASS);

    if (accentIndex !== undefined) {
      element.classList.add(HIGHLIGHT_ACCENT_CLASS);
      element.style.setProperty('--netacad-hl-accent-rgb', accentRgbForIndex(accentIndex));
    }
  } catch (e) {
  }
};

const isVisibleElement = element => {
  if (!element)
    return false;

  try {
    const visibilityElement = element.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? element.host : element;
    const view = visibilityElement?.ownerDocument?.defaultView || window;
    let currentElement = visibilityElement;

    while (currentElement?.nodeType === 1) {
      if (currentElement.hidden || currentElement.getAttribute?.('aria-hidden') === 'true')
        return false;

      const style = view.getComputedStyle(currentElement);
      if (style.display === 'none' || style.visibility === 'hidden')
        return false;

      currentElement = currentElement.parentElement || currentElement.getRootNode?.()?.host;
    }

    const rect = visibilityElement?.getBoundingClientRect?.();

    if (!rect || rect.width <= 0 || rect.height <= 0)
      return false;

    return rect.bottom > 0 && rect.right > 0 && rect.top < view.innerHeight && rect.left < view.innerWidth;
  } catch (e) {
    return false;
  }
};

const persistPreference = (key, value) => {
  if (!isExtensionContextValid())
    return;

  try {
    chrome.storage.local.set({ [key]: value });
  } catch (e) {
    if (!isExtensionContextInvalidatedError(e))
      console.error(e);
  }
};

const persistHighlightsVisible = () => persistPreference(HIGHLIGHTS_VISIBLE_KEY, highlightsVisible);
const persistMode = () => persistPreference(MODE_KEY, mode);

const setHighlightsVisible = (visible, { persist = false } = {}) => {
  highlightsVisible = Boolean(visible);

  try {
    applyVisibilityToDocument(document);
  } catch (e) {
  }

  if (persist)
    persistHighlightsVisible();

  updateModeBadge();
  return highlightsVisible;
};

const toggleHighlights = () => {
  // The manifest command (via the background script) and the in-page keydown
  // handler can both fire for one key press. Ignore a duplicate toggle that
  // arrives immediately after the previous one.
  const now = Date.now();

  if (now - lastToggleAt < 400)
    return highlightsVisible;

  lastToggleAt = now;

  return setHighlightsVisible(!highlightsVisible, { persist: true });
};

const setMode = nextMode => {
  if (getTabControls()?.dataset.checklistRunning)
    return mode;
  if (!['safe', 'brutal'].includes(nextMode) || nextMode === mode)
    return mode;

  mode = nextMode;
  brutalForceSubmit = mode === 'brutal';
  persistMode();
  updateModeBadge();

  // Switching TO brutal means "solve and submit now": run the pass right
  // away (an idle page never re-runs main() on its own) and force the
  // submit even when the answers were already selected, e.g. by Safe
  // mode's Ctrl+Shift+Y earlier.
  if (mode === 'brutal')
    suspendMain();

  return mode;
};

const toggleMode = () => setMode(mode === 'brutal' ? 'safe' : 'brutal');
const MODE_CONTROLS_ID = 'netacad-solver-controls';
const MODE_BADGE_ID = 'netacad-solver-mode-badge';
const getTabControls = () => {
  try { return window.top.document.getElementById(MODE_CONTROLS_ID); } catch (e) { return null; }
};

const updateModeBadge = () => {
  const controls = document.getElementById(MODE_CONTROLS_ID);

  if (!controls)
    return;

  // Only mode changes rewrite text; routine question refreshes leave the UI alone.
  if (controls.dataset.mode !== mode) {
    controls.dataset.mode = mode;
    controls.querySelector(`#${MODE_BADGE_ID}`).textContent = mode === 'brutal' ? 'BRUTAL' : 'EASY';
    controls.querySelector('#netacad-solver-mode-description').textContent = mode === 'brutal'
      ? 'Automatically selects answers and submits as questions load.'
      : 'Select answers when you are ready, then review and submit.';
    controls.querySelectorAll('button[data-mode]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    });
  }

  const checklistRunning = Boolean(controls.dataset.checklistRunning);
  controls.querySelectorAll('button[data-mode], .solver-select').forEach(button => { button.disabled = checklistRunning; });
  const statusKey = `${mode}:${checklistRunning}`;
  if (controls.dataset.status !== statusKey) {
    controls.dataset.status = statusKey;
    controls.querySelector('.solver-mode-status').textContent = checklistRunning
      ? 'Chapter checklist running' : mode === 'brutal' ? 'Automatic submission' : 'Manual submission';
    controls.querySelector('summary').setAttribute('aria-label', `NetAcad Companion controls, ${checklistRunning
      ? 'chapter checklist running' : mode === 'brutal' ? 'Brutal mode, automatic submission' : 'Easy mode, manual submission'}`);
  }

  controls.querySelector('#netacad-solver-highlights').checked = highlightsVisible;
};

// Native disclosure keeps the status compact and provides keyboard interaction.
const ensureModeBadge = () => {
  try {
    // Content scripts run in every course frame; only the tab owns the menu.
    if (window !== window.top || !document.body)
      return;

    if (!document.getElementById(MODE_CONTROLS_ID)) {
      const controls = document.createElement('details');
      controls.id = MODE_CONTROLS_ID;
      controls.innerHTML = `
        <style>
          #${MODE_CONTROLS_ID} {
            all: initial; --solver-accent: #3d7825; --solver-tint: #eef7e9;
            position: fixed; right: max(12px, env(safe-area-inset-right)); bottom: max(12px, env(safe-area-inset-bottom));
            z-index: 2147483647; display: block; width: min(260px, calc(100vw - 24px));
            color: #273139; font: 13px/1.5 CiscoSansTT, CiscoSans, Arial, sans-serif;
            text-align: left; color-scheme: light; isolation: isolate;
          }
          #${MODE_CONTROLS_ID}[data-mode="brutal"] { --solver-accent: #8c5515; --solver-tint: #fff5e6; }
          #${MODE_CONTROLS_ID} * { box-sizing: border-box; }
          #${MODE_CONTROLS_ID} svg { display: block; flex-shrink: 0; width: 18px; height: 18px; }
          #${MODE_CONTROLS_ID} strong { display: block; font-size: 13px; font-weight: 600; }
          #${MODE_CONTROLS_ID} > summary {
            display: flex; align-items: center; gap: 10px; min-height: 48px; padding: 0 12px; list-style: none;
            border: 1px solid #d4dadd; border-bottom: 3px solid #6abf4b; border-radius: 4px; background: #fff;
            box-shadow: 0 2px 8px #172d3d14; cursor: pointer; user-select: none;
          }
          #${MODE_CONTROLS_ID} > summary::-webkit-details-marker { display: none; }
          #${MODE_CONTROLS_ID} > summary:hover, #${MODE_CONTROLS_ID}[open] > summary { background: #f5f9f2; border-color: #6abf4b; }
          #${MODE_CONTROLS_ID} .solver-mark { width: 21px; height: 21px; color: #4b8a31; }
          #${MODE_CONTROLS_ID} .solver-summary-copy { flex: 1; min-width: 0; white-space: nowrap; }
          #${MODE_BADGE_ID} {
            padding: 2px 6px; border-radius: 3px; color: var(--solver-accent); background: var(--solver-tint);
            font-size: 10px; font-weight: 700; letter-spacing: .035em;
          }
          #${MODE_CONTROLS_ID} .solver-chevron { width: 12px; height: 12px; color: #59636b; transition: transform .15s; }
          #${MODE_CONTROLS_ID}[open] .solver-chevron { transform: rotate(180deg); }
          #${MODE_CONTROLS_ID} .solver-panel {
            position: absolute; right: 0; bottom: calc(100% + 8px); width: min(344px, calc(100vw - 24px));
            max-height: calc(100dvh - 88px - env(safe-area-inset-bottom)); overflow: auto; overscroll-behavior: contain;
            border: 1px solid #d4dadd; border-radius: 5px; background: #fff; box-shadow: 0 6px 24px #172d3d24;
          }
          #${MODE_CONTROLS_ID}:not([open]) .solver-panel { display: none; }
          #${MODE_CONTROLS_ID} .solver-panel-header {
            display: flex; align-items: center; justify-content: space-between; gap: 12px;
            padding: 14px 18px; border-bottom: 1px solid #e3e7e9;
          }
          #${MODE_CONTROLS_ID} .solver-panel-header strong { font-size: 16px; }
          #${MODE_CONTROLS_ID} .solver-mode-status { display: flex; align-items: center; gap: 6px; margin-top: 3px; color: #5b666e; font-size: 12px; }
          #${MODE_CONTROLS_ID} .solver-mode-status::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--solver-accent); }
          #${MODE_CONTROLS_ID} .solver-section { padding: 16px 18px; }
          #${MODE_CONTROLS_ID} .solver-panel-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
          #${MODE_CONTROLS_ID} .solver-section-label { font-size: 10px; font-weight: 700; letter-spacing: .09em; color: #59636b; }
          #${MODE_CONTROLS_ID} .solver-shortcut { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; }
          #${MODE_CONTROLS_ID} kbd {
            display: inline-block; min-width: 17px; padding: 1px 4px; border: 1px solid #d7dde1; border-bottom-width: 2px;
            border-radius: 3px; background: #f8f9fa; color: #5b666e; font: 10px/1.5 Arial, sans-serif; text-align: center;
          }
          #${MODE_CONTROLS_ID} .solver-modes { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
          #${MODE_CONTROLS_ID} button {
            all: unset; box-sizing: border-box; font: inherit; color: inherit; cursor: pointer;
          }
          #${MODE_CONTROLS_ID} button[data-mode] {
            min-width: 0; padding: 12px; border: 1px solid #d5dce0; border-radius: 4px;
            background: #fff; transition: border-color .15s, background-color .15s;
          }
          #${MODE_CONTROLS_ID} button[data-mode="safe"] { --option-accent: #3d7825; --option-tint: #f0f8ec; }
          #${MODE_CONTROLS_ID} button[data-mode="brutal"] { --option-accent: #8c5515; --option-tint: #fff7eb; }
          #${MODE_CONTROLS_ID} button[data-mode]:hover { border-color: var(--option-accent); background: var(--option-tint); }
          #${MODE_CONTROLS_ID} button[data-mode][aria-pressed="true"] {
            color: var(--option-accent); background: var(--option-tint); border-color: var(--option-accent);
          }
          #${MODE_CONTROLS_ID} .solver-option-heading { display: flex; align-items: center; gap: 6px; }
          #${MODE_CONTROLS_ID} .solver-option-heading strong { flex: 1; font-size: 14px; }
          #${MODE_CONTROLS_ID} .solver-option-heading svg { width: 16px; height: 16px; }
          #${MODE_CONTROLS_ID} .solver-option-check {
            display: grid; place-items: center; flex: 0 0 14px; height: 14px; border: 1px solid #a2adb5;
            border-radius: 50%; color: transparent; font-size: 10px; line-height: 1;
          }
          #${MODE_CONTROLS_ID} button[aria-pressed="true"] .solver-option-check { color: #fff; border-color: var(--option-accent); background: var(--option-accent); }
          #${MODE_CONTROLS_ID} .solver-option-copy { display: block; margin-top: 7px; color: #59636b; font-size: 12px; line-height: 1.5; }
          #${MODE_CONTROLS_ID} #netacad-solver-mode-description { min-height: 36px; margin: 12px 0 0; color: #59636b; font-size: 12px; }
          #${MODE_CONTROLS_ID} .solver-highlights {
            display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 10px;
            margin: 0; padding: 14px 18px; border-top: 1px solid #e3e7e9; cursor: pointer;
          }
          #${MODE_CONTROLS_ID} .solver-setting-description { display: block; margin-top: 2px; color: #59636b; font-size: 11px; }
          #${MODE_CONTROLS_ID} input[role="switch"] {
            appearance: none; width: 34px; height: 20px; margin: 0; padding: 2px;
            border: 1px solid #727d84; border-radius: 20px; background: #7b858b; cursor: pointer;
          }
          #${MODE_CONTROLS_ID} input[role="switch"]::before {
            content: ''; display: block; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform .15s;
          }
          #${MODE_CONTROLS_ID} input[role="switch"]:checked { background: #4c8a31; border-color: #4c8a31; }
          #${MODE_CONTROLS_ID} input[role="switch"]:checked::before { transform: translateX(14px); }
          #${MODE_CONTROLS_ID} .solver-footer { padding: 14px 18px; border-top: 1px solid #e3e7e9; background: #f7f9f9; }
          #${MODE_CONTROLS_ID} .solver-select {
            display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; min-height: 40px;
            padding: 8px 10px; border: 1px solid #579e39; border-radius: 3px; background: #6abf4b; color: #17320c; font-weight: 600;
          }
          #${MODE_CONTROLS_ID} .solver-select:hover { background: #5aaf3c; border-color: #4a902e; }
          #${MODE_CONTROLS_ID} .solver-select kbd { color: #274b19; border-color: #4a902e; background: #ffffff4d; }
          #${MODE_CONTROLS_ID} .solver-close { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 3px; color: #59636b; }
          #${MODE_CONTROLS_ID} .solver-close:hover { background: #edf0f1; color: #273139; }
          #${MODE_CONTROLS_ID} :focus-visible { outline: 2px solid #1673a5; outline-offset: 3px; }
          @media (prefers-reduced-motion: reduce) { #${MODE_CONTROLS_ID} *, #${MODE_CONTROLS_ID} *::before { transition: none; } }
          @media (forced-colors: active) {
            #${MODE_CONTROLS_ID} button[aria-pressed="true"] { outline: 2px solid Highlight; }
            #${MODE_CONTROLS_ID} input { appearance: auto; }
            #${MODE_CONTROLS_ID} input::before { display: none; }
          }
        </style>
        <summary title="Open controls" aria-label="NetAcad Companion controls">
          <svg class="solver-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1m0-15c3-2 6-2 9-1v15c-3-1-6-1-9 1V5Z"/></svg>
          <strong class="solver-summary-copy">NetAcad Companion</strong>
          <span id="${MODE_BADGE_ID}" role="status"></span>
          <svg class="solver-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 10 4-4 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </summary>
        <section class="solver-panel" aria-label="Solver settings">
          <header class="solver-panel-header">
            <div><strong>NetAcad Companion</strong><span class="solver-mode-status"></span></div>
            <button type="button" class="solver-close" aria-label="Close solver settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
          </header>
          <div class="solver-section">
            <div class="solver-panel-heading"><span class="solver-section-label">Answer mode</span><span class="solver-shortcut" aria-label="Control Shift M"><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>M</kbd></span></div>
            <div class="solver-modes" role="group" aria-label="Solver mode" aria-describedby="netacad-solver-mode-description">
              <button type="button" data-mode="safe" aria-pressed="false">
                <span class="solver-option-heading"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg><strong>Easy</strong><span class="solver-option-check" aria-hidden="true"></span></span>
                <span class="solver-option-copy">Select on demand.<br>Submit yourself.</span>
              </button>
              <button type="button" data-mode="brutal" aria-pressed="false">
                <span class="solver-option-heading"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m13 2-9 12h7l-1 8 10-12h-7l1-8Z"/></svg><strong>Brutal</strong><span class="solver-option-check" aria-hidden="true"></span></span>
                <span class="solver-option-copy">Select and submit.<br>Available answers only.</span>
              </button>
            </div>
            <p id="netacad-solver-mode-description"></p>
          </div>
          <label class="solver-highlights" for="netacad-solver-highlights">
            <span><strong>Answer highlights</strong><span class="solver-setting-description">Show correct answers</span></span>
            <span class="solver-shortcut" aria-hidden="true"><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>H</kbd></span>
            <input id="netacad-solver-highlights" type="checkbox" role="switch" aria-label="Answer highlights" aria-keyshortcuts="Control+Shift+H">
          </label>
          <footer class="solver-footer">
            <button type="button" class="solver-select" aria-label="Select answers" aria-keyshortcuts="Control+Shift+Y"><span>Select answers</span><span class="solver-shortcut" aria-hidden="true"><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>Y</kbd></span></button>
          </footer>
        </section>`;
      const closeControls = () => {
        controls.open = false;
        controls.querySelector('summary').focus();
      };
      controls.querySelector('.solver-close').addEventListener('click', closeControls);
      controls.querySelector('.solver-select').addEventListener('click', () => {
        requestSolve();
        closeControls();
      });
      controls.querySelectorAll('button[data-mode]').forEach(button => {
        button.addEventListener('click', () => setMode(button.dataset.mode));
      });
      controls.querySelector('input').addEventListener('change', event => {
        setHighlightsVisible(event.target.checked, { persist: true });
      });
      controls.addEventListener('keydown', event => {
        if (event.key === 'Escape' && controls.open) {
          event.preventDefault();
          event.stopPropagation();
          closeControls();
        }
      });
      document.body.appendChild(controls);
      mountChapterChecklist(controls, (document, signal, scope) => suspendMain({ document, signal, scope }), updateModeBadge);
    }

    updateModeBadge();
  } catch (e) {
  }
};

const loadPreferences = async () => {
  if (!isExtensionContextValid())
    return;

  const stored = await new Promise(resolve => {
    try {
      chrome.storage.local.get([HIGHLIGHTS_VISIBLE_KEY, MODE_KEY], values => {
        void chrome.runtime.lastError;
        resolve(values || {});
      });
    } catch (e) {
      if (!isExtensionContextInvalidatedError(e))
        console.error(e);
      resolve({});
    }
  });

  if (typeof stored[HIGHLIGHTS_VISIBLE_KEY] === 'boolean')
    setHighlightsVisible(stored[HIGHLIGHTS_VISIBLE_KEY]);

  // Only known values are accepted; anything else keeps the safe default.
  mode = stored[MODE_KEY] === 'brutal' ? 'brutal' : 'safe';
  ensureModeBadge();
};

// main() must never act on the default mode while the stored preference is
// still loading (a fresh brutal page would otherwise run its first pass as
// safe). Every main() run awaits this same promise, so the read happens once.
let preferencesReady = null;
const ensurePreferencesLoaded = () => (preferencesReady ??= loadPreferences());

const handleComponentsMessage = async (request) => {
  if (request?.type === 'solve-current-question') {
    requestSolve();
    return;
  }

  if (request?.type === 'toggle-highlights') {
    toggleHighlights();
    return;
  }

  if (request?.componentsUrl && typeof request.componentsUrl === 'string')
    await loadComponents(request.componentsUrl);
};

if (globalThis.chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener(request => {
    void handleComponentsMessage(request).catch(e => {
      if (!isExtensionContextInvalidatedError(e))
        console.error(e);
    });
  });
}

const getTextContentOfText = htmlString => {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, 'text/html');
  return doc.body.textContent;
};

const setComponents = async url => {
  try {
    const res = await fetch(url);

    if (!res.ok)
      return false;

    let json = await res.json();
    json = json
      .filter(component => component._items)
      .filter(component => !components.map(c => c._id).includes(component._id))
      .map(component => {
        component.body = getTextContentOfText(component.body);
        return component;
      });

    components.push(...json);
    return true;
  } catch (e) {
    return false;
  }
};

const loadComponents = async url => {
  if (componentUrls.includes(url) || loadingComponentUrls.has(url))
    return false;

  loadingComponentUrls.add(url);

  try {
    const loaded = await setComponents(url);

    if (loaded) {
      componentUrls.push(url);
      suspendMain();
    }

    return loaded;
  } finally {
    loadingComponentUrls.delete(url);
  }
};

const setFinalExamComponentsFromStorage = async () => {
  if (!isExtensionContextValid())
    return;

  const serviceId = new URL(window.location).searchParams.get('id');
  const storageKey = `service-${serviceId}`;
  const urlsArray = await new Promise(resolve => {
    try {
      chrome.storage.local.get(storageKey, storedValues => {
        void chrome.runtime.lastError;
        resolve(storedValues?.[storageKey]);
      });
    } catch (e) {
      if (!isExtensionContextInvalidatedError(e))
        console.error(e);
      resolve(undefined);
    }
  });

  if (Array.isArray(urlsArray)) {
    for (const url of urlsArray) {
      await loadComponents(url);
    }
  }
};

const setQuestionSections = async () => {
  let isAtLeaseOneSet = false;

  const foundFromComponents = await findElementsByIdClassAsync(document, components);

  for (const component of components) {
    try {
      const data = foundFromComponents[component._id];

      const questionDiv = data?.questionDiv;
      const questionElement = data?.questionElement;

      if (!questionDiv)
        continue;

      if (!component._items?.length)
        continue;

      const firstItem = component._items[0] || {};

      isAtLeaseOneSet = true;
      let questionType = 'basic';

      if (component._component === 'accordion') {
        questionType = 'accordion';
      } else if (firstItem.text && firstItem._options) {
        questionType = 'dropdownSelect';
      } else if (firstItem.question && firstItem.answer) {
        questionType = 'match';
      } else if (firstItem._graphic?.alt && firstItem._graphic?.src) {
        questionType = 'yesNo';
      } else if (firstItem.id && firstItem._options?.text) {
        questionType = 'openTextInput';
      } else if (firstItem.preText && firstItem.postText && firstItem._options?.[0]?.text) {
        questionType = 'fillBlanks';
      } else if (firstItem._options?.[0]?.text && typeof firstItem._options?.[0]?._isCorrect === 'boolean') {
        questionType = 'tableDropdown';
      }

      questions.push({
        body: component.body,
        questionDiv,
        questionElement,
        id: component._id,
        answersLength: component._items.length,
        questionType,
        items: component._items
      });
    } catch (e) {
      if (!isExtensionContextInvalidatedError(e))
        console.error(e);
    }
  }

  return isAtLeaseOneSet;
};

const findAnswerInputsBasic = (question) => {
  const inputs = [];

  for (let i = 0; i < question.answersLength; i++) {
    const div = deepHtmlFindByTextContentPart(question.questionDiv, question.items[i].text);
    const input = deepHtmlSearch(question.questionDiv, `#${CSS.escape(question.id)}-${i}-input`);
    const label = deepHtmlSearch(question.questionDiv, `#${CSS.escape(question.id)}-${i}-label`);

    inputs.push({
      input: input,
      label: label,
      div: div
    });

    if (inputs.length === question.answersLength) {
      return inputs;
    }
  }
};

const findAnswerInputsMatch = (document, answersLength, buttons = []) => {
  for (let i = 0; i < answersLength; i++) {
    const answerInputs = deepHtmlSearch(document, `[data-id="${i}"]`, false, 2);

    if (answerInputs) {
      buttons.push(answerInputs);

      if (buttons.length === answersLength) {
        return buttons;
      }
    }
  }
};

const setQuestionElements = () => {
  questions.map(question => {
    try {
      if (question.questionType === 'basic') {
        if (!question.items[0]?.text || question.items.length !== question.answersLength) {
          question.skip = true;
          return;
        }

        question.questionElement = deepHtmlFindByTextContent(question.questionDiv, question.body);
        question.items = question.items.map(item => ({...item, text: getTextContentOfText(String(item.text || '').trim())}));
        question.inputs = findAnswerInputsBasic(question) || [];
      } else if (question.questionType === 'match') {
        question.questionElement = deepHtmlFindByTextContent(question.questionDiv, question.body);
        question.inputs = findAnswerInputsMatch(question.questionDiv, question.answersLength) || [];
      } else if (question.questionType === 'dropdownSelect') {
        setDropdownSelectQuestions(question);
        question.skip = true;
      } else if (['yesNo', 'openTextInput', 'fillBlanks', 'tableDropdown'].includes(question.questionType)) {
        question.skip = true;
      } else if (question.questionType === 'accordion') {
        setAccordionQuestions(question);
        question.skip = true;
      }
    } catch (e) {
      question.skip = true;

      if (!isExtensionContextInvalidatedError(e))
        console.error(e);
    }

    return question;
  });
};

const setDropdownSelectQuestions = question => {
  question.items.forEach((item, i) => {
    const questionDiv = deepHtmlSearch(question.questionDiv, `[index="${i}"]`, true);

    if (!questionDiv)
      return;

    const questionElement = deepHtmlFindByTextContent(questionDiv, String(item.text || '').trim());

    for (const [index, option] of (item._options || []).entries()) {
      if (option._isCorrect) {
        const optionElement = deepHtmlSearch(questionDiv, `[id="dropdown__item-index-${index}"]`, true);

        questions.push({
          questionDiv,
          questionElement,
          inputs: [optionElement],
          questionType: question.questionType
        });
        return;
      }
    }
  });
};

// Accordion headers are not always <button>: depending on the renderer they can
// be a div[role=button], an <a>, or an element carrying an accordion title
// class. Match all of those shapes rather than only buttons.
const ACCORDION_HEADER_SELECTOR = [
  '[class*="accordion-item-title"]',
  '[class*="accordion__item-title"]',
  '[class*="accordian-item-title"]',
  'button[aria-expanded]',
  '[aria-expanded][role="button"]',
  '[role="button"][aria-expanded]',
  'summary',
  'button',
].join(', ');

// Collect the clickable accordion headers, innermost-first, so a wrapper and
// the element nested inside it are never both highlighted.
const findAccordionHeaders = question => {
  const questionDiv = question.questionDiv;
  let found = [];

  try {
    found = [...questionDiv.querySelectorAll(ACCORDION_HEADER_SELECTOR)];
  } catch (e) {
  }

  if (found.length)
    return found.filter(element => !found.some(other => other !== element && element.contains(other)));

  // Nothing matched by shape — fall back to the elements that render each
  // item's title text.
  const byTitle = [];

  for (const item of question.items || []) {
    const title = normalizeElementText(item?.title);

    if (!title)
      continue;

    let match = null;

    try {
      match = [...questionDiv.querySelectorAll('*')]
        .reverse()
        .find(element => normalizeElementText(element.textContent) === title);
    } catch (e) {
    }

    if (match && !byTitle.includes(match))
      byTitle.push(match);
  }

  return byTitle;
};

const setAccordionQuestions = question => {
  if (processedAccordionQuestions.has(question.questionDiv))
    return;
  processedAccordionQuestions.add(question.questionDiv);

  // Accordions are informational reveal widgets (their items carry no
  // correctness flags), so every header is highlighted — each in its own
  // distinct colour so the headers are easy to tell apart.
  findAccordionHeaders(question).forEach((header, index) => {
    highlightElement(header, { accentIndex: index });
  });
};

const getBasicAnswerInput = (question, component, index) => {
  const answerInput = question.inputs[index];
  let {input, label, div} = answerInput;

  if (!input || !label) {
    const expectedText = question.items?.[index]?.text ?? component._items[index].text;

    if (div?.querySelectorAll) {
      label = [...div.querySelectorAll('label')]
        .find(element => element.textContent.includes(expectedText));
    }

    input = label?.getAttribute('for')
      ? div.querySelector(`[id="${label.getAttribute('for')}"]`)
      : null;
  }

  answerInput.input = input;
  answerInput.label = label;

  return {input, label};
};

const highlightBasicAnswers = question => {
  const component = components.find(c => c._id === question.id);

  if (!component)
    return;

  for (let index = 0; index < question.inputs.length; index++) {
    if (!component._items[index]?._shouldBeSelected)
      continue;

    const {input, label} = getBasicAnswerInput(question, component, index);

    highlightElement(label || input);
  }
};

const highlightMatchAnswers = question => {
  // Each entry is a pair (the item and its matching slot). Give every pair its
  // own colour so you can see which item goes with which slot instead of one
  // undifferentiated green block.
  question.inputs.forEach((pair, index) => {
    const elements = Array.isArray(pair) ? pair : [pair];

    elements.forEach(element => highlightElement(element, { accentIndex: index }));
  });
};

const highlightDropdownAnswer = question => {
  const option = question.inputs[0];

  if (option)
    highlightElement(option);
};

const highlightQuestion = question => {
  if (!question || question.skip)
    return false;

  try {
    if (question.questionType === 'basic') {
      highlightBasicAnswers(question);
    } else if (question.questionType === 'match') {
      highlightMatchAnswers(question);
    } else if (question.questionType === 'dropdownSelect') {
      highlightDropdownAnswer(question);
    } else {
      return false;
    }

    return true;
  } catch (e) {
    if (!isExtensionContextInvalidatedError(e))
      console.error(e);
    return false;
  }
};

// ---------------------------------------------------------------------------
// Auto-solve
//
// Safe mode: only runs from the explicit Ctrl+Shift+Y trigger. Never on page
// load, never on click/hover, and it NEVER submits — selection stays under
// your control.
//
// Brutal mode: runs on every question refresh (no hotkey) and clicks submit
// after selecting — see the brutal section below.
// ---------------------------------------------------------------------------

// A question that has already been filled is never filled again, so pressing
// the hotkey twice cannot toggle answers back off. Auto-refreshes triggered by
// our own DOM changes never solve (they pass solve: false), so a
// select -> re-render -> select loop is not possible.
const autoSolvedQuestions = new WeakSet();

const clickAnswer = element => {
  if (!element || typeof element.click !== 'function')
    return false;

  try {
    element.click();
    return true;
  } catch (e) {
    return false;
  }
};

const selectBasicAnswers = question => {
  const component = components.find(c => c._id === question.id);

  if (!component)
    return 0;

  let selected = 0;

  for (let index = 0; index < question.inputs.length; index++) {
    if (!component._items[index]?._shouldBeSelected)
      continue;

    const {input, label} = getBasicAnswerInput(question, component, index);

    // Never toggle an already-correct answer back off.
    if (input && input.checked)
      continue;

    if (clickAnswer(input || label))
      selected++;
  }

  return selected;
};

const selectMatchPairs = question => {
  let paired = 0;

  question.inputs.forEach(pair => {
    const elements = Array.isArray(pair) ? pair : [pair];
    const [item, slot] = elements;

    if (!item || !slot)
      return;

    if (clickAnswer(item) && clickAnswer(slot))
      paired++;
  });

  return paired;
};

const autoSolveQuestion = question => {
  if (!question || question.skip || autoSolvedQuestions.has(question.questionDiv))
    return 0;

  try {
    const selected = question.questionType === 'basic'
      ? selectBasicAnswers(question)
      : question.questionType === 'match'
        ? selectMatchPairs(question)
        : 0;

    if (selected)
      autoSolvedQuestions.add(question.questionDiv);

    return selected;
  } catch (e) {
    if (!isExtensionContextInvalidatedError(e))
      console.error(e);

    return 0;
  }
};

const autoSolveVisibleQuestions = () => {
  let selected = 0;
  let considered = 0;

  questions.forEach(question => {
    if (!isObjectReference(question?.questionDiv) || question.skip)
      return;

    if (question.questionDiv.isConnected === false)
      return;

    if (!isVisibleElement(question.questionElement || question.questionDiv))
      return;

    considered++;
    selected += autoSolveQuestion(question);
  });

  return { selected, considered };
};

// ---------------------------------------------------------------------------
// Brutal mode
//
// Selects the correct answers AND clicks submit on its own, as soon as a
// solvable question is visible. Switching to brutal also submits on demand
// (brutalForceSubmit), even when the answers were already selected.
// Guards: continuous runs only submit on a pass that selected new answers,
// and submits are debounced, so repeat runs, polls and DOM churn cannot
// double-submit.
// ---------------------------------------------------------------------------

const findSubmitButton = (scope = document) => {
  let candidates = [];

  try {
    candidates = [...scope.querySelectorAll('button, a[href], [role="button"]')];
  } catch (e) {
    candidates = [];
  }

  // Real quiz submit buttons usually sit at the BOTTOM of the page, below
  // the fold, so being in the viewport is a preference (it picks between
  // duplicate renderings), not a requirement. "Submit" / "Submit answers" /
  // "Submit <icon>" all count; disabled ones never do.
  const matches = candidates.filter(element => {
    const text = normalizeElementText(element.textContent);
    return text === 'submit' || text.startsWith('submit ');
  });

  for (const element of matches) {
    if (element.disabled || element.getAttribute?.('aria-disabled') === 'true')
      continue;

    if (isVisibleElement(element))
      return element;
  }

  // Not in the viewport (below the fold): programmatic .click() does not
  // require visibility, so fall back to any enabled match.
  for (const element of matches) {
    if (element.disabled || element.getAttribute?.('aria-disabled') === 'true')
      continue;

    return element;
  }

  // Last resort: pierce shadow roots / iframes, like the highlighter does.
  try {
    const deep = deepHtmlFindByTextContent(scope, 'Submit')
      || deepHtmlFindByTextContent(scope, 'submit');

    if (deep && !deep.disabled)
      return deep;
  } catch (e) {
  }

  return null;
};

const SUBMIT_DEBOUNCE = 400;
let lastSubmitAt = 0;
const submittedButtons = new WeakSet();

const submitAnswers = (scope = document, once = false) => {
  const now = Date.now();

  if (now - lastSubmitAt < SUBMIT_DEBOUNCE)
    return false;

  const submit = findSubmitButton(scope);

  if (!submit) {
    console.warn('[netacad-solver] brutal: no enabled "Submit" button found on this page');
    return false;
  }

  if ((once && submittedButtons.has(submit)) || !clickAnswer(submit))
    return false;

  submittedButtons.add(submit);
  lastSubmitAt = now;
  console.debug('[netacad-solver] brutal: submit clicked');
  return true;
};

const highlightVisibleQuestions = () => {
  let highlightedCount = 0;

  questions.forEach(question => {
    if (!isObjectReference(question?.questionDiv) || question.skip)
      return;

    const visibilityTarget = question.questionElement || question.questionDiv;

    if (question.questionDiv.isConnected === false || !isVisibleElement(visibilityTarget))
      return;

    if (highlightQuestion(question))
      highlightedCount++;
  });

  return highlightedCount;
};

const main = async checklist => {
  const checklistTitle = checklist?.document.title;
  await ensurePreferencesLoaded();
  await setFinalExamComponentsFromStorage();

  // Re-assert the badge in case a page re-render dropped it.
  ensureModeBadge();

  const tabControls = getTabControls();
  if (!checklist && tabControls?.dataset.checklistRunning)
    return;

  if (checklist) {
    checklist.signal.throwIfAborted();
    if (checklist.document.title !== checklistTitle)
      return;
    // Graded question counters are not chapter self-checks.
    const roots = [checklist.document.body, ...deepHtmlSearchAll(checklist.document, '*').map(element => element.shadowRoot)];
    if (roots.some(root => root &&
      /\d+\s*of\s*\d+\s*questions?/.test(normalizeElementText(root.textContent))))
      throw new Error('An assessment is open. Complete it manually; the checklist did not submit it.');
  }

  questions = [];
  const isAtLeaseOneSet = await setQuestionSections();

  if (!isAtLeaseOneSet) {
    // Nothing to solve yet (components or the question DOM are still loading).
    // If a solve was requested, keep it outstanding and retry shortly instead
    // of dropping it - otherwise a single tap on a fresh page does nothing.
    if (solveRequested)
      scheduleSolveRetry();

    return;
  }

  setQuestionElements();

  if (checklist) {
    if (checklist.signal.aborted || checklist.document.title !== checklistTitle)
      return;
    const allowed = checklist.scope && new Set(deepHtmlSearchAll(checklist.scope, '*'));
    questions = questions.filter(question => question.questionDiv?.ownerDocument === checklist.document
      && (!allowed || allowed.has(question.questionDiv)));
    highlightVisibleQuestions();
    autoSolveVisibleQuestions();
    for (const question of questions) {
      if (question.questionDiv.isConnected && autoSolvedQuestions.has(question.questionDiv))
        submitAnswers(question.questionDiv, true);
    }
    return;
  }

  highlightVisibleQuestions();

  if ((tabControls?.dataset.mode || mode) === 'brutal') {
    // Brutal: solve and submit on every run, no hotkey needed. The
    // autoSolvedQuestions set (and the submit debounce) keep repeat runs from
    // re-clicking answers or double-submitting.
    solveRequested = false;
    const { selected, considered } = autoSolveVisibleQuestions();
    const forceSubmit = brutalForceSubmit;
    brutalForceSubmit = false;

    // Continuous runs submit only when they selected something new. An
    // explicit switch to brutal (forceSubmit) submits as long as there are
    // visible questions to submit - even if every answer was already
    // selected. No visible questions at all = nothing to submit.
    if (selected > 0 || (forceSubmit && considered > 0))
      submitAnswers();
  } else if (solveRequested) {
    solveRequested = false;
    autoSolveVisibleQuestions();
  }
};

let solveRetryTimer = null;

// Retry an outstanding solve request until the questions are actually present.
// Bounded, so it can never spin forever on a page with no solvable questions.
const scheduleSolveRetry = (attempt = 1) => {
  if (solveRetryTimer || attempt > 20 || !solveRequested)
    return;

  solveRetryTimer = setTimeout(() => {
    solveRetryTimer = null;

    if (isSuspendRunning) {
      scheduleSolveRetry(attempt + 1);
      return;
    }

    if (components.length === 0) {
      scheduleSolveRetry(attempt + 1);
      return;
    }

    suspendMain();
  }, 250);
};

const suspendMain = checklist => {
  if (isSuspendRunning) {
    isQuestionRefreshPending = true;
    return;
  }

  isSuspendRunning = true;

  return main(checklist)
    .catch(e => {
      if (checklist)
        throw e;
      if (!isExtensionContextInvalidatedError(e))
        console.error(e);
    })
    .finally(() => {
      isSuspendRunning = false;

      if (isQuestionRefreshPending) {
        isQuestionRefreshPending = false;
        queueQuestionRefresh();
      }
    });
};

const observedQuestionScopes = new WeakSet();
let questionRefreshTimer = null;
let isQuestionRefreshPending = false;
let lastVisibleSignature = null;

const observeQuestionScope = scope => {
  if (!scope?.querySelectorAll || observedQuestionScopes.has(scope))
    return;

  observedQuestionScopes.add(scope);

  try {
    new MutationObserver(records => {
      // Settings text and switches are not question changes.
      if (records.some(record => !record.target.closest?.(`#${MODE_CONTROLS_ID}`)))
        queueQuestionRefresh();
    }).observe(scope, {
      childList: true,
      subtree: true
    });
  } catch (e) {
  }
};

const observeNestedQuestionScopes = scope => {
  observeQuestionScope(scope);

  const elements = scope?.querySelectorAll?.('*') || [];
  elements.forEach(element => {
    if (element.shadowRoot)
      observeNestedQuestionScopes(element.shadowRoot);

    if (element.tagName?.toLowerCase() === 'iframe') {
      try {
        if (element.contentDocument)
          observeNestedQuestionScopes(element.contentDocument);
      } catch (e) {
      }
    }
  });
};

const queueQuestionRefresh = () => {
  if (questionRefreshTimer)
    return;

  questionRefreshTimer = setTimeout(() => {
    questionRefreshTimer = null;

    try {
      observeNestedQuestionScopes(document);
    } catch (e) {
    }

    if (components.length === 0)
      return;

    if (isSuspendRunning) {
      isQuestionRefreshPending = true;
      return;
    }

    suspendMain();
  }, QUESTION_REFRESH_DEBOUNCE);
};

const SOLVE_DEBOUNCE = 400;
let lastSolveAt = 0;

// A solve that could not run yet (components still loading, or the question DOM
// not rendered yet) stays outstanding until a run actually sees the questions.
// This is what makes a single tap work on a freshly loaded page instead of
// appearing to need a held key.
let solveRequested = false;

// One Ctrl+Shift+Y press reaches us twice: once from the in-page keydown
// handler and once from the manifest command routed through the background
// script. Collapse both into a single solve.
const requestSolve = () => {
  if (getTabControls()?.dataset.checklistRunning)
    return;
  const now = Date.now();

  if (now - lastSolveAt < SOLVE_DEBOUNCE)
    return;

  lastSolveAt = now;
  solveRequested = true;

  requestHighlight();
};

const requestHighlight = () => {
  // Deliberately no "components.length === 0" bail-out: main() loads the
  // course URLs from storage first, and the request is retried by later runs,
  // so pressing the hotkey on a freshly loaded page still solves.
  suspendMain();
};

// Compute a stable signature of which components are currently visible, so the
// periodic safety-net poll only triggers a refresh when the visible set of
// questions actually changes. Comparing against the previous signature (rather
// than against the internal question list) prevents a perpetual refresh loop.
const computeVisibleSignature = async () => {
  try {
    const visibleContainers = await findVisibleFromComponents(document, components);
    return [...visibleContainers].sort().join('|');
  } catch (e) {
    return null;
  }
};

if (window) {
  document.addEventListener('keydown', event => {
    if (!event.ctrlKey || !event.shiftKey || event.altKey)
      return;

    const key = event.key.toLowerCase();

    // Holding the key down produces auto-repeat keydown events. Act on the
    // first one only, so a single tap always works and holding cannot spam.
    if (event.repeat)
      return;

    if (key === 'y') {
      event.preventDefault();
      requestSolve();
    } else if (key === 'h') {
      event.preventDefault();
      toggleHighlights();
    } else if (key === 'm') {
      event.preventDefault();
      toggleMode();
    }
  }, true);

  document.addEventListener('pointerdown', event => {
    const controls = document.getElementById(MODE_CONTROLS_ID);
    if (controls?.open && !controls.contains(event.target))
      controls.open = false;
  }, true);

  // Restore preferences before showing the controls. main() shares this read.
  void ensurePreferencesLoaded().then(ensureModeBadge);

  // The content script runs at document_start, before <body> exists; create
  // the mode badge as soon as the body does.
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', () => {
      void ensurePreferencesLoaded().then(ensureModeBadge);
    }, { once: true });

  try {
    observeNestedQuestionScopes(document);
  } catch (e) {
  }

  setInterval(async () => {
    if (isSuspendRunning || components.length === 0)
      return;

    const signature = await computeVisibleSignature();

    if (signature === null || signature === lastVisibleSignature)
      return;

    lastVisibleSignature = signature;
    suspendMain();
  }, 1500);

  setInterval(() => {
    try {
      enableTextSelectionRecursive();
    } catch (e) {
    }
  }, 5000);
}
