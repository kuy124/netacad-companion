/**
 * NetAcad Solver — stress test suite
 *
 * Loads the built content script (dist/content.js) into a simulated NetAcad
 * page via jsdom and verifies the extension is stable: it highlights the
 * correct answer(s) and NEVER selects or submits anything on its own.
 *
 * Usage:
 *   npm run build && npm test
 *
 * Requires jsdom (a devDependency).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const bundle = fs.readFileSync(path.join(REPO, 'dist/content.js'), 'utf8');

const COMPONENT_URL =
  'https://www.netacad.com/content/cse3/1.0/courses/content/final-exam-ilt/en-US/components.json';
const H = 'netacad-solver-highlight';

let totalPass = 0;
let totalFail = 0;
const failures = [];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeEnv({ components, html, id = 'test', storedVisible, storedMode } = {}) {
  const dom = new JSDOM(html, {
    url: `https://www.netacad.com/quiz?id=${id}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  let rectCalls = 0;
  window.Element.prototype.getBoundingClientRect = function () {
    rectCalls++;
    return { width: 100, height: 20, top: 10, left: 10, right: 110, bottom: 30, x: 10, y: 10, toJSON() {} };
  };

  if (!window.CSS) window.CSS = {};
  if (!window.CSS.escape) {
    window.CSS.escape = s => String(s).replace(/[^a-zA-Z0-9_-]/g, ch => '\\' + ch);
  }

  const clicks = [];
  const programmaticClicks = [];
  window.document.addEventListener('click', e => {
    const t = e.target;
    clicks.push(t.id || `${t.tagName}${t.dataset?.id ? `[${t.dataset.id}]` : ''}`);
  }, true);
  const origClick = window.HTMLElement.prototype.click;
  window.HTMLElement.prototype.click = function (...args) {
    programmaticClicks.push(this.id || this.tagName);
    return origClick.apply(this, args);
  };

  const storageSets = [];
  let messageListener = null;
  window.chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: undefined,
      onMessage: { addListener(fn) { messageListener = fn; } },
      sendMessage() {},
    },
    storage: {
      local: {
        get(key, cb) {
          const result = { 'service-test': [COMPONENT_URL] };
          if (typeof storedVisible === 'boolean')
            result['netacad-solver-highlights-visible'] = storedVisible;
          if (storedMode)
            result['netacad-solver-mode'] = storedMode;
          cb(result);
        },
        set(obj) { storageSets.push(obj); },
      },
    },
  };

  window.fetch = async url => {
    if (String(url).includes('components.json')) {
      return { ok: true, json: async () => JSON.parse(JSON.stringify(components)) };
    }
    return { ok: false, json: async () => [] };
  };

  window.eval(bundle);
  if (messageListener) messageListener({ componentsUrl: COMPONENT_URL });

  const bgVar = () => window.document.documentElement.style.getPropertyValue('--netacad-hl-bg');

  return {
    window,
    doc: window.document,
    clicks,
    programmaticClicks,
    storageSets,
    bgVar,
    rectCalls: () => rectCalls,
    trigger: async () => {
      window.document.dispatchEvent(new window.KeyboardEvent('keydown', {
        key: 'y', ctrlKey: true, shiftKey: true, bubbles: true,
      }));
    },
    toggle: async () => {
      window.document.dispatchEvent(new window.KeyboardEvent('keydown', {
        key: 'h', ctrlKey: true, shiftKey: true, bubbles: true,
      }));
    },
    toggleMode: async () => {
      window.document.dispatchEvent(new window.KeyboardEvent('keydown', {
        key: 'm', ctrlKey: true, shiftKey: true, bubbles: true,
      }));
    },
    // A single, ordinary tap (no auto-repeat flag) - what a real quick press
    // produces.
    tap: async () => {
      window.document.dispatchEvent(new window.KeyboardEvent('keydown', {
        key: 'y', ctrlKey: true, shiftKey: true, bubbles: true,
      }));
    },
    // Holding the key down: the browser fires one initial keydown (repeat=false)
    // followed by repeated keydown events with repeat=true.
    hold: async (times = 12) => {
      window.document.dispatchEvent(new window.KeyboardEvent('keydown', {
        key: 'y', ctrlKey: true, shiftKey: true, repeat: false, bubbles: true,
      }));
      for (let i = 0; i < times; i++) {
        window.document.dispatchEvent(new window.KeyboardEvent('keydown', {
          key: 'y', ctrlKey: true, shiftKey: true, repeat: true, bubbles: true,
        }));
      }
    },
    close: () => dom.window.close(),
  };
}

function scenario(name) {
  const results = [];
  const check = (label, cond, detail = '') => {
    results.push({ label, pass: !!cond, detail });
  };
  return {
    check,
    finish() {
      const failed = results.filter(r => !r.pass);
      totalPass += results.length - failed.length;
      totalFail += failed.length;
      console.log(`\n=== ${name} ===`);
      results.forEach(r => {
        if (!r.pass) {
          console.log(`  FAIL  ${r.label}${r.detail ? '  -> ' + r.detail : ''}`);
          failures.push(`${name}: ${r.label}`);
        } else {
          console.log(`  PASS  ${r.label}`);
        }
      });
      console.log(`  ${results.length - failed.length}/${results.length} passed`);
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario A: Scale — 200 mixed questions
// ---------------------------------------------------------------------------
async function scenarioScale() {
  const s = scenario('A. Scale (200 questions)');
  const components = [];
  let html = '<!DOCTYPE html><html><head></head><body>';
  const N_BASIC = 100, N_MATCH = 50, N_DROP = 50;
  const expected = { basic: 0, match: 0, drop: 0 };

  for (let i = 0; i < N_BASIC; i++) {
    const id = `b${i}`;
    components.push({
      _id: id, _component: 'mcq', body: `<p>Body ${i}</p>`,
      _items: [
        { text: `<p>OptA${i}</p>`, _shouldBeSelected: true },
        { text: `<p>OptB${i}</p>`, _shouldBeSelected: false },
        { text: `<p>OptC${i}</p>`, _shouldBeSelected: i % 2 === 0 },
      ],
    });
    html += `<div class="${id}"><div>Body ${i}</div>`;
    for (let j = 0; j < 3; j++) {
      html += `<div><input type="checkbox" id="${id}-${j}-input"><label id="${id}-${j}-label" for="${id}-${j}-input">Opt${['A','B','C'][j]}${i}</label></div>`;
    }
    html += `</div>`;
    expected.basic += 1 + (i % 2 === 0 ? 1 : 0);
  }

  for (let i = 0; i < N_MATCH; i++) {
    const id = `m${i}`;
    components.push({
      _id: id, _component: 'matching', body: `<p>Match ${i}</p>`,
      _items: [{ question: '<p>L0</p>', answer: '<p>R0</p>' }, { question: '<p>L1</p>', answer: '<p>R1</p>' }],
    });
    html += `<div class="${id}"><div>Match ${i}</div>`;
    for (let j = 0; j < 2; j++) {
      html += `<button data-id="${j}">L${j}</button><button data-id="${j}">R${j}</button>`;
    }
    html += `</div>`;
    expected.match += 4;
  }

  for (let i = 0; i < N_DROP; i++) {
    const id = `d${i}`;
    components.push({
      _id: id, _component: 'dropdown', body: `<p>Drop ${i}</p>`,
      _items: [{ text: `DropQ${i}`, _options: [{ text: 'Wrong', _isCorrect: false }, { text: 'Right', _isCorrect: true }] }],
    });
    html += `<div class="${id}"><div index="0"><span>DropQ${i}</span><div id="dropdown__item-index-0">Wrong</div><div id="dropdown__item-index-1">Right</div></div></div>`;
    expected.drop += 1;
  }
  html += '</body></html>';

  const env = makeEnv({ components, html, id: 'scale' });
  const expectedTotal = expected.basic + expected.match + expected.drop;

  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    if (env.doc.querySelectorAll(`.${H}`).length >= expectedTotal) break;
    await sleep(50);
  }
  const elapsed = Date.now() - t0;
  const doc = env.doc;

  const highlighted = doc.querySelectorAll(`.${H}`).length;

  let basicHl = 0, matchHl = 0, dropHl = 0;
  for (let i = 0; i < N_BASIC; i++) {
    for (let j = 0; j < 3; j++) {
      if (doc.getElementById(`b${i}-${j}-label`)?.classList.contains(H)) basicHl++;
    }
  }
  for (let i = 0; i < N_MATCH; i++) {
    const div = doc.querySelector(`.m${i}`);
    if (div) matchHl += div.querySelectorAll(`.${H}`).length;
  }
  for (let i = 0; i < N_DROP; i++) {
    if (doc.querySelector(`.d${i} [id="dropdown__item-index-1"]`)?.classList.contains(H)) dropHl++;
  }
  console.log(`    [scale] basic=${basicHl}/${expected.basic} match=${matchHl}/${expected.match} drop=${dropHl}/${expected.drop} in ${elapsed}ms`);

  s.check('all expected answers highlighted', highlighted === expectedTotal, `got ${highlighted}, want ${expectedTotal}`);
  s.check('all basic answers highlighted', basicHl === expected.basic, `${basicHl}/${expected.basic}`);
  s.check('all match answers highlighted', matchHl === expected.match, `${matchHl}/${expected.match}`);
  s.check('all dropdown answers highlighted', dropHl === expected.drop, `${dropHl}/${expected.drop}`);
  s.check('no wrong basic option highlighted', !doc.getElementById('b0-1-label')?.classList.contains(H));
  s.check('zero input clicks', !env.clicks.some(c => c.includes('-input')));
  s.check('zero submit clicks', !env.clicks.some(c => c === 'submit'));
  s.check('perf: 200 questions processed under 8s', elapsed < 8000, `${elapsed}ms`);
  s.check('exactly one stylesheet', doc.querySelectorAll('style[data-netacad-solver-highlight]').length === 1);

  s.finish();
  env.close();
}

// ---------------------------------------------------------------------------
// Scenario B: Idempotency / no unbounded loop
// ---------------------------------------------------------------------------
async function scenarioIdempotency() {
  const s = scenario('B. Idempotency & loop-freedom');
  const components = [{
    _id: 'q1', _component: 'mcq', body: '<p>Body</p>',
    _items: [{ text: '<p>A</p>', _shouldBeSelected: true }, { text: '<p>B</p>', _shouldBeSelected: false }],
  }];
  const html = `<!DOCTYPE html><html><body><div class="q1"><div>Body</div>
    <input type="checkbox" id="q1-0-input"><label id="q1-0-label" for="q1-0-input">A</label>
    <input type="checkbox" id="q1-1-input"><label id="q1-1-label" for="q1-1-input">B</label>
  </div></body></html>`;

  const env = makeEnv({ components, html, id: 'idem' });
  await sleep(600);

  const before = env.doc.querySelectorAll(`.${H}`).length;

  for (let i = 0; i < 40; i++) await env.trigger();
  for (let i = 0; i < 20; i++) {
    const d = env.doc.createElement('div');
    env.doc.body.appendChild(d);
    env.doc.body.removeChild(d);
  }
  await sleep(1500);

  const after = env.doc.querySelectorAll(`.${H}`).length;
  const stylesAfter = env.doc.querySelectorAll('style[data-netacad-solver-highlight]').length;

  s.check('highlight count stable after storm', after === before, `${before} -> ${after}`);
  s.check('stylesheet count stays 1', stylesAfter === 1, `got ${stylesAfter}`);

  const r1 = env.rectCalls();
  await sleep(2000);
  const r2 = env.rectCalls();
  const growth = r2 - r1;
  s.check('no busy-loop while idle (rect growth bounded)', growth < 200, `growth=${growth} over 2s`);
  s.check('still exactly one highlight after idle', env.doc.querySelectorAll(`.${H}`).length === 1);

  s.finish();
  env.close();
}

// ---------------------------------------------------------------------------
// Scenario C: Shadow DOM
// ---------------------------------------------------------------------------
async function scenarioShadow() {
  const s = scenario('C. Shadow DOM');
  const components = [{
    _id: 'sq', _component: 'mcq', body: '<p>Shadow body</p>',
    _items: [{ text: '<p>SA</p>', _shouldBeSelected: true }, { text: '<p>SB</p>', _shouldBeSelected: false }],
  }];
  const html = `<!DOCTYPE html><html><body><div id="host"></div></body></html>`;
  const env = makeEnv({ components, html, id: 'shadow' });
  const doc = env.doc;

  const host = doc.getElementById('host');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<div class="sq"><div>Shadow body</div>
    <input type="checkbox" id="sq-0-input"><label id="sq-0-label" for="sq-0-input">SA</label>
    <input type="checkbox" id="sq-1-input"><label id="sq-1-label" for="sq-1-input">SB</label></div>`;

  await env.trigger();
  await sleep(700);

  s.check('shadow: correct option highlighted', root.getElementById('sq-0-label')?.classList.contains(H));
  s.check('shadow: wrong option not highlighted', !root.getElementById('sq-1-label')?.classList.contains(H));
  s.check('shadow: stylesheet injected into shadow root', !!root.querySelector('style[data-netacad-solver-highlight]'));
  s.check('shadow: no submit click', !env.clicks.includes('submit'));

  s.finish();
  env.close();
}

// ---------------------------------------------------------------------------
// Scenario D: Iframe
// ---------------------------------------------------------------------------
async function scenarioIframe() {
  const s = scenario('D. Iframe');
  const components = [{
    _id: 'fq', _component: 'mcq', body: '<p>Frame body</p>',
    _items: [{ text: '<p>FA</p>', _shouldBeSelected: true }, { text: '<p>FB</p>', _shouldBeSelected: false }],
  }];
  const html = `<!DOCTYPE html><html><body><iframe id="fr"></iframe></body></html>`;
  const env = makeEnv({ components, html, id: 'iframe' });
  const doc = env.doc;

  const iframe = doc.getElementById('fr');
  const idoc = iframe.contentDocument;

  const iwin = iframe.contentWindow;
  iwin.Element.prototype.getBoundingClientRect = function () {
    return { width: 100, height: 20, top: 10, left: 10, right: 110, bottom: 30, x: 10, y: 10, toJSON() {} };
  };
  if (!iwin.CSS) iwin.CSS = {};
  if (!iwin.CSS.escape) iwin.CSS.escape = s2 => String(s2).replace(/[^a-zA-Z0-9_-]/g, ch => '\\' + ch);

  idoc.body.innerHTML = `<div class="fq"><div>Frame body</div>
    <input type="checkbox" id="fq-0-input"><label id="fq-0-label" for="fq-0-input">FA</label>
    <input type="checkbox" id="fq-1-input"><label id="fq-1-label" for="fq-1-input">FB</label></div>`;

  await env.trigger();
  await sleep(700);

  s.check('iframe: correct option highlighted', idoc.getElementById('fq-0-label')?.classList.contains(H));
  s.check('iframe: wrong option not highlighted', !idoc.getElementById('fq-1-label')?.classList.contains(H));
  s.check('iframe: no submit click', !env.clicks.includes('submit'));

  s.finish();
  env.close();
}

// ---------------------------------------------------------------------------
// Scenario E: Visibility
// ---------------------------------------------------------------------------
async function scenarioVisibility() {
  const s = scenario('E. Visibility');
  const components = [{
    _id: 'vq', _component: 'mcq', body: '<p>Vis body</p>',
    _items: [{ text: '<p>VA</p>', _shouldBeSelected: true }],
  }];
  const html = `<!DOCTYPE html><html><body>
    <div class="vq" id="vdiv" style="display:none"><div>Vis body</div>
      <input type="checkbox" id="vq-0-input"><label id="vq-0-label" for="vq-0-input">VA</label></div>
  </body></html>`;
  const env = makeEnv({ components, html, id: 'vis' });
  const doc = env.doc;

  await sleep(600);
  s.check('hidden question not highlighted', !doc.getElementById('vq-0-label')?.classList.contains(H));

  doc.getElementById('vdiv').style.display = '';
  await env.trigger();
  await sleep(600);
  s.check('question highlighted once visible', doc.getElementById('vq-0-label')?.classList.contains(H));

  s.finish();
  env.close();
}

// ---------------------------------------------------------------------------
// Scenario F: Edge cases
// ---------------------------------------------------------------------------
async function scenarioEdges() {
  const s = scenario('F. Edge cases');
  const components = [
    { _id: 'all', _component: 'mcq', body: '<p>All correct</p>',
      _items: [{ text: '<p>A1</p>', _shouldBeSelected: true }, { text: '<p>A2</p>', _shouldBeSelected: true }] },
    { _id: 'none', _component: 'mcq', body: '<p>None correct</p>',
      _items: [{ text: '<p>N1</p>', _shouldBeSelected: false }] },
    { _id: 'emptymatch', _component: 'matching', body: '<p>Empty match</p>', _items: [] },
    { _id: 'missingdom', _component: 'mcq', body: '<p>No DOM</p>',
      _items: [{ text: '<p>X</p>', _shouldBeSelected: true }] },
    { _id: 'dromiss', _component: 'dropdown', body: '<p>Drop missing</p>',
      _items: [{ text: 'DM', _options: [{ text: 'w', _isCorrect: false }, { text: 'c', _isCorrect: true }] }] },
  ];
  const html = `<!DOCTYPE html><html><body>
    <div class="all"><div>All correct</div>
      <input type="checkbox" id="all-0-input"><label id="all-0-label" for="all-0-input">A1</label>
      <input type="checkbox" id="all-1-input"><label id="all-1-label" for="all-1-input">A2</label></div>
    <div class="none"><div>None correct</div>
      <input type="checkbox" id="none-0-input"><label id="none-0-label" for="none-0-input">N1</label></div>
    <div class="emptymatch"><div>Empty match</div></div>
    <div class="dromiss"><div index="0"><span>DM</span><div id="dropdown__item-index-0">w</div></div></div>
  </body></html>`;
  const env = makeEnv({ components, html, id: 'edges' });
  const doc = env.doc;

  await sleep(700);

  s.check('all-correct: both highlighted', doc.getElementById('all-0-label')?.classList.contains(H) && doc.getElementById('all-1-label')?.classList.contains(H));
  s.check('none-correct: nothing highlighted', !doc.getElementById('none-0-label')?.classList.contains(H));
  s.check('edge: did not crash (later valid q processed)', doc.getElementById('all-0-label')?.classList.contains(H));
  s.check('edge: no submit click', !env.clicks.includes('submit'));

  s.finish();
  env.close();
}

// ---------------------------------------------------------------------------
// Scenario G: Interaction storm (drag / clicks must not reset or submit)
// ---------------------------------------------------------------------------
async function scenarioInteractionStorm() {
  const s = scenario('G. Interaction storm');
  const components = [{
    _id: 'iq', _component: 'mcq', body: '<p>Int body</p>',
    _items: [{ text: '<p>IA</p>', _shouldBeSelected: true }, { text: '<p>IB</p>', _shouldBeSelected: false }],
  }];
  const html = `<!DOCTYPE html><html><body><div class="iq" id="iqdiv"><div>Int body</div>
    <input type="checkbox" id="iq-0-input"><label id="iq-0-label" for="iq-0-input">IA</label>
    <input type="checkbox" id="iq-1-input"><label id="iq-1-label" for="iq-1-input">IB</label>
    <button id="submit">Submit</button>
  </div></body></html>`;
  const env = makeEnv({ components, html, id: 'storm' });
  const doc = env.doc;
  await sleep(600);

  doc.getElementById('iq-1-input').click();
  const userChecked = doc.getElementById('iq-1-input').checked;
  env.clicks.length = 0;
  env.programmaticClicks.length = 0;

  const fire = (el, type) => el.dispatchEvent(new env.window.MouseEvent(type, { bubbles: true, clientX: 20, clientY: 20 }));
  fire(doc.getElementById('iqdiv'), 'mousedown');
  for (let i = 0; i < 30; i++) {
    fire(doc.body, 'mousemove');
    fire(doc.getElementById('iq-0-label'), 'click');
    fire(doc.body, 'click');
    fire(doc.body, 'pointerdown');
  }
  fire(doc.getElementById('iqdiv'), 'mouseup');
  await sleep(800);

  s.check('user selection preserved (not reset)', doc.getElementById('iq-1-input').checked === userChecked && userChecked === true);
  s.check('highlight persists through storm', doc.getElementById('iq-0-label')?.classList.contains(H));
  s.check('no auto-submit during storm', !env.clicks.includes('submit'));
  s.check('extension made zero programmatic .click() calls',
    env.programmaticClicks.length === 0, env.programmaticClicks.join(','));

  s.finish();
  env.close();
}

// ---------------------------------------------------------------------------
// Scenario H: Error resilience
// ---------------------------------------------------------------------------
async function scenarioErrors() {
  const s = scenario('H. Error resilience');
  const components = [{
    _id: 'eq', _component: 'mcq', body: '<p>Err body</p>',
    _items: [{ text: '<p>EA</p>', _shouldBeSelected: true }],
  }];
  const html = `<!DOCTYPE html><html><body><div class="eq" id="eqdiv"><div>Err body</div>
    <input type="checkbox" id="eq-0-input"><label id="eq-0-label" for="eq-0-input">EA</label>
  </div></body></html>`;
  const env = makeEnv({ components, html, id: 'err' });

  env.doc.getElementById('eq-0-label').getBoundingClientRect = () => { throw new Error('boom'); };

  let crashed = false;
  try {
    await env.trigger();
    await sleep(700);
  } catch (e) {
    crashed = true;
  }

  s.check('no unhandled crash when rect throws', !crashed);
  env.doc.getElementById('eq-0-label').getBoundingClientRect = env.window.Element.prototype.getBoundingClientRect;
  await env.trigger();
  await sleep(600);
  s.check('recovers after error', env.doc.getElementById('eq-0-label')?.classList.contains(H));

  s.finish();
  env.close();
}

// ---------------------------------------------------------------------------
// Scenario I: Unicode / HTML-in-text
// ---------------------------------------------------------------------------
async function scenarioText() {
  const s = scenario('I. Unicode & HTML text');
  const components = [{
    _id: 'tq', _component: 'mcq', body: '<p>Ünïcödé 🐱 <b>body</b></p>',
    _items: [
      { text: '<p>日本語 <b>テスト</b></p>', _shouldBeSelected: true },
      { text: '<p>emoji 🎉 &amp; amp</p>', _shouldBeSelected: false },
    ],
  }];
  const html = `<!DOCTYPE html><html><body><div class="tq"><div>Ünïcödé 🐱 <b>body</b></div>
    <input type="checkbox" id="tq-0-input"><label id="tq-0-label" for="tq-0-input">日本語 <b>テスト</b></label>
    <input type="checkbox" id="tq-1-input"><label id="tq-1-label" for="tq-1-input">emoji 🎉 &amp; amp</label>
  </div></body></html>`;
  const env = makeEnv({ components, html, id: 'text' });
  await sleep(700);

  s.check('unicode correct option highlighted', env.doc.getElementById('tq-0-label')?.classList.contains(H));
  s.check('unicode wrong option not highlighted', !env.doc.getElementById('tq-1-label')?.classList.contains(H));

  s.finish();
  env.close();
}

// ---------------------------------------------------------------------------
// Scenario J: SPA navigation — question DOM replaced entirely
// ---------------------------------------------------------------------------
async function scenarioSpaReplace() {
  const s = scenario('J. SPA DOM replacement');
  const components = [{
    _id: 'sq', _component: 'mcq', body: '<p>SPA body</p>',
    _items: [{ text: '<p>SA</p>', _shouldBeSelected: true }, { text: '<p>SB</p>', _shouldBeSelected: false }],
  }];
  const html = `<!DOCTYPE html><html><body><main id="app"></main></body></html>`;
  const env = makeEnv({ components, html, id: 'spa' });
  const doc = env.doc;

  const render = () => {
    doc.getElementById('app').innerHTML = `<div class="sq"><div>SPA body</div>
      <input type="checkbox" id="sq-0-input"><label id="sq-0-label" for="sq-0-input">SA</label>
      <input type="checkbox" id="sq-1-input"><label id="sq-1-label" for="sq-1-input">SB</label></div>`;
  };
  render();
  await env.trigger();
  await sleep(700);
  s.check('first render highlighted', doc.getElementById('sq-0-label')?.classList.contains(H));

  for (let i = 0; i < 10; i++) {
    render();
    await sleep(300);
  }
  await sleep(700);
  s.check('after 10 replacements, highlighted', doc.getElementById('sq-0-label')?.classList.contains(H));
  s.check('after 10 replacements, wrong not highlighted', !doc.getElementById('sq-1-label')?.classList.contains(H));
  s.check('after 10 replacements, still one stylesheet', doc.querySelectorAll('style[data-netacad-solver-highlight]').length === 1);
  s.check('after 10 replacements, no submit', !env.clicks.includes('submit'));

  s.finish();
  env.close();
}

// ---------------------------------------------------------------------------
// Scenario K: Extreme scale — 1000 basic questions
// ---------------------------------------------------------------------------
async function scenarioExtremeScale() {
  const s = scenario('K. Extreme scale (1000 questions)');
  const components = [];
  let html = '<!DOCTYPE html><html><body>';
  for (let i = 0; i < 1000; i++) {
    const id = `x${i}`;
    components.push({
      _id: id, _component: 'mcq', body: `<p>B${i}</p>`,
      _items: [{ text: `<p>A${i}</p>`, _shouldBeSelected: true }, { text: `<p>B${i}</p>`, _shouldBeSelected: false }],
    });
    html += `<div class="${id}"><div>B${i}</div>
      <input type="checkbox" id="${id}-0-input"><label id="${id}-0-label" for="${id}-0-input">A${i}</label>
      <input type="checkbox" id="${id}-1-input"><label id="${id}-1-label" for="${id}-1-input">B${i}</label></div>`;
  }
  html += '</body></html>';

  const env = makeEnv({ components, html, id: 'extreme' });
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    if (env.doc.querySelectorAll(`.${H}`).length >= 1000) break;
    await sleep(50);
  }
  const elapsed = Date.now() - t0;
  const hl = env.doc.querySelectorAll(`.${H}`).length;
  s.check('1000 questions all highlighted', hl === 1000, `got ${hl}`);
  s.check('1000 questions processed under 15s', elapsed < 15000, `${elapsed}ms`);
  s.check('no submit at scale', !env.clicks.includes('submit'));

  s.finish();
  env.close();
}

// ---------------------------------------------------------------------------
// Scenario L: Deep nested shadow DOM (3 levels)
// ---------------------------------------------------------------------------
async function scenarioDeepShadow() {
  const s = scenario('L. Deep nested shadow DOM');
  const components = [{
    _id: 'dq', _component: 'mcq', body: '<p>Deep body</p>',
    _items: [{ text: '<p>DA</p>', _shouldBeSelected: true }, { text: '<p>DB</p>', _shouldBeSelected: false }],
  }];
  const html = `<!DOCTYPE html><html><body><div id="l1"></div></body></html>`;
  const env = makeEnv({ components, html, id: 'deep' });
  const doc = env.doc;

  const r1 = doc.getElementById('l1').attachShadow({ mode: 'open' });
  const l2 = doc.createElement('div');
  r1.appendChild(l2);
  const r2 = l2.attachShadow({ mode: 'open' });
  const l3 = doc.createElement('div');
  r2.appendChild(l3);
  const r3 = l3.attachShadow({ mode: 'open' });
  r3.innerHTML = `<div class="dq"><div>Deep body</div>
    <input type="checkbox" id="dq-0-input"><label id="dq-0-label" for="dq-0-input">DA</label>
    <input type="checkbox" id="dq-1-input"><label id="dq-1-label" for="dq-1-input">DB</label></div>`;

  await env.trigger();
  await sleep(800);

  s.check('deep shadow: correct option highlighted', r3.getElementById('dq-0-label')?.classList.contains(H));
  s.check('deep shadow: wrong not highlighted', !r3.getElementById('dq-1-label')?.classList.contains(H));
  s.check('deep shadow: no submit', !env.clicks.includes('submit'));

  s.finish();
  env.close();
}

// ---------------------------------------------------------------------------
// Scenario M: Label fallback path (no id-based label/input)
// ---------------------------------------------------------------------------
async function scenarioFallback() {
  const s = scenario('M. Label fallback');
  const components = [{
    _id: 'fb', _component: 'mcq', body: '<p>FB body</p>',
    _items: [{ text: '<p>Choice One</p>', _shouldBeSelected: true }, { text: '<p>Choice Two</p>', _shouldBeSelected: false }],
  }];
  const html = `<!DOCTYPE html><html><body><div class="fb"><div>FB body</div>
    <div class="o0"><input type="checkbox" id="inpA"><label for="inpA">Choice One</label></div>
    <div class="o1"><input type="checkbox" id="inpB"><label for="inpB">Choice Two</label></div>
  </div></body></html>`;
  const env = makeEnv({ components, html, id: 'fallback' });
  await sleep(800);

  const labelA = env.doc.querySelector('.o0 label');
  const labelB = env.doc.querySelector('.o1 label');
  s.check('fallback: correct label highlighted via text match', labelA?.classList.contains(H));
  s.check('fallback: wrong label not highlighted', !labelB?.classList.contains(H));

  s.finish();
  env.close();
}

// ---------------------------------------------------------------------------
// Scenario N: Rapid concurrent triggers
// ---------------------------------------------------------------------------
async function scenarioConcurrentTriggers() {
  const s = scenario('N. Concurrent triggers');
  const components = [{
    _id: 'cq', _component: 'mcq', body: '<p>Conc body</p>',
    _items: [{ text: '<p>CA</p>', _shouldBeSelected: true }, { text: '<p>CB</p>', _shouldBeSelected: false }],
  }];
  const html = `<!DOCTYPE html><html><body><div class="cq"><div>Conc body</div>
    <input type="checkbox" id="cq-0-input"><label id="cq-0-label" for="cq-0-input">CA</label>
    <input type="checkbox" id="cq-1-input"><label id="cq-1-label" for="cq-1-input">CB</label>
  </div></body></html>`;
  const env = makeEnv({ components, html, id: 'conc' });
  await sleep(500);

  for (let i = 0; i < 200; i++) {
    env.window.document.dispatchEvent(new env.window.KeyboardEvent('keydown', {
      key: 'y', ctrlKey: true, shiftKey: true, bubbles: true,
    }));
  }
  await sleep(1500);

  const hl = env.doc.querySelectorAll(`.${H}`).length;
  s.check('concurrent: exactly one highlight (idempotent)', hl === 1, `got ${hl}`);
  s.check('concurrent: stylesheet count 1', env.doc.querySelectorAll('style[data-netacad-solver-highlight]').length === 1);
  s.check('concurrent: no submit', !env.clicks.includes('submit'));

  s.finish();
  env.close();
}

// ---------------------------------------------------------------------------
// Scenario O: Resilience when storage/chrome APIs are unavailable
// ---------------------------------------------------------------------------
async function scenarioNoChrome() {
  const s = scenario('O. Missing chrome/storage APIs');
  const components = [{
    _id: 'nc', _component: 'mcq', body: '<p>NC body</p>',
    _items: [{ text: '<p>NA</p>', _shouldBeSelected: true }],
  }];
  const html = `<!DOCTYPE html><html><body><div class="nc"><div>NC body</div>
    <input type="checkbox" id="nc-0-input"><label id="nc-0-label" for="nc-0-input">NA</label>
  </div></body></html>`;
  const dom = new JSDOM(html, { url: 'https://www.netacad.com/quiz?id=nochrome', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 20, top: 10, left: 10, right: 110, bottom: 30, x: 10, y: 10, toJSON() {} });
  if (!window.CSS) window.CSS = {};
  if (!window.CSS.escape) window.CSS.escape = s2 => String(s2).replace(/[^a-zA-Z0-9_-]/g, c => '\\' + c);
  window.fetch = async () => ({ ok: true, json: async () => JSON.parse(JSON.stringify(components)) });

  let crashed = false;
  try {
    window.eval(bundle);
  } catch (e) {
    crashed = true;
  }
  await sleep(600);
  s.check('no crash when chrome API missing', !crashed);
  s.check('page still functional', !!window.document.getElementById('nc-0-label'));

  s.finish();
  dom.window.close();
}

// ---------------------------------------------------------------------------
// Scenario P: No perpetual refresh loop (regression for dropdown sub-questions)
// ---------------------------------------------------------------------------
async function scenarioNoRefreshLoop() {
  const s = scenario('P. No perpetual refresh loop');
  const components = [
    { _id: 'b0', _component: 'mcq', body: '<p>Body 0</p>',
      _items: [{ text: '<p>A0</p>', _shouldBeSelected: true }, { text: '<p>B0</p>', _shouldBeSelected: false }] },
    { _id: 'd0', _component: 'dropdown', body: '<p>Drop 0</p>',
      _items: [{ text: 'DropQ0', _options: [{ text: 'Wrong', _isCorrect: false }, { text: 'Right', _isCorrect: true }] }] },
  ];
  const html = `<!DOCTYPE html><body>
    <div class="b0"><div>Body 0</div>
      <input type="checkbox" id="b0-0-input"><label id="b0-0-label" for="b0-0-input">A0</label>
      <input type="checkbox" id="b0-1-input"><label id="b0-1-label" for="b0-1-input">B0</label></div>
    <div class="d0"><div index="0"><span>DropQ0</span>
      <div id="dropdown__item-index-0">Wrong</div><div id="dropdown__item-index-1">Right</div></div></div>
  </body>`;

  const env = makeEnv({ components, html, id: 'loop' });
  await sleep(3500); // let it settle

  // Sample DOM-scan activity per 1.5s interval; a repeating refresh would show up every window
  const samples = [];
  for (let i = 0; i < 6; i++) {
    const a = env.rectCalls();
    await sleep(1500);
    samples.push(env.rectCalls() - a);
  }

  const activeWindows = samples.filter(n => n > 0).length;
  s.check('no repeating refresh while idle (regression)', activeWindows <= 1, `samples=[${samples.join(',')}]`);
  s.check('highlights still correct after idle', env.doc.getElementById('b0-0-label')?.classList.contains(H));
  s.check('dropdown highlighted after idle', env.doc.querySelector('[id="dropdown__item-index-1"]')?.classList.contains(H));
  s.check('no submit while idle', !env.clicks.includes('submit'));

  s.finish();
  env.close();
}

// ---------------------------------------------------------------------------
// Scenario Q: Memory / bookkeeping stability across many navigations
// ---------------------------------------------------------------------------
async function scenarioMemoryStability() {
  const s = scenario('Q. Bookkeeping stability');
  const components = [{
    _id: 'mq', _component: 'mcq', body: '<p>Mem body</p>',
    _items: [{ text: '<p>MA</p>', _shouldBeSelected: true }, { text: '<p>MB</p>', _shouldBeSelected: false }],
  }];
  const html = `<!DOCTYPE html><html><body><main id="app"></main></body></html>`;
  const env = makeEnv({ components, html, id: 'mem' });
  const doc = env.doc;

  const render = () => {
    doc.getElementById('app').innerHTML = `<div class="mq"><div>Mem body</div>
      <input type="checkbox" id="mq-0-input"><label id="mq-0-label" for="mq-0-input">MA</label>
      <input type="checkbox" id="mq-1-input"><label id="mq-1-label" for="mq-1-input">MB</label></div>`;
  };

  // 60 full page re-renders; highlight must never accumulate duplicate stylesheets
  for (let i = 0; i < 60; i++) {
    render();
    if (i % 10 === 0) await sleep(120);
  }
  await sleep(900);

  s.check('after 60 re-renders: exactly one stylesheet',
    doc.querySelectorAll('style[data-netacad-solver-highlight]').length === 1,
    `count=${doc.querySelectorAll('style[data-netacad-solver-highlight]').length}`);
  s.check('after 60 re-renders: still highlighted', doc.getElementById('mq-0-label')?.classList.contains(H));
  s.check('after 60 re-renders: only one highlighted element', doc.querySelectorAll(`.${H}`).length === 1);
  s.check('after 60 re-renders: no submit', !env.clicks.includes('submit'));

  s.finish();
  env.close();
}

// ---------------------------------------------------------------------------
// Scenario R: Toggle highlights via hotkey
// ---------------------------------------------------------------------------
async function scenarioToggleHotkey() {
  const s = scenario('R. Toggle highlights (Ctrl+Shift+H)');
  const components = [{
    _id: 'q1', _component: 'mcq', body: '<p>Body</p>',
    _items: [{ text: '<p>A</p>', _shouldBeSelected: true }, { text: '<p>B</p>', _shouldBeSelected: false }],
  }];
  const html = `<!DOCTYPE html><body><div class="q1"><div>Body</div>
    <input type="checkbox" id="q1-0-input"><label id="q1-0-label" for="q1-0-input">A</label>
    <input type="checkbox" id="q1-1-input"><label id="q1-1-label" for="q1-1-input">B</label></div></body>`;
  const env = makeEnv({ components, html, id: 'toggle' });
  await sleep(700);

  const label = env.doc.getElementById('q1-0-label');
  const visibleBg = 'rgba(34, 197, 94, 0.16)';

  s.check('initially visible (class present)', label?.classList.contains(H));
  s.check('initially visible (bg var set)', env.bgVar() === visibleBg, env.bgVar());

  await env.toggle();
  await sleep(60);
  s.check('after toggle: hidden (bg var transparent)', env.bgVar() === 'transparent', env.bgVar());
  s.check('after toggle: class retained (O(1) hide)', label?.classList.contains(H));
  s.check('after toggle: preference persisted', JSON.stringify(env.storageSets).includes('"netacad-solver-highlights-visible":false'), JSON.stringify(env.storageSets));

  await sleep(500);
  await env.toggle();
  await sleep(60);
  s.check('after second toggle: visible again', env.bgVar() === visibleBg, env.bgVar());

  s.check('toggling never selects/submits', !env.clicks.includes('submit') && env.programmaticClicks.length === 0);

  s.finish();
  env.close();
}

// ---------------------------------------------------------------------------
// Scenario S: Hidden preference is restored on page load
// ---------------------------------------------------------------------------
async function scenarioTogglePersisted() {
  const s = scenario('S. Persisted hidden preference');
  const components = [{
    _id: 'q1', _component: 'mcq', body: '<p>Body</p>',
    _items: [{ text: '<p>A</p>', _shouldBeSelected: true }, { text: '<p>B</p>', _shouldBeSelected: false }],
  }];
  const html = `<!DOCTYPE html><body><div class="q1"><div>Body</div>
    <input type="checkbox" id="q1-0-input"><label id="q1-0-label" for="q1-0-input">A</label>
    <input type="checkbox" id="q1-1-input"><label id="q1-1-label" for="q1-1-input">B</label></div></body>`;
  const env = makeEnv({ components, html, id: 'persist', storedVisible: false });
  await sleep(800);

  s.check('starts hidden when preference is hidden', env.bgVar() === 'transparent', env.bgVar());
  s.check('still highlighted internally (class present)', env.doc.getElementById('q1-0-label')?.classList.contains(H));

  // Re-highlighting must not make it visible again while the preference is hidden
  await env.trigger();
  await sleep(600);
  s.check('re-highlight keeps it hidden', env.bgVar() === 'transparent', env.bgVar());
  s.check('re-highlight keeps class', env.doc.getElementById('q1-0-label')?.classList.contains(H));

  s.finish();
  env.close();
}

// ---------------------------------------------------------------------------
// Scenario T: Toggle applies across shadow DOM and iframes
// ---------------------------------------------------------------------------
async function scenarioToggleScopes() {
  const s = scenario('T. Toggle across shadow DOM & iframes');
  const components = [{
    _id: 'q1', _component: 'mcq', body: '<p>Body</p>',
    _items: [{ text: '<p>A</p>', _shouldBeSelected: true }, { text: '<p>B</p>', _shouldBeSelected: false }],
  }];

  // Shadow DOM
  {
    const html = `<!DOCTYPE html><body><div id="host"></div></body>`;
    const env = makeEnv({ components, html, id: 'tshadow' });
    await sleep(400);
    const root = env.doc.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = `<div class="q1"><div>Body</div>
      <input type="checkbox" id="q1-0-input"><label id="q1-0-label" for="q1-0-input">A</label>
      <input type="checkbox" id="q1-1-input"><label id="q1-1-label" for="q1-1-input">B</label></div>`;
    await env.trigger();
    await sleep(600);
    s.check('shadow: highlighted', root.getElementById('q1-0-label')?.classList.contains(H));
    await env.toggle();
    await sleep(60);
    s.check('shadow: hidden after toggle', env.bgVar() === 'transparent', env.bgVar());
    env.close();
  }

  // Iframe
  {
    const html = `<!DOCTYPE html><body><iframe id="fr"></iframe></body>`;
    const env = makeEnv({ components, html, id: 'tiframe' });
    await sleep(400);
    const iframe = env.doc.getElementById('fr');
    const iwin = iframe.contentWindow;
    iwin.Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 20, top: 10, left: 10, right: 110, bottom: 30, x: 10, y: 10, toJSON() {} });
    if (!iwin.CSS) iwin.CSS = {};
    if (!iwin.CSS.escape) iwin.CSS.escape = s2 => String(s2).replace(/[^a-zA-Z0-9_-]/g, c => '\\' + c);
    const idoc = iframe.contentDocument;
    idoc.body.innerHTML = `<div class="q1"><div>Body</div>
      <input type="checkbox" id="q1-0-input"><label id="q1-0-label" for="q1-0-input">A</label>
      <input type="checkbox" id="q1-1-input"><label id="q1-1-label" for="q1-1-input">B</label></div>`;
    await env.trigger();
    await sleep(600);
    s.check('iframe: highlighted', idoc.getElementById('q1-0-label')?.classList.contains(H));
    await env.toggle();
    await sleep(80);
    s.check('iframe: hidden after toggle', idoc.documentElement.style.getPropertyValue('--netacad-hl-bg') === 'transparent');
    env.close();
  }

  s.finish();
}

// ---------------------------------------------------------------------------
// Scenario U: Accordion headers get distinct colours and honour the toggle
// ---------------------------------------------------------------------------
async function scenarioAccordionColors() {
  const s = scenario('U. Accordion distinct colours');

  const components = [{
    _id: 'acc1', _component: 'accordion', body: '<p>Select the headings</p>',
    _items: [
      { title: 'Software attacks', body: '<p>a</p>', _graphic: { alt: 'x', src: 'y.png' }, _classes: '' },
      { title: 'Hardware attacks', body: '<p>b</p>', _graphic: { alt: 'x', src: 'y.png' }, _classes: '' },
      { title: 'Network attacks', body: '<p>c</p>', _graphic: { alt: 'x', src: 'y.png' }, _classes: '' },
    ],
  }];

  // Accordion headers are not always <button> — some renderers emit
  // div[role=button] or an element carrying an accordion title class.
  const shapes = {
    button: t => `<button class="acc-head" aria-expanded="false">${t}</button>`,
    roleButton: t => `<div class="acc-head" role="button" tabindex="0" aria-expanded="false">${t}</div>`,
    titleClass: t => `<span class="accordion-item-title">${t}</span>`,
    titleTextOnly: t => `<span class="acc-head">${t}</span>`,
  };

  for (const [shape, header] of Object.entries(shapes)) {
    const html = `<!DOCTYPE html><body><div class="acc1"><div>Select the headings</div>
      ${header('Software attacks')}${header('Hardware attacks')}${header('Network attacks')}
    </div></body>`;
    const env = makeEnv({ components, html, id: `accordion-${shape}` });
    await sleep(700);

    const heads = [...env.doc.querySelectorAll('.acc1 .acc-head, .acc1 .accordion-item-title')];
    const rgbs = heads.map(b => b.style.getPropertyValue('--netacad-hl-accent-rgb'));

    s.check(`[${shape}] 3 headers found`, heads.length === 3, `found ${heads.length}`);
    s.check(`[${shape}] all headers highlighted`, heads.every(b => b.classList.contains(H)));
    s.check(`[${shape}] accent class applied`,
      heads.every(b => b.classList.contains('netacad-solver-highlight-accent')));
    s.check(`[${shape}] every header has an accent rgb`,
      rgbs.length === 3 && rgbs.every(v => /^\d+, \d+, \d+$/.test(v)), JSON.stringify(rgbs));
    s.check(`[${shape}] header colours all distinct`, new Set(rgbs).size === 3, JSON.stringify(rgbs));

    // Toggle hides the accent highlights too (numeric alpha gate flips to 0).
    await env.toggle();
    await sleep(60);
    s.check(`[${shape}] hidden after toggle`,
      env.doc.documentElement.style.getPropertyValue('--netacad-hl-accent-alpha') === '0');
    s.check(`[${shape}] keeps class while hidden`, heads.every(b => b.classList.contains(H)));

    await sleep(500);
    await env.toggle();
    await sleep(60);
    s.check(`[${shape}] visible again after second toggle`,
      env.doc.documentElement.style.getPropertyValue('--netacad-hl-accent-alpha') === '1');

    s.check(`[${shape}] never selects/submits`,
      !env.clicks.includes('submit') && env.programmaticClicks.length === 0);

    env.close();
  }

  s.finish();
}

// ---------------------------------------------------------------------------
// Scenario V: Matching ("pick and choose what fits") colours each pair
// ---------------------------------------------------------------------------
async function scenarioMatchPairColors() {
  const s = scenario('V. Matching pair colours');

  // Mirrors the real objectMatching/matching shape: each item has a question
  // and an answer, and the page renders two [data-id="i"] elements per pair.
  const components = [{
    _id: 'm1', _component: 'objectMatching', body: '<p>Match the items</p>',
    _items: [
      { question: '4th', answer: 'Apply policies.' },
      { question: '1st', answer: 'Identify assets.' },
      { question: '3rd', answer: 'Monitor.' },
    ],
  }];
  const html = `<!DOCTYPE html><body><div class="m1"><div>Match the items</div>
    <button data-id="0">4th</button><button data-id="0">Apply policies.</button>
    <button data-id="1">1st</button><button data-id="1">Identify assets.</button>
    <button data-id="2">3rd</button><button data-id="2">Monitor.</button></div></body>`;

  const env = makeEnv({ components, html, id: 'matchpair' });
  await sleep(800);

  const rgbOf = i => {
    const pair = [...env.doc.querySelectorAll(`[data-id="${i}"]`)];
    return pair.map(el => el.style.getPropertyValue('--netacad-hl-accent-rgb'));
  };

  const [p0, p1, p2] = [0, 1, 2].map(rgbOf);

  s.check('pair 0: both sides highlighted', p0.length === 2 && p0.every(v => v !== ''), JSON.stringify(p0));
  s.check('pair 0: both sides share one colour', p0.length === 2 && p0[0] === p0[1], JSON.stringify(p0));
  s.check('pair 1: both sides highlighted', p1.length === 2 && p1.every(v => v !== ''), JSON.stringify(p1));
  s.check('pair 2: both sides highlighted', p2.length === 2 && p2.every(v => v !== ''), JSON.stringify(p2));

  s.check('different pairs get different colours',
    p0[0] !== p1[0] && p1[0] !== p2[0] && p0[0] !== p2[0],
    JSON.stringify([p0[0], p1[0], p2[0]]));

  s.check('no pair is left on the default green',
    !p0.includes('34, 197, 94') && !p1.includes('34, 197, 94') && !p2.includes('34, 197, 94'),
    JSON.stringify([p0, p1, p2]));

  // The hotkey must still hide the coloured match highlights.
  await env.toggle();
  await sleep(60);
  s.check('match hidden after toggle',
    env.doc.documentElement.style.getPropertyValue('--netacad-hl-accent-alpha') === '0');
  s.check('match never selects/submits', !env.clicks.includes('submit') && env.programmaticClicks.length === 0);

  s.finish();
  env.close();
}

// ---------------------------------------------------------------------------
// Scenario W: Auto-solver (Ctrl+Shift+Y) selects answers, never submits
// ---------------------------------------------------------------------------
async function scenarioAutoSolve() {
  const s = scenario('W. Auto-solver selects, never submits');

  const components = [
    {
      _id: 'q1', _component: 'mcq', body: '<p>Body A</p>',
      _items: [{ text: '<p>A</p>', _shouldBeSelected: true }, { text: '<p>B</p>', _shouldBeSelected: false }],
    },
    {
      _id: 'q2', _component: 'mcq', body: '<p>Body B</p>',
      _items: [{ text: '<p>X</p>', _shouldBeSelected: false }, { text: '<p>Y</p>', _shouldBeSelected: true }],
    },
  ];
  const html = `<!DOCTYPE html><body>
    <div class="q1"><div>Body A</div>
      <input type="checkbox" id="q1-0-input"><label id="q1-0-label" for="q1-0-input">A</label>
      <input type="checkbox" id="q1-1-input"><label id="q1-1-label" for="q1-1-input">B</label></div>
    <div class="q2"><div>Body B</div>
      <input type="checkbox" id="q2-0-input"><label id="q2-0-label" for="q2-0-input">X</label>
      <input type="checkbox" id="q2-1-input"><label id="q2-1-label" for="q2-1-input">Y</label></div>
    <button id="submit">submit</button>
  </body>`;

  const env = makeEnv({ components, html, id: 'autosolve' });
  await sleep(800);

  const a0 = env.doc.getElementById('q1-0-input');
  const b1 = env.doc.getElementById('q1-1-input');
  const y1 = env.doc.getElementById('q2-1-input');

  s.check('before trigger: nothing selected', !a0.checked && !y1.checked);

  // CRITICAL: page load + the periodic poll must never solve on their own.
  await sleep(3000);
  s.check('idle (no hotkey) performs zero clicks', env.programmaticClicks.length === 0,
    env.programmaticClicks.join(','));
  s.check('idle (no hotkey) selects nothing', !a0.checked && !y1.checked,
    `a=${a0?.checked} y=${y1?.checked}`);

  await env.trigger();
  await sleep(900);

  s.check('q1 correct answer selected', a0.checked === true, `checked=${a0?.checked}`);
  s.check('q1 wrong answer NOT selected', b1.checked === false, `checked=${b1?.checked}`);
  s.check('q2 correct answer selected', y1.checked === true, `checked=${y1?.checked}`);
  s.check('submit button never clicked', !env.clicks.includes('submit'), JSON.stringify(env.clicks));

  // Pressing again must not toggle answers back off.
  const before = env.programmaticClicks.length;
  await env.trigger();
  await sleep(900);
  s.check('re-trigger keeps answer selected (no toggle off)', a0.checked === true, `checked=${a0?.checked}`);
  s.check('re-trigger does not re-click inputs',
    env.programmaticClicks.filter(c => c.startsWith('q')).length === before,
    `before=${before} after=${env.programmaticClicks.length}`);

  s.check('never submits after re-trigger', !env.clicks.includes('submit'));

  s.finish();
  env.close();
}

// ---------------------------------------------------------------------------
// Scenario BR: Brutal mode — fully automatic select + submit, no hotkey
// ---------------------------------------------------------------------------
async function scenarioBrutal() {
  const s = scenario('BR. Brutal mode auto-selects and auto-submits');

  // q1 visible from the start; q2/q3 start hidden and are revealed later to
  // simulate "the next question appears".
  const components = [
    {
      _id: 'q1', _component: 'mcq', body: '<p>Body A</p>',
      _items: [{ text: '<p>A</p>', _shouldBeSelected: true }, { text: '<p>B</p>', _shouldBeSelected: false }],
    },
    {
      _id: 'q2', _component: 'mcq', body: '<p>Body C</p>',
      _items: [{ text: '<p>C</p>', _shouldBeSelected: false }, { text: '<p>D</p>', _shouldBeSelected: true }],
    },
    {
      _id: 'q3', _component: 'mcq', body: '<p>Body E</p>',
      _items: [{ text: '<p>E</p>', _shouldBeSelected: true }, { text: '<p>F</p>', _shouldBeSelected: false }],
    },
  ];
  const hidden = ' style="display:none"';
  const html = `<!DOCTYPE html><body>
    <div class="q1"><div>Body A</div>
      <input type="checkbox" id="q1-0-input"><label id="q1-0-label" for="q1-0-input">A</label>
      <input type="checkbox" id="q1-1-input"><label id="q1-1-label" for="q1-1-input">B</label></div>
    <div class="q2"${hidden}><div>Body C</div>
      <input type="checkbox" id="q2-0-input"><label id="q2-0-label" for="q2-0-input">C</label>
      <input type="checkbox" id="q2-1-input"><label id="q2-1-label" for="q2-1-input">D</label></div>
    <div class="q3"${hidden}><div>Body E</div>
      <input type="checkbox" id="q3-0-input"><label id="q3-0-label" for="q3-0-input">E</label>
      <input type="checkbox" id="q3-1-input"><label id="q3-1-label" for="q3-1-input">F</label></div>
    <button id="submit">submit</button>
  </body>`;

  const env = makeEnv({ components, html, id: 'brutal', storedMode: 'brutal' });
  const submitClicks = () => env.clicks.filter(c => c === 'submit').length;
  const inputClicks = () => env.programmaticClicks.filter(c => /^q\d/.test(c)).length;

  // Nothing is pressed. In brutal mode the idle load must pick AND submit.
  await sleep(2500);

  s.check('badge shows BRUTAL on load',
    env.doc.getElementById('netacad-solver-mode-badge')?.textContent === 'BRUTAL');
  s.check('idle (no hotkey) selects q1 correct answer',
    env.doc.getElementById('q1-0-input')?.checked === true);
  s.check('idle: q1 wrong answer NOT selected',
    env.doc.getElementById('q1-1-input')?.checked === false);
  s.check('idle: hidden q2/q3 NOT selected',
    env.doc.getElementById('q2-1-input')?.checked === false
    && env.doc.getElementById('q3-0-input')?.checked === false);
  s.check('idle: submit clicked exactly once', submitClicks() === 1,
    JSON.stringify(env.clicks));

  // Polls, refreshes and re-renders must not re-select or double-submit.
  await sleep(4000);
  s.check('stays at exactly one submit while idle', submitClicks() === 1,
    JSON.stringify(env.clicks));
  s.check('no input re-clicks while idle', inputClicks() === 1,
    env.programmaticClicks.join(','));

  // A newly-appearing question must be picked and submitted exactly once.
  // (A childList mutation wakes the observer; the style change alone would
  // not be observed.)
  env.doc.querySelector('.q2').style.display = '';
  env.doc.querySelector('.q2').appendChild(env.doc.createElement('span'));
  await sleep(1500);
  s.check('revealed q2 correct answer selected',
    env.doc.getElementById('q2-1-input')?.checked === true);
  s.check('revealed q2: wrong answer NOT selected',
    env.doc.getElementById('q2-0-input')?.checked === false);
  s.check('revealed q2: submit clicked exactly once more', submitClicks() === 2,
    JSON.stringify(env.clicks));

  // Switch back to safe (hotkey): persists, badge updates, and nothing
  // automatic happens from here on.
  await env.toggleMode();
  await sleep(300);
  s.check('badge shows EASY after toggle',
    env.doc.getElementById('netacad-solver-mode-badge')?.textContent === 'EASY');
  s.check('mode persist recorded as safe',
    env.storageSets.some(set => set['netacad-solver-mode'] === 'safe'),
    JSON.stringify(env.storageSets));

  env.doc.querySelector('.q3').style.display = '';
  env.doc.querySelector('.q3').appendChild(env.doc.createElement('span'));
  await sleep(1500);
  s.check('safe mode idle: revealed q3 NOT selected',
    env.doc.getElementById('q3-0-input')?.checked === false);
  s.check('safe mode idle: no further submit', submitClicks() === 2,
    JSON.stringify(env.clicks));

  // Ctrl+Shift+Y still works in safe mode: selects, never submits.
  await env.trigger();
  await sleep(1200);
  s.check('safe mode: Y selects q3 correct answer',
    env.doc.getElementById('q3-0-input')?.checked === true);
  s.check('safe mode: Y never submits', submitClicks() === 2,
    JSON.stringify(env.clicks));

  s.finish();
  env.close();
}

// ---------------------------------------------------------------------------
// Scenario BR2: Switching to brutal mid-session submits on demand
// (the "it doesn't auto submit" regression: idle pages never re-run main()
// on their own, and the answers may already be selected)
// ---------------------------------------------------------------------------
async function scenarioBrutalOnDemand() {
  const s = scenario('BR2. Switch to brutal mid-session submits on demand');

  const components = [
    {
      _id: 'q1', _component: 'mcq', body: '<p>Body A</p>',
      _items: [{ text: '<p>A</p>', _shouldBeSelected: true }, { text: '<p>B</p>', _shouldBeSelected: false }],
    },
  ];
  const html = `<!DOCTYPE html><body>
    <div class="q1"><div>Body A</div>
      <input type="checkbox" id="q1-0-input"><label id="q1-0-label" for="q1-0-input">A</label>
      <input type="checkbox" id="q1-1-input"><label id="q1-1-label" for="q1-1-input">B</label></div>
    <button id="submit">Submit answers</button>
  </body>`;

  const env = makeEnv({ components, html, id: 'brutal-on-demand' });

  // The real quiz's submit button sits at the bottom of the page, below the
  // fold: make this one invisible to force the off-viewport fallback.
  env.doc.getElementById('submit').getBoundingClientRect = () => ({
    width: 100, height: 30, top: 99999, left: 10, right: 110, bottom: 100029,
    x: 10, y: 99999, toJSON() {},
  });

  await sleep(1500);
  s.check('safe default: idle selects nothing',
    env.doc.getElementById('q1-0-input')?.checked === false);
  s.check('safe default: idle submits nothing', !env.clicks.includes('submit'));

  // Answer in safe mode, then switch to brutal. The switch itself must
  // submit, even though that pass selects nothing new.
  await env.trigger();
  await sleep(1000);
  s.check('Y selects the answer (safe mode)',
    env.doc.getElementById('q1-0-input')?.checked === true);
  s.check('safe mode: still no submit', !env.clicks.includes('submit'));

  await env.toggleMode();
  await sleep(1500);
  s.check('switching to brutal submits (below-fold "Submit answers" button)',
    env.clicks.filter(c => c === 'submit').length === 1, JSON.stringify(env.clicks));
  s.check('badge shows BRUTAL after toggle',
    env.doc.getElementById('netacad-solver-mode-badge')?.textContent === 'BRUTAL');

  // No double-submit from the polls that follow.
  await sleep(3500);
  s.check('no double submit after the on-demand submit',
    env.clicks.filter(c => c === 'submit').length === 1, JSON.stringify(env.clicks));

  s.finish();
  env.close();
}

// ---------------------------------------------------------------------------
// Scenario X: Hotkey behaves like a real keypress (single tap works, no hold-spam)
// ---------------------------------------------------------------------------
async function scenarioHotkeyPressSemantics() {
  const s = scenario('X. Hotkey press semantics');

  const makeComponents = () => [{
    _id: 'q1', _component: 'mcq', body: '<p>Body</p>',
    _items: [{ text: '<p>A</p>', _shouldBeSelected: true }, { text: '<p>B</p>', _shouldBeSelected: false }],
  }];
  const makeHtml = () => `<!DOCTYPE html><body><div class="q1"><div>Body</div>
    <input type="checkbox" id="q1-0-input"><label id="q1-0-label" for="q1-0-input">A</label>
    <input type="checkbox" id="q1-1-input"><label id="q1-1-label" for="q1-1-input">B</label></div>
    <button id="submit">submit</button></body>`;

  // A) A single quick tap must solve on its own.
  {
    const env = makeEnv({ components: makeComponents(), html: makeHtml(), id: 'tap' });
    await sleep(800);
    await env.tap();
    await sleep(900);
    s.check('single tap solves (no hold needed)',
      env.doc.getElementById('q1-0-input')?.checked === true,
      `checked=${env.doc.getElementById('q1-0-input')?.checked}`);
    s.check('single tap never submits', !env.clicks.includes('submit'));
    env.close();
  }

  // B) Holding the key (auto-repeat) must not spam clicks.
  {
    const env = makeEnv({ components: makeComponents(), html: makeHtml(), id: 'hold' });
    await sleep(800);
    await env.hold(25);
    await sleep(1200);
    s.check('held key produces exactly one click', env.programmaticClicks.length === 1,
      `clicks=${env.programmaticClicks.length} [${env.programmaticClicks.join(',')}]`);
    s.check('held key still solves', env.doc.getElementById('q1-0-input')?.checked === true);
    s.check('held key never submits', !env.clicks.includes('submit'));
    env.close();
  }

  // C) The solve request must survive a refresh already being in flight.
  //    This is what previously made the hotkey look like it needed a hold.
  {
    const env = makeEnv({ components: makeComponents(), html: makeHtml(), id: 'inflight' });
    await sleep(800);
    // Force a mutation so the observer queues a refresh, then tap immediately
    // so the solve request lands while that refresh is pending.
    env.doc.querySelector('.q1').appendChild(env.doc.createElement('span'));
    await env.tap();
    await sleep(1500);
    s.check('solve survives an in-flight refresh',
      env.doc.getElementById('q1-0-input')?.checked === true,
      `checked=${env.doc.getElementById('q1-0-input')?.checked}`);
    s.check('no submit from that path either', !env.clicks.includes('submit'));
    env.close();
  }

  s.finish();
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('Running NetAcad solver stress suite...\n');
  await scenarioScale();
  await scenarioIdempotency();
  await scenarioShadow();
  await scenarioIframe();
  await scenarioVisibility();
  await scenarioEdges();
  await scenarioInteractionStorm();
  await scenarioErrors();
  await scenarioText();
  await scenarioSpaReplace();
  await scenarioExtremeScale();
  await scenarioDeepShadow();
  await scenarioFallback();
  await scenarioConcurrentTriggers();
  await scenarioNoChrome();
  await scenarioNoRefreshLoop();
  await scenarioMemoryStability();
  await scenarioToggleHotkey();
  await scenarioTogglePersisted();
  await scenarioToggleScopes();
  await scenarioAccordionColors();
  await scenarioMatchPairColors();
  await scenarioAutoSolve();
  await scenarioBrutal();
  await scenarioBrutalOnDemand();
  await scenarioHotkeyPressSemantics();

  console.log(`\n========================================`);
  console.log(`TOTAL: ${totalPass}/${totalPass + totalFail} checks passed`);
  if (failures.length) {
    console.log(`FAILURES:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  process.exit(0);
}

main();
