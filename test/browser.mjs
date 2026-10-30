/**
 * NetAcad Companion - browser regression suite
 *
 * jsdom (test/stress.mjs) proves the logic, but it does NOT do real layout, real
 * event dispatch, or real CSS resolution. This harness loads the built content
 * script into real Chromium and asserts the properties that historically broke:
 *
 *   - idle (page load + periodic poll) NEVER solves  -> no "auto-submit fires
 *     prematurely", no "clicking triggers solve"
 *   - Ctrl+Shift+Y selects the correct answers and NEVER clicks submit
 *   - the DOM churn caused by selecting does not re-enter the solver
 *     (click -> re-render -> click)                              -> no flicker /
 *     re-run loop, and no "drag and fit resets itself"
 *   - pressing the hotkey twice does not toggle answers back off
 *   - Ctrl+Shift+H hides/shows coloured highlights
 *
 * Usage:  npm run build && npm run test:browser
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const bundle = fs.readFileSync(path.join(REPO, 'dist/content.js'), 'utf8');
const require = createRequire(import.meta.url);

const COMPONENT_URL =
  'https://www.netacad.com/content/cse3/1.0/courses/content/final-exam-ilt/en-US/components.json';

// Playwright is not a project dependency. Resolve the globally installed CLI's
// copy, and fall back to a local install if the project ever adds one.
const PW_CANDIDATES = [
  () => require('playwright'),
  () => require(path.join(process.env.APPDATA || '', 'npm', 'node_modules',
    '@playwright', 'cli', 'node_modules', 'playwright')),
];

function loadPlaywright() {
  for (const candidate of PW_CANDIDATES) {
    try {
      const pw = candidate();
      if (pw?.chromium) return pw;
    } catch (e) { /* try next */ }
  }
  return null;
}

// The installed browser build number does not always match the Playwright
// version, so fall back to any chromium already downloaded.
function findChromium() {
  const base = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');

  if (!fs.existsSync(base)) return undefined;

  const dir = fs.readdirSync(base)
    .filter(d => d.startsWith('chromium-'))
    .sort()
    .pop();

  if (!dir) return undefined;

  const exe = path.join(base, dir, 'chrome-win64', 'chrome.exe');

  return fs.existsSync(exe) ? exe : undefined;
}

let totalPass = 0;
let totalFail = 0;
const failures = [];

const check = (label, cond, detail = '') => {
  if (cond) {
    totalPass++;
    console.log(`  PASS  ${label}`);
  } else {
    totalFail++;
    failures.push(`${label} ${detail}`);
    console.log(`  FAIL  ${label} ${detail}`);
  }
};

const COMPONENTS = [
  {
    _id: 'q1', _component: 'mcq', body: '<p>Which is a phishing example?</p>',
    _items: [
      { text: '<p>A fake login email</p>', _isCorrect: true },
      { text: '<p>A patched firewall</p>', _isCorrect: false },
    ],
  },
  {
    _id: 'm1', _component: 'objectMatching', body: '<p>Match the step to its order.</p>',
    _items: [
      { question: '4th', answer: 'Apply policies.' },
      { question: '1st', answer: 'Identify assets.' },
    ],
  },
];

const HTML = `<!DOCTYPE html><html><body>
  <div class="q1"><div>Which is a phishing example?</div>
    <input type="checkbox" id="q1-0-input"><label id="q1-0-label" for="q1-0-input">A fake login email</label>
    <input type="checkbox" id="q1-1-input"><label id="q1-1-label" for="q1-1-input">A patched firewall</label></div>
  <div class="m1"><div>Match the step to its order.</div>
    <button data-id="0">4th</button><button data-id="0">Apply policies.</button>
    <button data-id="1">1st</button><button data-id="1">Identify assets.</button></div>
  <button id="submit">Submit</button>
</body></html>`;

const press = key => `document.dispatchEvent(new KeyboardEvent('keydown',
  { key: '${key}', ctrlKey: true, shiftKey: true, bubbles: true }));`;

async function boot(browser, mode, target) {
  const page = target || await browser.newPage();
  await page.setContent(HTML);

  await page.evaluate(({ url, mode }) => {
    window.__clicks = [];
    window.__preferenceWrites = [];
    document.addEventListener('click', e => {
      window.__clicks.push(e.target.id ||
        `${e.target.tagName}${e.target.dataset?.id !== undefined ? `[${e.target.dataset.id}]` : ''}`);
    }, true);

    window.__listeners = [];
    window.chrome = {
      runtime: {
        id: 'test-id',
        lastError: undefined,
        onMessage: { addListener(fn) { window.__listeners.push(fn); } },
        sendMessage() {},
      },
      storage: {
        local: {
          get(k, cb) { cb(mode ? { 'netacad-solver-mode': mode } : {}); },
          set(values) { window.__preferenceWrites.push(values); },
        },
      },
    };
    window.fetch = async u => String(u).includes('components.json')
      ? { ok: true, json: async () => JSON.parse(JSON.stringify(window.__COMPONENTS__)) }
      : { ok: false, json: async () => [] };
    void url;
  }, { url: COMPONENT_URL, mode });

  await page.evaluate(c => { window.__COMPONENTS__ = c; }, COMPONENTS);
  await page.evaluate(code => { (0, eval)(code); }, bundle);
  await page.evaluate(url => window.__listeners.forEach(fn => fn({ componentsUrl: url })), COMPONENT_URL);

  return page;
}

const snapshot = page => page.evaluate(() => ({
  clicks: window.__clicks.length,
  clickList: [...window.__clicks],
  correct: document.getElementById('q1-0-input')?.checked,
  wrong: document.getElementById('q1-1-input')?.checked,
  accent: document.getElementById('q1-0-label')?.classList.contains('netacad-solver-highlight-accent'),
  highlighted: document.getElementById('q1-0-label')?.classList.contains('netacad-solver-highlight'),
}));

async function main() {
  const pw = loadPlaywright();

  if (!pw) {
    console.log('Playwright not available - skipping real-browser suite.');
    console.log('Install it with:  npm i -D playwright   (or: npm i -g @playwright/cli)');
    process.exit(0);
  }

  const executablePath = findChromium();
  const browser = await pw.chromium.launch(executablePath ? { executablePath } : {});
  const page = await boot(browser);

  console.log('Running real-browser solver suite...\n');

  console.log('== Idle must never solve ==');
  await page.waitForTimeout(5000);
  let s = await snapshot(page);
  check('no clicks on load / periodic poll', s.clicks === 0, JSON.stringify(s.clickList));
  check('nothing selected on load', s.correct === false && s.wrong === false);
  check('highlighting still happened on load', s.highlighted === true);

  console.log('\n== Ctrl+Shift+Y solves ==');
  await page.evaluate(press('y'));
  await page.waitForTimeout(1200);
  s = await snapshot(page);
  check('correct answer selected', s.correct === true, `checked=${s.correct}`);
  check('wrong answer NOT selected', s.wrong === false, `checked=${s.wrong}`);
  check('submit never clicked', !s.clickList.includes('submit'), JSON.stringify(s.clickList));
  check('matching pairs clicked', s.clickList.filter(c => c.startsWith('BUTTON')).length === 4,
    JSON.stringify(s.clickList));

  console.log('\n== No re-run loop from selection churn ==');
  const afterSolve = s.clicks;
  await page.waitForTimeout(6000);
  s = await snapshot(page);
  check('no further clicks while idle after solving', s.clicks === afterSolve,
    `${afterSolve} -> ${s.clicks}`);
  check('answers stay selected while idle', s.correct === true && s.wrong === false);

  console.log('\n== Repeat press is idempotent ==');
  await page.evaluate(press('y'));
  await page.waitForTimeout(1200);
  s = await snapshot(page);
  check('answer not toggled back off', s.correct === true, `checked=${s.correct}`);
  check('no extra clicks on repeat press', s.clicks === afterSolve, `${afterSolve} -> ${s.clicks}`);
  check('submit still never clicked', !s.clickList.includes('submit'));

  console.log('\n== Ctrl+Shift+H hides coloured highlights ==');
  await page.evaluate(press('h'));
  await page.waitForTimeout(200);
  const hidden = await page.evaluate(() => {
    const el = document.getElementById('q1-0-label');
    return {
      alpha: getComputedStyle(document.documentElement).getPropertyValue('--netacad-hl-accent-alpha').trim(),
      outline: getComputedStyle(el).outlineColor,
      checked: document.getElementById('q1-0-input')?.checked,
    };
  });
  check('accent alpha gate is 0 while hidden', hidden.alpha === '0', hidden.alpha);
  check('outline fully transparent while hidden', hidden.alpha === '0', hidden.outline);
  check('hiding does NOT clear the selection', hidden.checked === true);

  console.log('\n== Single tap immediately after load (fresh page) ==');
  const fresh = await boot(browser);
  // Press right away, before the component load / first poll has settled. This
  // is the "you had to hold Y" case: the first tap must solve on its own.
  await fresh.evaluate(press('y'));
  await fresh.waitForTimeout(2500);
  const fs2 = await snapshot(fresh);
  check('first tap on a fresh page solves', fs2.correct === true, `checked=${fs2.correct}`);
  check('fresh page: wrong not selected', fs2.wrong === false, `checked=${fs2.wrong}`);
  check('fresh page: submit never clicked', !fs2.clickList.includes('submit'),
    JSON.stringify(fs2.clickList));
  await fresh.close();

  console.log('\n== Brutal mode: fully automatic select + submit ==');
  const brutal = await boot(browser, 'brutal');
  // Nothing is pressed. In brutal mode the idle load must pick AND submit.
  await brutal.waitForTimeout(5000);
  let b = await snapshot(brutal);
  check('brutal idle: correct answer selected', b.correct === true, `checked=${b.correct}`);
  check('brutal idle: wrong answer NOT selected', b.wrong === false, `checked=${b.wrong}`);
  check('brutal idle: submit clicked exactly once',
    b.clickList.filter(c => c === 'submit').length === 1, JSON.stringify(b.clickList));
  const badge = await brutal.evaluate(() =>
    document.getElementById('netacad-solver-mode-badge')?.textContent);
  check('badge shows BRUTAL', badge === 'BRUTAL', String(badge));

  // Polls and DOM churn must not re-select or double-submit.
  await brutal.waitForTimeout(5000);
  b = await snapshot(brutal);
  check('brutal idle: still exactly one submit',
    b.clickList.filter(c => c === 'submit').length === 1, JSON.stringify(b.clickList));
  check('brutal idle: answers stay selected', b.correct === true && b.wrong === false);
  await brutal.close();

  console.log('\n== Switching to brutal mid-session submits on demand ==');
  const onDemand = await boot(browser);
  await onDemand.evaluate(press('y'));
  await onDemand.waitForTimeout(1200);
  let o = await snapshot(onDemand);
  check('safe: Y selected, no submit', o.correct === true && !o.clickList.includes('submit'),
    JSON.stringify(o.clickList));
  await onDemand.evaluate(press('m'));
  await onDemand.waitForTimeout(1500);
  o = await snapshot(onDemand);
  check('switch to brutal: submit clicked exactly once',
    o.clickList.filter(c => c === 'submit').length === 1, JSON.stringify(o.clickList));
  check('switch to brutal: badge shows BRUTAL',
    await onDemand.evaluate(() =>
      document.getElementById('netacad-solver-mode-badge')?.textContent) === 'BRUTAL');
  await onDemand.waitForTimeout(4000);
  o = await snapshot(onDemand);
  check('no double submit after on-demand submit',
    o.clickList.filter(c => c === 'submit').length === 1, JSON.stringify(o.clickList));
  await onDemand.close();

  console.log('\n== Mode controls: keyboard, persistence, layout and idle work ==');
  const ui = await boot(browser);
  const controls = ui.locator('#netacad-solver-controls');
  const summary = controls.locator(':scope > summary');
  const easyButton = controls.locator('button[data-mode="safe"]');
  const brutalButton = controls.locator('button[data-mode="brutal"]');
  const highlights = controls.getByRole('switch', { name: 'Answer highlights' });
  await ui.waitForTimeout(2000);
  check('controls start collapsed in Easy mode',
    await controls.evaluate(el => !el.open && el.dataset.mode === 'safe'));
  await summary.focus();
  await ui.keyboard.press('Enter');
  check('keyboard opens settings', await controls.evaluate(el => el.open));
  check('active mode is accessible', await easyButton.getAttribute('aria-pressed') === 'true');

  // Count question layout reads, excluding Playwright's own control hit-testing.
  await ui.evaluate(() => {
    window.__questionRects = 0;
    const getRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      if (this.closest('.q1, .m1')) window.__questionRects++;
      return getRect.call(this);
    };
  });
  await easyButton.click();
  check('reselecting the active mode does not write storage',
    await ui.evaluate(() => window.__preferenceWrites.length === 0));
  await highlights.uncheck();
  check('highlight switch hides and persists', await ui.evaluate(() =>
    document.documentElement.style.getPropertyValue('--netacad-hl-accent-alpha') === '0'
      && window.__preferenceWrites.some(v => v['netacad-solver-highlights-visible'] === false)));
  await ui.keyboard.press('Control+Shift+h');
  check('highlight hotkey updates the switch', await highlights.isChecked());
  await ui.waitForTimeout(700);
  check('settings interactions do not rescan questions',
    await ui.evaluate(() => window.__questionRects === 0));
  await ui.keyboard.press('Escape');
  check('Escape collapses settings and restores focus', await controls.evaluate(el =>
    !el.open && document.activeElement === el.querySelector('summary')));

  await summary.click();
  await controls.getByRole('button', { name: 'Close solver settings' }).click();
  check('close button collapses settings and restores focus', await controls.evaluate(el =>
    !el.open && document.activeElement === el.querySelector('summary')));
  await summary.click();
  await ui.screenshot({ path: path.join(os.tmpdir(), 'netacad-solver-controls.png') });
  for (const size of [{ width: 320, height: 568 }, { width: 360, height: 240 }]) {
    await ui.setViewportSize(size);
    const panel = await controls.locator('.solver-panel').boundingBox();
    const dock = await controls.boundingBox();
    check(`controls fit ${size.width}x${size.height}`, [panel, dock].every(box =>
      box && box.x >= 0 && box.y >= 0
        && box.x + box.width <= size.width && box.y + box.height <= size.height));
  }
  await ui.setViewportSize({ width: 1280, height: 800 });
  await ui.evaluate(() => {
    const submit = document.createElement('button');
    submit.id = 'covered-submit';
    submit.textContent = 'Submit activity';
    submit.style.cssText = 'position:fixed;right:40px;bottom:100px;padding:15px';
    submit.onclick = () => { window.__manualSubmitClicks = (window.__manualSubmitClicks || 0) + 1; };
    document.body.append(submit);
  });
  const header = controls.locator('.solver-panel-header');
  check('panel initially covers the course submission area', await ui.evaluate(() => {
    const rect = document.getElementById('covered-submit').getBoundingClientRect();
    return document.getElementById('netacad-solver-controls').contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  }));
  const initialHeader = await header.boundingBox();
  await ui.mouse.move(initialHeader.x + 80, initialHeader.y + 25);
  await ui.mouse.down();
  await ui.mouse.move(initialHeader.x - 350, initialHeader.y + 25, { steps: 8 });
  await ui.mouse.up();
  check('header dragging moves the whole panel without closing it',
    await controls.evaluate(el => el.open) && (await header.boundingBox()).x < initialHeader.x - 300);
  await ui.locator('#covered-submit').click();
  check('moving the panel makes manual submission accessible', await ui.evaluate(() => window.__manualSubmitClicks === 1));
  await summary.click();
  await header.focus();
  const beforeArrow = await header.boundingBox();
  await ui.keyboard.press('ArrowLeft');
  check('panel can be moved with the keyboard', (await header.boundingBox()).x <= beforeArrow.x - 19);
  await ui.setViewportSize({ width: 360, height: 240 });
  await ui.waitForTimeout(100);
  check('a moved panel stays reachable after resizing', (await header.boundingBox()).x >= 0
    && (await header.boundingBox()).y >= 0 && (await controls.boundingBox()).y < 240);
  await ui.setViewportSize({ width: 1280, height: 800 });
  await header.focus();
  await ui.keyboard.press('Home');
  check('Home restores the default panel position', await controls.evaluate(el => !el.style.right && !el.style.bottom));
  await ui.keyboard.press('Escape');
  const collapsed = await summary.boundingBox();
  await ui.mouse.move(collapsed.x + 80, collapsed.y + 24);
  await ui.mouse.down();
  await ui.mouse.move(collapsed.x - 150, collapsed.y - 30, { steps: 6 });
  await ui.mouse.up();
  check('dragging the compact control does not toggle it open', await controls.evaluate(el => !el.open)
    && (await summary.boundingBox()).x < collapsed.x - 100);
  await summary.click();
  await header.focus();
  await ui.keyboard.press('Home');
  await ui.mouse.click(700, 500);
  check('outside click collapses settings', await controls.evaluate(el => !el.open));
  await summary.click();
  await controls.evaluate(el => {
    el.querySelector('button[data-mode="brutal"]').click();
    el.querySelector('button[data-mode="safe"]').click();
  });
  await ui.waitForTimeout(700);
  check('Easy immediately cancels a rapid mode change',
    await controls.getAttribute('data-mode') === 'safe'
      && !(await snapshot(ui)).clickList.includes('submit'));
  await controls.getByRole('button', { name: 'Select answers', exact: true }).click();
  await ui.waitForTimeout(700);
  const selected = await snapshot(ui);
  check('Select answers action selects without submitting in Easy mode',
    selected.correct === true && selected.wrong === false && !selected.clickList.includes('submit'));
  check('Select answers returns focus to the compact control', await controls.evaluate(el =>
    !el.open && document.activeElement === el.querySelector('summary')));
  await summary.click();
  await brutalButton.click();
  await ui.waitForTimeout(1000);
  check('Brutal button selects and submits once', (await snapshot(ui)).correct === true
    && (await snapshot(ui)).clickList.filter(c => c === 'submit').length === 1);
  await brutalButton.click();
  await ui.waitForTimeout(700);
  check('reselecting Brutal does not submit again',
    (await snapshot(ui)).clickList.filter(c => c === 'submit').length === 1);
  await ui.keyboard.press('Control+Shift+m');
  check('mode hotkey updates selection and storage', await easyButton.getAttribute('aria-pressed') === 'true'
    && await ui.evaluate(() => window.__preferenceWrites.at(-1)['netacad-solver-mode'] === 'safe'));
  await ui.close();

  console.log('\n== Embedded courses share one top-level menu ==');
  const framed = await boot(browser, 'brutal');
  const courseUrl = 'https://content.netacad.com/course';
  await framed.route('https://content.netacad.com/**', route =>
    route.fulfill({ contentType: 'text/html', body: HTML }));
  const courseLoaded = framed.waitForEvent('framenavigated', {
    predicate: frame => frame.url() === courseUrl,
  });
  await framed.evaluate(url => {
    const local = document.createElement('iframe');
    local.name = 'local-course';
    const remote = document.createElement('iframe');
    remote.name = 'remote-course';
    remote.src = url;
    document.body.append(local, remote);
  }, courseUrl);
  await courseLoaded;
  const local = await boot(browser, 'brutal', framed.frame('local-course'));
  const remote = await boot(browser, 'brutal', framed.frame('remote-course'));
  await local.evaluate(() => {
    const nested = document.createElement('iframe');
    nested.name = 'nested-course';
    document.body.appendChild(nested);
  });
  await boot(browser, 'brutal', framed.frame('nested-course'));
  await framed.waitForTimeout(1700);
  const menuCounts = await Promise.all(framed.frames().map(frame =>
    frame.locator('#netacad-solver-controls').count()));
  check('one menu across top, same-origin, cross-origin and nested frames',
    menuCounts.length === 4 && menuCounts[0] === 1
      && menuCounts.slice(1).every(count => count === 0), JSON.stringify(menuCounts));
  check('embedded course solvers still run',
    (await Promise.all(framed.frames().slice(1).map(snapshot)))
      .every(state => state.correct && state.clickList.includes('submit')));
  await remote.goto(`${courseUrl}?page=2`);
  await boot(browser, 'brutal', remote);
  await framed.waitForTimeout(700);
  check('course navigation does not recreate a second menu',
    await remote.locator('#netacad-solver-controls').count() === 0
      && await framed.locator('#netacad-solver-controls').count() === 1);
  await framed.close();

  console.log('\n== Manual solver remains available during a checklist ==');
  const manual = await boot(browser, 'brutal');
  await manual.waitForTimeout(800);
  const resetManualQuestion = () => {
    const controls = document.getElementById('netacad-solver-controls');
    controls.dataset.checklistRunning = 'true';
    const previous = document.querySelector('.q1');
    const next = previous.cloneNode(true);
    next.querySelectorAll('input').forEach(input => { input.checked = false; });
    previous.replaceWith(next);
    window.__clicks = [];
  };
  await manual.evaluate(resetManualQuestion);
  await manual.evaluate(press('h')); // Refresh the controls without asking to solve.
  await manual.waitForTimeout(700);
  check('checklist still blocks idle Brutal solving', (await snapshot(manual)).correct === false);
  const manualControls = manual.locator('#netacad-solver-controls');
  check('Select answers stays enabled while mode changes stay locked',
    await manualControls.locator('.solver-select').isEnabled()
      && await manualControls.locator('button[data-mode="brutal"]').isDisabled());
  await manualControls.evaluate(element => { element.open = true; });
  await manualControls.locator('.solver-select').click();
  await manual.waitForFunction(() => document.getElementById('q1-0-input').checked);
  check('manual button selects without submitting during a checklist',
    !(await snapshot(manual)).clickList.includes('submit'));
  await manual.waitForTimeout(450); // A separate press, outside the shared hotkey debounce.
  await manual.evaluate(resetManualQuestion);
  await manual.evaluate(press('y'));
  await manual.waitForFunction(() => document.getElementById('q1-0-input').checked);
  check('manual hotkey also selects without submitting during a checklist',
    !(await snapshot(manual)).clickList.includes('submit'));
  await manual.close();

  console.log('\n== Chapter checklist: native activities, verified progress and cancellation ==');
  const course = await boot(browser);
  await course.evaluate(() => {
    for (const child of [...document.body.children]) {
      if (child.id !== 'netacad-solver-controls') child.remove();
    }
    const outline = document.createElement('aside');
    outline.innerHTML = `
      <button class="nodeInfoContainer--fixture" aria-expanded="true">Module 11: Other chapter</button>
      <button class="subModuleBtn--fixture">11.1. Other topic<img alt="start"></button>
      <button class="nodeInfoContainer--fixture" aria-expanded="false" id="chapter12">Module 12: WLAN Concepts</button>
      <div id="chapter12topics" hidden>
        <button class="subModuleBtn--fixture" data-topic="12.0">12.0. Introduction<img alt="completed"><span>2 / 2</span></button>
        <button class="subModuleBtn--fixture" data-topic="12.1">12.1. Reading and reveals<img alt="start"><span>0 / 1</span></button>
        <button class="subModuleBtn--fixture" data-topic="12.2">12.2. Check Your Understanding<img alt="start"><span>0 / 1</span></button>
        <button class="subModuleBtn--fixture" data-topic="12.3">12.3. Module quiz<img alt="start"><span>0 / 1</span></button>
        <button class="subModuleBtn--fixture" data-topic="12.4">12.4. Lab - Packet Tracer<img alt="start"><span>0 / 1</span></button>
        <button class="subModuleBtn--fixture" data-topic="12.5">12.5. Locked reading<img alt="start"><span>0 / 1</span><span>1 Prerequisite</span></button>
        <button class="subModuleBtn--fixture" data-topic="12.6">12.6. Reading activity<img alt="start"><span>0 / 1</span></button>
      </div>
      <button class="nodeInfoContainer--fixture" aria-expanded="true">Module 112: Not chapter 12</button>
      <button class="subModuleBtn--fixture">112.1. Unselected topic<img alt="start"></button>`;
    const frame = document.createElement('iframe');
    frame.id = 'checklist-course';
    frame.style.cssText = 'width:700px;height:420px;border:1px solid #ccc;';
    document.body.prepend(outline, frame);
    for (const image of outline.querySelectorAll('[data-topic] img')) {
      const status = document.createElement('span');
      status.className = 'subModuleStatus--fixture';
      image.before(status);
      status.append(image);
    }
    // Native status wins while the displayed counts are still catching up.
    outline.querySelector('[data-topic="12.0"] span:not([class])').textContent = '0 / 1';
    outline.querySelector('[data-topic="12.1"] span:not([class])').textContent = '1 / 1';
    window.__chapterOpens = [];
    window.__chapterSubmits = [];
    window.__chapterLaunches = 0;
    window.__chapterScrollTags = [];
    window.__holdTopic = false;
    const finish = button => {
      button.querySelector('img').alt = 'completed';
      button.querySelector('span:not([class])').textContent = '1 / 1';
    };
    document.querySelector('#chapter12').onclick = event => {
      event.currentTarget.setAttribute('aria-expanded', 'true');
      document.querySelector('#chapter12topics').hidden = false;
    };
    outline.querySelectorAll('button[data-topic]').forEach(button => {
      button.onclick = () => {
        const key = button.dataset.topic;
        window.__chapterOpens.push(key);
        const doc = frame.contentDocument;
        if (!doc.__tracksScroll) {
          doc.__tracksScroll = true;
          const scroll = doc.defaultView.Element.prototype.scrollIntoView;
          doc.defaultView.Element.prototype.scrollIntoView = function (options) {
            window.top.__chapterScrollTags.push(this.tagName);
            return scroll.call(this, options);
          };
        }
        doc.title = `Course | ${key}. Activity`;
        document.title = doc.title; // The course shell can mirror the reader's title.
        doc.body.replaceChildren();
        const host = doc.createElement('reader-view');
        doc.body.appendChild(host);
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = `<style>.component{min-height:300px}button{padding:12px}label{display:block;padding:8px}h2{font:20px Arial}</style>`;
        if (key === '12.1') {
          root.innerHTML += `<section class="component"><h2 class="js-heading">12.1.1 Reading</h2><button aria-expanded="false" aria-controls="note">Reveal explanation</button><p id="note" hidden>More information</p></section>`;
          root.querySelector('button').onclick = event => {
            event.currentTarget.setAttribute('aria-expanded', 'true');
            root.querySelector('#note').hidden = false;
            if (!window.__holdTopic) finish(button);
          };
        } else {
          if (key === '12.6') root.innerHTML += '<div>1 of 2 Questions</div>';
          root.innerHTML += `<section class="component q1"><h2 class="js-heading">12.2.1 Self-check</h2>
            <div>Which is a phishing example?</div>
            <input type="checkbox" id="q1-0-input"><label id="q1-0-label" for="q1-0-input">A fake login email</label>
            <input type="checkbox" id="q1-1-input"><label id="q1-1-label" for="q1-1-input">A patched firewall</label>
            <button id="chapter-submit">Submit</button></section>`;
          root.querySelector('#chapter-submit').onclick = event => {
            const question = event.currentTarget.parentElement;
            const correct = question.querySelector('#q1-0-input').checked && !question.querySelector('#q1-1-input').checked;
            window.__chapterSubmits.push({ key, correct });
            if (correct) finish(button);
          };
          if (key === '12.2') {
            const question = root.querySelector('.q1');
            question.hidden = true;
            const container = doc.createElement('assessment-block-strip-view');
            container.style.display = 'block';
            const intro = doc.createElement('div');
            intro.className = 'component is-complete adaptive-start-screen__widget';
            intro.innerHTML = '<h2>12.2 Check Your Understanding</h2><div class="start-button start" role="button" tabindex="0">Start</div>';
            container.append(intro);
            root.prepend(container);
            intro.querySelector('.start-button').onclick = () => {
              window.__chapterLaunches++;
              const get = window.chrome.storage.local.get;
              let delayed = false;
              window.chrome.storage.local.get = (key, callback) => {
                if (typeof key === 'string' && !delayed) {
                  delayed = true;
                  window.chrome.storage.local.get = get;
                  setTimeout(() => get(key, callback), 2200);
                } else get(key, callback);
              };
              window.__listeners.forEach(fn => fn({ componentsUrl:
                `https://www.netacad.com/content/checklist-loading/components.json?launch=${window.__chapterLaunches}` }));
              setTimeout(() => {
                intro.remove();
                const assessment = doc.createElement('iframe');
                assessment.style.cssText = 'width:100%;height:360px;border:0';
                container.append(assessment);
                const target = assessment.contentDocument;
                target.title = 'Self-check content';
                target.body.innerHTML = '<div>1 of 2 Questions</div><style>label{display:block;padding:8px}</style>';
                target.body.append(question);
                question.hidden = false;
              }, 100);
            };
          }
        }
        const content = doc.createElement('div');
        while (root.firstChild) content.appendChild(root.firstChild);
        let wrapped = content;
        for (let i = 0; i < 107; i++) {
          const wrapper = doc.createElement(i % 2 ? 'base-view' : 'block-view');
          wrapper.appendChild(wrapped);
          wrapped = wrapper;
        }
        root.appendChild(wrapped);
      };
    });
  });
  const chapterControls = course.locator('#netacad-solver-controls');
  const reader = course.frames().find(frame => frame.parentFrame() === course.mainFrame());
  await reader.evaluate(() => {
    window.chrome = {
      runtime: { id: 'checklist-frame', lastError: null, onMessage: { addListener: fn => { window.__onMessage = fn; } } },
      storage: { local: {
        get: (keys, cb) => cb({ 'netacad-solver-mode': 'brutal' }),
        set: value => window.top.__preferenceWrites.push(value),
      } },
    };
    window.fetch = window.top.fetch;
  });
  await reader.evaluate(bundle);
  await reader.evaluate(url => window.__onMessage({ componentsUrl: url }), COMPONENT_URL);
  await chapterControls.locator(':scope > summary').click();
  await chapterControls.locator('.solver-checklist > summary').click();
  const chapterList = chapterControls.locator('.solver-chapters');
  check('detects chapters without confusing 12 with 112',
    JSON.stringify(await chapterList.locator('input').evaluateAll(inputs => inputs.map(input => input.value)))
      === JSON.stringify(['11', '12', '112']));
  await course.waitForTimeout(700);
  check('opening the checklist does not navigate or automate',
    await course.evaluate(() => window.__chapterOpens.length === 0));
  await chapterList.locator('input[value="12"]').check();
  const chapterStart = chapterControls.locator('.solver-checklist-start');
  const chapterPace = chapterControls.locator('.solver-checklist-pace input');
  const chapterStatus = chapterControls.locator('.solver-checklist-status');
  await chapterPace.fill('0');
  await chapterStart.evaluate(button => button.click());
  check('rejects an invalid automation pace before starting', await chapterControls.evaluate(el =>
    !el.dataset.checklistRunning) && await course.evaluate(() => window.__chapterOpens.length === 0));
  await chapterPace.fill('0.5');
  await chapterControls.locator('button[data-mode="brutal"]').click();
  await chapterStart.click();
  check('requires Easy mode before starting to prevent stray Brutal submissions',
    (await chapterStatus.textContent()).includes('Switch to Easy')
      && !await chapterControls.getAttribute('data-checklist-running'));
  await chapterControls.locator('button[data-mode="safe"]').click();
  const preferenceWritesBeforeRun = await course.evaluate(() => window.__preferenceWrites.length);
  await chapterStart.click();
  check('running state remains visible in the compact menu',
    await chapterControls.locator('.solver-checklist-running').isVisible()
      && (await chapterControls.locator(':scope > summary').getAttribute('aria-label')).includes('chapter checklist running'));
  await course.waitForFunction(() => document.querySelector('.solver-checklist-status').textContent.startsWith('2/7 topics verified'),
    undefined, { timeout: 20000 }).catch(async error => {
      console.error('Chapter diagnostic:', JSON.stringify(await course.evaluate(() => ({
        status: document.querySelector('.solver-checklist-status').textContent,
        issues: document.querySelector('.solver-checklist-issues').textContent,
        opens: window.__chapterOpens,
        submits: window.__chapterSubmits,
      })), null, 2));
      throw error;
    });
  check('only visits unfinished, unlocked topics in the selected chapter',
    await course.evaluate(() => JSON.stringify(window.__chapterOpens) === JSON.stringify(['12.1', '12.2', '12.6'])));
  check('leaves Start screens untouched and reports them for manual action', await course.evaluate(() =>
    window.__chapterLaunches === 0 && window.__chapterSubmits.length === 0
      && document.querySelector('.solver-checklist-issues').textContent.includes('Start this self-check yourself')));
  check('verifies NetAcad progress rather than faking completion', await chapterControls.locator('progress').evaluate(el =>
    el.value === 2 && el.max === 7));
  check('reports quizzes, labs, locked topics and embedded assessments as needing attention',
    await chapterControls.locator('.solver-checklist-issues li').count() === 5);
  await course.waitForTimeout(700);
  check('iframe solvers honor the tab mode and cannot bypass the checklist', await reader.evaluate(() =>
    !document.querySelector('reader-view').shadowRoot.querySelector('#q1-0-input').checked));
  check('chapter automation does not change the answer mode', await chapterControls.getAttribute('data-mode') === 'safe'
    && await course.evaluate(count => window.__preferenceWrites.length === count, preferenceWritesBeforeRun));
  await course.screenshot({ path: path.join(os.tmpdir(), 'netacad-solver-chapter-checklist.png') });

  await course.evaluate(() => {
    const topic = document.querySelector('[data-topic="12.1"]');
    topic.querySelector('img').alt = 'start';
    topic.querySelector('span:not([class])').textContent = '0 / 1';
    window.__holdTopic = true;
  });
  await chapterStart.click();
  await course.waitForFunction(() => window.__chapterOpens.length === 4);
  await chapterControls.locator('.solver-checklist-stop').click();
  await course.waitForFunction(() => document.querySelector('.solver-checklist-status').textContent.startsWith('Stopped.'));
  await course.waitForTimeout(1000);
  check('Stop cancels pending work and restores the controls', await course.evaluate(() =>
    window.__chapterOpens.length === 4 && !document.querySelector('#netacad-solver-controls').dataset.checklistRunning
      && !document.querySelector('.solver-chapters').disabled));

  await chapterStart.click();
  await course.waitForFunction(() => window.__chapterOpens.length === 5);
  await course.evaluate(() => {
    document.querySelector('#checklist-course').contentDocument.title = 'Course | 11.1. Manual navigation';
  });
  await course.waitForFunction(() => document.querySelector('.solver-checklist-status').textContent.includes('Course navigation changed'),
    undefined, { timeout: 5000 });
  check('manual course navigation cancels the chapter run', await course.evaluate(() =>
    window.__chapterOpens.length === 5 && !document.querySelector('#netacad-solver-controls').dataset.checklistRunning));
  check('checklist retries never click the quiz Start button', await course.evaluate(() => window.__chapterLaunches === 0));
  check('never revisits overlapping base/block wrappers', await course.evaluate(() =>
    !window.__chapterScrollTags.some(tag => tag === 'BASE-VIEW' || tag === 'BLOCK-VIEW')));
  await course.locator('[data-topic="12.2"]').click();
  await course.frameLocator('#checklist-course').getByRole('button', { name: 'Start', exact: true }).click();
  await chapterControls.locator(':scope > summary').click();
  await chapterControls.getByRole('button', { name: 'Select answers', exact: true }).click();
  const firstQuestion = course.frameLocator('#checklist-course').frameLocator('iframe');
  await firstQuestion.locator('#q1-0-input').waitFor();
  await course.waitForFunction(() => document.querySelector('#checklist-course').contentDocument
    .querySelector('reader-view').shadowRoot.querySelector('iframe').contentDocument.querySelector('#q1-0-input').checked,
  undefined, { timeout: 8000 });
  check('first question solves after a manual Start, before any submission', await course.evaluate(() =>
    window.__chapterLaunches === 1 && window.__chapterSubmits.length === 0)
      && !await firstQuestion.locator('#q1-1-input').isChecked());
  await firstQuestion.locator('#chapter-submit').click();
  check('the user can submit that first question normally', await course.evaluate(() =>
    window.__chapterSubmits.length === 1 && window.__chapterSubmits[0].correct));
  await course.close();

  console.log('\n== Ordered reading, nested scrolling and bounded rechecks ==');
  const reading = await boot(browser);
  await reading.evaluate(() => {
    for (const child of [...document.body.children]) if (child.id !== 'netacad-solver-controls') child.remove();
    document.body.insertAdjacentHTML('afterbegin', `<aside>
      <button class="nodeInfoContainer--fixture" aria-expanded="true">Module 12: Reading</button>
      <button class="subModuleBtn--fixture" id="reading-topic">12.1. Module Practice and Summary<span class="subModuleStatus--fixture"><img alt="start"></span></button>
      </aside><iframe id="reading-frame" style="width:700px;height:440px"></iframe>`);
    window.__readingEvents = [];
    window.__readingSeen = new Set();
    window.__readingVisits = 0;
    window.__transcriptClicks = 0;
    window.__tabClicks = [];
    window.__neverComplete = false;
    document.querySelector('#reading-topic').onclick = () => {
      const doc = document.querySelector('#reading-frame').contentDocument;
      doc.title = 'Course | 12.1. Lesson';
      if (doc.body.children.length) return;
      const host = doc.createElement('reader-view');
      doc.body.append(host);
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = '<style>.scrollport{height:240px;overflow:auto;scroll-behavior:smooth}lesson-piece{display:block}</style><div class="scrollport"></div>';
      const port = root.querySelector('.scrollport');
      const sections = [];
      const add = html => {
        const part = doc.createElement('lesson-piece');
        port.append(part);
        const shadow = part.attachShadow({ mode: 'open' });
        shadow.innerHTML = '<style>.component{padding:12px}p{height:130px;margin:8px 0}button{padding:10px}</style>' + html;
        const section = shadow.querySelector('.component');
        sections.push(section);
        return section;
      };
      // Identical content in separate roots must not share the same "already read" key.
      for (let i = 0; i < 2; i++) add('<section class="component text"><h2 class="js-heading">12.1.1 Reading</h2>'
        + '<p>Plain course text with no buttons.</p>'.repeat(6) + '</section>');
      const reveal = add(`<section class="component"><h2 class="js-heading">12.1.2 Explanation</h2>
        <button aria-expanded="false" aria-controls="explanation">Reveal explanation</button>
        <button role="tab" aria-controls="transcript">Video transcript</button>
        <div id="explanation" hidden><p>Newly revealed text.</p><p>The end of the explanation.</p></div></section>`);
      reveal.querySelector('[role="tab"]').onclick = () => window.__transcriptClicks++;
      reveal.querySelector('[aria-expanded]').onclick = event => {
        window.__readingEvents.push('reveal');
        event.currentTarget.setAttribute('aria-expanded', 'true');
        reveal.querySelector('#explanation').hidden = false;
      };
      const retry = add('<section class="component" id="retry-section"><h2 class="js-heading">12.1.3 Delayed check</h2>'
        + '<p>Delayed tracking text.</p>'.repeat(4) + '</section>');
      const tabs = add('<section class="component"><h2 class="js-heading">Configuration steps</h2><div class="steps"></div></section>');
      const seenTabs = new Set();
      const renderTabs = selected => {
        tabs.querySelector('.steps').innerHTML = [0, 1, 2].map(index =>
          `<button role="tab" aria-controls="step" aria-selected="${index === selected}">Step ${index + 1}</button>`).join('')
          + `<div role="tabpanel" id="step"><p data-tab="${selected}">Read configuration step ${selected + 1}.</p></div>`;
        tabs.querySelectorAll('button').forEach((button, index) => {
          button.onclick = () => { window.__tabClicks.push(index); renderTabs(index); };
        });
        observer.observe(tabs.querySelector('p'));
      };
      const seen = sections.map(() => new Set());
      const observer = new doc.defaultView.IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting || entry.intersectionRatio < 0.55) continue;
          const section = entry.target.closest('.component');
          if (section === tabs) {
            seenTabs.add(entry.target.dataset.tab);
            if (seenTabs.size === 3) {
              section.classList.add('is-complete');
              section.querySelector('.js-heading').classList.add('is-complete');
            }
            continue;
          }
          const index = sections.indexOf(section);
          const paragraphs = [...section.querySelectorAll('p')];
          const paragraph = paragraphs.indexOf(entry.target);
          if (index === 3 && paragraph === 0) window.__readingVisits++;
          seen[index].add(paragraph);
          window.__readingSeen.add(`${index}:${paragraph}`);
          if (seen[index].size === paragraphs.length && !section.classList.contains('is-complete')
            && (index !== 3 || (window.__readingVisits >= 2 && !window.__neverComplete))) {
            section.classList.add('is-complete');
            section.querySelector('.js-heading').classList.add('is-complete');
            window.__readingEvents.push(`read:${index}`);
          }
        }
        if (sections.every(section => section.classList.contains('is-complete')))
          document.querySelector('#reading-topic img').alt = 'completed';
      }, { root: port, threshold: [0, 0.55] });
      for (const section of sections) for (const paragraph of section.querySelectorAll('p')) observer.observe(paragraph);
      renderTabs(0);
      window.__resetReading = () => {
        window.__neverComplete = true;
        window.__readingVisits = 0;
        document.querySelector('#reading-topic img').alt = 'start';
        retry.classList.remove('is-complete');
        retry.querySelector('.js-heading').classList.remove('is-complete');
      };
    };
  });
  const readingControls = reading.locator('#netacad-solver-controls');
  await readingControls.locator(':scope > summary').click();
  await readingControls.locator('.solver-checklist > summary').click();
  await readingControls.locator('.solver-chapters input[value="12"]').check();
  check('uses a fast default pace', await readingControls.locator('input[type="number"]').inputValue() === '0.2');
  await readingControls.locator('input[type="number"]').fill('0.1');
  await readingControls.locator('.solver-checklist-start').click();
  await reading.waitForFunction(() => document.querySelector('.solver-checklist-status').textContent.startsWith('1/1 topics verified'),
    undefined, { timeout: 20000 }).catch(async error => {
      throw new Error(`${error.message}\n${JSON.stringify(await reading.evaluate(() => ({
        status: document.querySelector('.solver-checklist-status').textContent,
        issues: document.querySelector('.solver-checklist-issues').textContent,
        events: window.__readingEvents, seen: [...window.__readingSeen], visits: window.__readingVisits,
      })))}`);
    });
  check('does not reject a reading topic just because its title says Practice', await reading.evaluate(() =>
    document.querySelector('#reading-topic img').alt === 'completed'
      && !document.querySelector('.solver-checklist-issues').textContent.includes('manual review')));
  check('covers every paragraph before later buttons, across nested roots and scrollers', await reading.evaluate(() =>
    window.__readingSeen.size === 18 && window.__readingEvents.indexOf('read:0') < window.__readingEvents.indexOf('reveal')
      && window.__readingEvents.indexOf('read:1') < window.__readingEvents.indexOf('reveal')));
  check('reads newly revealed text without clicking the transcript', await reading.evaluate(() =>
    window.__readingEvents.includes('read:2') && window.__transcriptClicks === 0));
  check('selects each rerendered configuration tab once without cycling back', await reading.evaluate(() =>
    JSON.stringify(window.__tabClicks) === '[1,2]'));
  check('rechecks the section that did not register on its first visit', await reading.evaluate(() =>
    window.__readingVisits === 2 && window.__readingEvents.filter(event => event === 'reveal').length === 1));
  await reading.evaluate(() => window.__resetReading());
  await readingControls.locator('.solver-checklist-start').click();
  await reading.waitForFunction(() => document.querySelector('.solver-checklist-status').textContent.startsWith('0/1 topics verified'),
    undefined, { timeout: 15000 });
  check('stops after two passes and names an unconfirmed section instead of skipping it', await reading.evaluate(() =>
    window.__readingVisits === 2 && document.querySelector('#reading-topic img').alt === 'start'
      && document.querySelector('.solver-checklist-issues').textContent.includes('12.1.3 Delayed check')));
  await reading.close();

  console.log('\n== Native video skipping and document round trips ==');
  const smartContext = await browser.newContext();
  const smart = await boot(smartContext);
  const documentTabs = new Map();
  const documentLog = [];
  let holdDocuments = false;
  let nextDocumentId = 1;
  let watchingDocument = false;
  smartContext.on('page', async page => {
    if (!watchingDocument || await page.opener() !== smart) return;
    watchingDocument = false;
    const entry = { page, loaded: false };
    documentTabs.set(nextDocumentId++, entry);
    await page.waitForURL('https://www.netacad.com/solver-fixture-native.pdf');
    await page.waitForLoadState();
    entry.loaded = true;
    documentLog.push({ action: 'open', native: true, url: page.url() });
  });
  await smart.context().route('https://www.netacad.com/solver-fixture*', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Course document</title><p>Document loaded.</p>',
  }));
  await smart.exposeFunction('__documentAPI', async request => {
    if (request.action === 'watch') { watchingDocument = true; return { watching: true }; }
    if (request.action === 'open') {
      const page = await smart.context().newPage();
      const entry = { page, loaded: false };
      const tabId = nextDocumentId++;
      documentTabs.set(tabId, entry);
      documentLog.push({ action: 'open', url: request.url });
      void page.goto(request.url).then(() => { entry.loaded = true; }).catch(() => {});
      await page.bringToFront();
      return { tabId };
    }
    const tabId = request.tabId ?? documentTabs.keys().next().value;
    const entry = documentTabs.get(tabId);
    if (request.action === 'state') return { loaded: Boolean(entry?.loaded && !holdDocuments) };
    if (request.action === 'close') {
      if (entry) await entry.page.close();
      documentTabs.delete(tabId);
      watchingDocument = false;
      documentLog.push({ action: 'close' });
      await smart.bringToFront();
      return { closed: true };
    }
    return { error: 'Unknown document action.' };
  });
  await smart.evaluate(() => {
    for (const child of [...document.body.children]) {
      if (child.id !== 'netacad-solver-controls') child.remove();
    }
    const outline = document.createElement('aside');
    outline.innerHTML = `<button class="nodeInfoContainer--fixture" aria-expanded="true">Module 12: Media and documents</button>
      <button class="subModuleBtn--fixture" data-topic="12.1">12.1. Video<span class="subModuleStatus--fixture"><img alt="start"></span></button>
      <button class="subModuleBtn--fixture" data-topic="12.2">12.2. Documents<span class="subModuleStatus--fixture"><img alt="start"></span></button>`;
    const frame = document.createElement('iframe');
    frame.id = 'smart-course';
    frame.style.cssText = 'width:700px;height:300px;border:0;';
    document.body.prepend(outline, frame);
    window.__mediaEvents = [];
    window.__lazyPlays = 0;
    window.__documentActions = [];
    window.__documentClicks = 0;
    window.__exerciseDownloads = 0;
    chrome.runtime.sendMessage = (request, callback) => {
      window.__documentActions.push(request.action);
      window.__documentAPI(request).then(callback, error => callback({ error: error.message }));
    };
    for (const button of outline.querySelectorAll('[data-topic]')) {
      button.addEventListener('click', () => {
        const videoTopic = button.dataset.topic === '12.1';
        const doc = frame.contentDocument;
        doc.open();
        doc.write(`<!doctype html><title>Course | ${button.textContent}</title><div class="is-incomplete"><h2 class="js-heading">Activity</h2></div>`);
        doc.close();
        const block = doc.querySelector('.is-incomplete');
        const finish = () => {
          button.querySelector('img').alt = 'completed';
          block.className = 'is-complete';
        };
        if (videoTopic) {
          // A real 20-second HTML5 media source; no mocked duration or ended events.
          const buffer = new ArrayBuffer(44 + 20 * 8000 * 2);
          const data = new DataView(buffer);
          const text = (offset, value) => [...value].forEach((char, i) => data.setUint8(offset + i, char.charCodeAt(0)));
          text(0, 'RIFF'); data.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVEfmt ');
          data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true);
          data.setUint32(24, 8000, true); data.setUint32(28, 16000, true); data.setUint16(32, 2, true);
          data.setUint16(34, 16, true); text(36, 'data'); data.setUint32(40, buffer.byteLength - 44, true);
          const video = doc.createElement('video');
          video.src = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
          video.controls = true;
          video.loop = true;
          // A partially buffered player can still seek; do not wait for a full seekable range.
          Object.defineProperty(video, 'seekable', { get: () => ({ length: 1, start: () => 0, end: () => 1 }) });
          video.style.cssText = 'width:240px;height:120px;';
          for (const name of ['play', 'seeking', 'ended']) video.addEventListener(name, event => {
            window.__mediaEvents.push({ type: name, time: video.currentTime, trusted: event.isTrusted });
            if (name === 'ended') finish();
          });
          const play = doc.createElement('button');
          play.className = 'vjs-big-play-button';
          play.textContent = 'Play video';
          play.onclick = () => {
            window.__lazyPlays++;
            play.remove();
            block.append(video);
          };
          block.append(play);
          window.__smartVideo = video;
        } else {
          block.insertAdjacentHTML('beforeend', `<a href="https://www.netacad.com/solver-fixture.pdf" target="_self">Open PDF</a>
            <a href="https://www.netacad.com/solver-fixture.pdf">Duplicate PDF link</a>
            <a href="https://www.netacad.com/solver-fixture-signed?token=example" type="application/pdf">Open signed document</a>
            <a href="https://www.netacad.com/unrelated">Unrelated link</a>
            <button class="native-document"><span class="material-icons">description</span> Instructions</button>
            <button class="exercise-download"><span class="material-icons">file_download</span> Exercise</button>`);
          block.querySelector('.native-document').onclick = () => {
            doc.defaultView.open('https://www.netacad.com/solver-fixture-native.pdf', '_blank');
          };
          block.querySelector('.exercise-download').onclick = () => { window.__exerciseDownloads++; };
          let clicked = 0;
          block.addEventListener('click', event => {
            if (event.target.tagName === 'A' || event.target.closest('.native-document')) {
              clicked++; window.__documentClicks++;
              if (clicked === 3) finish();
            }
          });
        }
      });
    }
  });
  const smartControls = smart.locator('#netacad-solver-controls');
  await smartControls.locator(':scope > summary').click();
  await smartControls.locator('.solver-checklist > summary').click();
  await smartControls.locator('.solver-chapters input[value="12"]').check();
  await smartControls.locator('input[type="number"]').fill('0.5');
  const smartStart = smartControls.locator('.solver-checklist-start');
  check('video skipping and document visits are enabled by default', await smartControls.locator('.solver-skip-videos').isChecked()
    && await smartControls.locator('.solver-visit-documents').isChecked());
  await smartStart.click();
  await smart.waitForFunction(() => document.querySelector('.solver-checklist-status').textContent.startsWith('2/2 topics verified'),
    undefined, { timeout: 30000 }).catch(async error => {
      const state = await smart.evaluate(() => ({
        status: document.querySelector('.solver-checklist-status').textContent,
        issues: document.querySelector('.solver-checklist-issues').textContent,
        media: window.__mediaEvents, documents: window.__documentActions,
        duration: window.__smartVideo?.duration, currentTime: window.__smartVideo?.currentTime,
      }));
      throw new Error(`${error.message}\n${JSON.stringify(state)}\n${JSON.stringify(documentLog)}`);
    });
  check('skips to the end using native seeking and a real ended event', await smart.evaluate(() =>
    window.__mediaEvents.some(event => event.type === 'seeking' && event.time >= 19.7)
      && window.__mediaEvents.some(event => event.type === 'ended' && event.trusted)));
  check('restores the video mute and loop settings', await smart.evaluate(() =>
    !window.__smartVideo.muted && window.__smartVideo.loop && window.__smartVideo.paused));
  check('opens each document once, including signed PDFs and native description buttons', documentLog.filter(event => event.action === 'open').length === 3
    && documentLog.some(event => event.native) && await smart.evaluate(() => window.__documentClicks === 3 && window.__exerciseDownloads === 0));
  check('returns to the reader, closes temporary tabs and verifies completion', documentTabs.size === 0
    && documentLog.filter(event => event.action === 'close').length === 3
    && await smart.evaluate(() => document.querySelector('#smart-course').contentDocument.title.includes('12.2.')));

  await smart.evaluate(() => {
    const heading = document.querySelector('#smart-course').contentDocument.createElement('h2');
    heading.id = 'test-unfinished-quiz';
    heading.className = 'js-heading';
    heading.textContent = 'Module Quiz';
    document.querySelector('#smart-course').contentDocument.body.append(heading);
  });
  await smartControls.evaluate(element => { element.open = true; });
  await smartStart.click();
  await smart.waitForFunction(() => document.querySelector('.solver-checklist-status').textContent.startsWith('1/2 topics verified'));
  check('does not claim full completion when a graded section is still pending', await smart.evaluate(() =>
    document.querySelector('.solver-checklist-issues').textContent.includes('remaining graded activity needs manual review')));
  await smart.evaluate(() => document.querySelector('#smart-course').contentDocument.querySelector('#test-unfinished-quiz').remove());
  holdDocuments = true;
  await smart.evaluate(() => {
    document.querySelector('[data-topic="12.2"] img').alt = 'start';
    document.querySelector('#netacad-solver-controls').open = true;
  });
  const priorStates = await smart.evaluate(() => window.__documentActions.filter(action => action === 'state').length);
  await smartStart.click();
  await smart.waitForFunction(count => window.__documentActions.filter(action => action === 'state').length > count, priorStates);
  check('automation options cannot change during a run', await smartControls.locator('.solver-skip-videos').isDisabled()
    && await smartControls.locator('.solver-visit-documents').isDisabled());
  await smartControls.evaluate(element => { element.open = true; });
  await smartControls.locator('.solver-checklist-stop').click();
  await smart.waitForFunction(() => !document.querySelector('#netacad-solver-controls').dataset.checklistRunning);
  check('Stop closes a pending document without marking its topic complete', documentTabs.size === 0
    && await smart.evaluate(() => document.querySelector('[data-topic="12.2"] img').alt === 'start'));

  await smartControls.locator('.solver-skip-videos').uncheck();
  await smart.evaluate(() => { document.querySelector('[data-topic="12.1"] img').alt = 'start'; });
  check('starts the lazy Video.js poster once before seeking', await smart.evaluate(() => window.__lazyPlays === 1));
  const priorSeeks = await smart.evaluate(() => window.__mediaEvents.filter(event => event.type === 'seeking').length);
  await smartStart.click();
  await smart.waitForFunction(() => window.__smartVideo.currentTime > 0.5 && window.__smartVideo.currentTime < 10);
  await smartControls.locator('.solver-checklist-stop').click();
  await smart.waitForFunction(() => !document.querySelector('#netacad-solver-controls').dataset.checklistRunning);
  check('full playback remains available and Stop pauses the automated video', await smart.evaluate(count =>
    window.__mediaEvents.filter(event => event.type === 'seeking').length === count
      && window.__smartVideo.paused && !window.__smartVideo.muted && window.__smartVideo.loop, priorSeeks));
  await smart.close();
  await smartContext.close();

  console.log('\n== Embedded lab reveals and animation timelines ==');
  const labs = await boot(browser);
  await labs.evaluate(() => {
    for (const child of [...document.body.children]) if (child.id !== 'netacad-solver-controls') child.remove();
    const outline = document.createElement('aside');
    const titles = ['Lab - Embedded reveals', 'Animations - Native timeline', 'Animation - Seek bar',
      'Animation - Accessible slider', 'Animation - Skip control', 'Lab - Hands-on task',
      'Lab - Embedded self-check', 'Graded Lab'];
    outline.innerHTML = '<button class="nodeInfoContainer--fixture" aria-expanded="true">Module 13: Labs</button>'
      + titles.map((title, index) => `<button class="subModuleBtn--fixture" data-topic="13.${index + 1}">13.${index + 1}. ${title}<span class="subModuleStatus--fixture"><img alt="start"></span></button>`).join('');
    const frame = document.createElement('iframe');
    frame.style.cssText = 'width:700px;height:430px;border:1px solid #ccc';
    document.body.prepend(outline, frame);
    window.__labEvents = [];
    window.__animationFinishes = [];
    window.__timelineEvents = [];
    window.__sliderEvents = [];
    window.__rangeWrites = window.__labStarts = window.__handsOnNext = window.__handsOnReveals = window.__gradedLabVisits = 0;
    const nativeNow = performance.now.bind(performance);
    let timeOffset = 0;
    performance.now = () => nativeNow() + timeOffset;
    for (const button of outline.querySelectorAll('[data-topic]')) button.onclick = () => {
      const doc = frame.contentDocument;
      doc.title = `Course | ${button.textContent}`;
      doc.body.innerHTML = '<style>.component{padding:12px;min-height:180px}button{padding:10px}#visual{height:50px;background:green}</style><section class="component"><h2 class="js-heading"></h2></section>';
      const scope = doc.querySelector('.component');
      scope.querySelector('h2').textContent = button.textContent;
      const finish = () => {
        scope.classList.add('is-complete');
        scope.querySelector('.js-heading').classList.add('is-complete');
        button.querySelector('img').alt = 'completed';
      };
      const key = button.dataset.topic;
      if (key === '13.1') {
        scope.insertAdjacentHTML('beforeend', '<aside hidden><h2>Graded lab</h2><p>1 of 2 Questions</p><textarea></textarea></aside><button>Launch interactive lab</button>');
        scope.querySelector('button').onclick = event => {
          window.__labEvents.push('launch');
          event.currentTarget.remove();
          const inner = doc.createElement('iframe');
          inner.style.cssText = 'width:600px;height:250px';
          inner.onload = () => setTimeout(() => {
            const child = inner.contentDocument;
            const root = child.querySelector('reader-lab').attachShadow({ mode: 'open' });
            const render = step => {
              root.innerHTML = `<h3>Task ${step + 1} of 3</h3><button id="next">Next task</button><button id="reveal">Show answer</button><p id="answer" hidden>Explanation ${step + 1}</p>`;
              let revealed = false;
              root.querySelector('#reveal').onclick = event => {
                revealed = true;
                window.__labEvents.push(`reveal:${step}`);
                root.querySelector('#answer').hidden = false;
                event.currentTarget.setAttribute('aria-expanded', 'true');
                if (step === 1) {
                  const popup = doc.createElement('dialog');
                  popup.innerHTML = '<h3>Lab explanation</h3><p>Read this popup before the next task.</p><button aria-label="Close explanation">Close</button>';
                  popup.querySelector('button').onclick = () => { window.__labEvents.push('close'); popup.close(); };
                  doc.body.append(popup);
                  popup.showModal();
                }
              };
              root.querySelector('#next').onclick = () => {
                if (!revealed) { window.__labEvents.push('next-before-reveal'); return; }
                window.__labEvents.push(`next:${step}`);
                // A valid long lab must not trip the idle-progress watchdog.
                timeOffset += 16000;
                if (step === 2) finish(); else render(step + 1);
              };
            };
            render(0);
          }, 250);
          inner.srcdoc = '<!doctype html><title>Lab steps</title><reader-lab></reader-lab>';
          scope.append(inner);
        };
      } else if (key === '13.2') {
        scope.insertAdjacentHTML('beforeend', '<div id="visual"></div><button>Play animation</button>');
        scope.querySelector('button').onclick = () => {
          const animation = scope.querySelector('#visual').animate([{ opacity: 0.2 }, { opacity: 1 }], 60000);
          window.__labAnimation = animation;
          animation.onfinish = event => {
            window.__animationFinishes.push({ trusted: event.isTrusted, time: animation.currentTime });
            finish();
          };
        };
      } else if (key === '13.3') {
        scope.insertAdjacentHTML('beforeend', '<input type="range" min="0" max="42" value="0" aria-label="Animation progress">');
        const range = scope.querySelector('input');
        const native = Object.getOwnPropertyDescriptor(doc.defaultView.HTMLInputElement.prototype, 'value');
        Object.defineProperty(range, 'value', {
          get() { return native.get.call(this); },
          set() { window.__rangeWrites++; },
        });
        for (const type of ['input', 'change']) range.addEventListener(type, event => {
          window.__timelineEvents.push({ type, value: range.value, local: event instanceof doc.defaultView.Event });
          if (type === 'change' && range.value === '42') finish();
        });
      } else if (key === '13.4') {
        scope.insertAdjacentHTML('beforeend', '<input type="range" class="animation-progress" aria-label="Volume" value="25"><div role="slider" tabindex="0" aria-label="Animation timeline" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">Timeline</div>');
        scope.querySelector('input').oninput = () => window.__sliderEvents.push({ key: 'volume' });
        scope.querySelector('[role="slider"]').onkeydown = event => {
          window.__sliderEvents.push({ key: event.key, code: event.keyCode, local: event instanceof doc.defaultView.KeyboardEvent });
          if (event.key === 'End') { event.currentTarget.setAttribute('aria-valuenow', '100'); finish(); }
        };
      } else if (key === '13.5') {
        scope.insertAdjacentHTML('beforeend', '<canvas></canvas><button>Skip animation</button>');
        scope.querySelector('button').onclick = () => { window.__labEvents.push('skip-animation'); finish(); };
      } else if (key === '13.6') {
        scope.insertAdjacentHTML('beforeend', '<textarea aria-label="Lab response"></textarea><button aria-controls="manual-answer">Next task</button><button aria-controls="manual-answer">Show answer</button><p id="manual-answer" hidden>Manual lab explanation</p>');
        scope.querySelectorAll('button')[0].onclick = () => window.__handsOnNext++;
        scope.querySelectorAll('button')[1].onclick = event => {
          window.__handsOnReveals++;
          event.currentTarget.setAttribute('aria-expanded', 'true');
          scope.querySelector('p').hidden = false;
        };
      } else {
        if (key === '13.8') window.__gradedLabVisits++;
        scope.insertAdjacentHTML('beforeend', '<div class="adaptive-start-screen__widget"><button>Start</button></div>');
        scope.querySelector('button').onclick = () => window.__labStarts++;
      }
    };
  });
  const labControls = labs.locator('#netacad-solver-controls');
  await labControls.locator(':scope > summary').click();
  await labControls.locator('.solver-checklist > summary').click();
  await labControls.locator('.solver-chapters input[value="13"]').check();
  await labControls.locator('input[type="number"]').fill('0.1');
  check('animation skipping is enabled by default', await labControls.locator('.solver-skip-animations').isChecked());
  await labControls.locator('.solver-checklist-start').click();
  await labs.waitForFunction(() => !document.querySelector('#netacad-solver-controls').dataset.checklistRunning,
    undefined, { timeout: 30000 }).catch(async error => {
      throw new Error(`${error.message}\n${JSON.stringify(await labs.evaluate(() => ({
        status: document.querySelector('.solver-checklist-status').textContent,
        issues: document.querySelector('.solver-checklist-issues').textContent, events: window.__labEvents,
      })))}`);
    });
  check('launches an inline lab once and handles delayed frame/shadow content and repeated Next controls', await labs.evaluate(() =>
    JSON.stringify(window.__labEvents) === JSON.stringify(['launch', 'reveal:0', 'next:0', 'reveal:1', 'close', 'next:1', 'reveal:2', 'next:2', 'skip-animation'])));
  check('finishes a native animation through its real finish event', await labs.evaluate(() =>
    window.__animationFinishes.length === 1 && window.__animationFinishes[0].trusted && window.__animationFinishes[0].time === 60000));
  check('seeks native range controls using their own frame events and native setter', await labs.evaluate(() =>
    window.__rangeWrites === 0 && JSON.stringify(window.__timelineEvents) === JSON.stringify([
      { type: 'input', value: '42', local: true }, { type: 'change', value: '42', local: true },
    ])));
  check('uses accessible End controls without changing animation volume', await labs.evaluate(() =>
    JSON.stringify(window.__sliderEvents) === JSON.stringify([{ key: 'End', code: 35, local: true }])));
  check('reveals hands-on instructions but never advances a response form or starts a lab self-check', await labs.evaluate(() =>
    window.__handsOnReveals === 1 && window.__handsOnNext === 0 && window.__labStarts === 0 && window.__gradedLabVisits === 0));
  check('only verifies the five labs/animations whose renderer confirmed completion', await labControls.evaluate(element =>
    element.querySelector('progress').value === 5 && element.querySelector('.solver-checklist-issues').children.length === 3));
  await labControls.locator('.solver-skip-animations').uncheck();
  for (const early of [true, false]) {
    await labs.evaluate(() => { document.querySelector('[data-topic="13.2"] img').alt = 'start'; });
    await labControls.locator('.solver-checklist-start').click();
    await labs.waitForFunction(early => window.__labAnimation?.playState === 'running'
      && (early || document.querySelector('.solver-checklist-status').textContent.includes('playing animation')), early);
    await labControls.locator('.solver-checklist-stop').click();
    await labs.waitForFunction(() => !document.querySelector('#netacad-solver-controls').dataset.checklistRunning);
    check(`Stop pauses full animation playback ${early ? 'immediately after Play' : 'while waiting for completion'}`, await labs.evaluate(() =>
      window.__labAnimation.playState === 'paused' && window.__labAnimation.currentTime < 10000
        && window.__animationFinishes.length === 1 && document.querySelector('[data-topic="13.2"] img').alt === 'start'));
  }
  await labs.close();

  console.log('\n== Adobe Animate controls without accessible labels ==');
  const adobe = await boot(browser, 'safe');
  await adobe.evaluate(() => {
    document.querySelector('.q1').remove();
    document.querySelector('#submit').remove();
    const outline = document.createElement('div');
    outline.innerHTML = '<button class="nodeInfoContainer--fixture" aria-expanded="true">Module 14: Routing</button><button class="subModuleBtn--fixture">14.1. Routing<span class="subModuleStatus--fixture"><img alt="start"></span><span class="count">0 / 1</span></button>';
    const topic = outline.querySelector('.subModuleBtn--fixture');
    const frame = document.createElement('iframe');
    frame.title = 'Course content';
    frame.style.cssText = 'width:600px;height:400px';
    document.body.append(outline, frame);
    topic.onclick = () => {
      const doc = frame.contentDocument;
      doc.open();
      doc.write('<!doctype html><title>Course | 14.1. Routing</title><div class="component is-incomplete" style="min-height:300px"><h2 class="js-heading">IP-pakket ingekapseld in een Ethernet-frame</h2><play-pause></play-pause><aa-scrubber></aa-scrubber></div>');
      doc.close();
      const component = doc.querySelector('.component');
      const player = doc.querySelector('play-pause');
      const scrubber = doc.querySelector('aa-scrubber');
      const play = doc.createElement('button');
      player.attachShadow({mode: 'open'}).append(play);
      const timeline = doc.createElement('input');
      timeline.type = 'range';
      timeline.min = '0';
      timeline.max = '400';
      timeline.value = '0';
      scrubber.attachShadow({mode: 'open'}).append(timeline);
      const state = window.__adobe = {player, timeline, ticks: 0, commits: 0};
      player.paused = true;
      let timer;
      const pause = () => { player.paused = true; clearInterval(timer); };
      const finish = () => {
        pause();
        component.className = 'component is-complete';
        doc.querySelector('.js-heading').classList.add('is-complete');
        topic.querySelector('img').alt = 'completed';
        topic.querySelector('.count').textContent = '1 / 1';
      };
      play.onclick = () => {
        if (!player.paused) return pause();
        player.paused = false;
        timer = setInterval(() => {
          state.ticks++;
          timeline.value = Number(timeline.value) + 1;
          if (timeline.value === timeline.max) finish();
        }, 25);
      };
      timeline.oninput = pause;
      timeline.onclick = () => {
        state.commits++;
        if (timeline.value === timeline.max) finish();
      };
      state.reset = () => { pause(); topic.querySelector('img').alt = 'start'; topic.querySelector('.count').textContent = '0 / 1'; };
    };
  });
  const adobeControls = adobe.locator('#netacad-solver-controls');
  await adobeControls.locator(':scope > summary').click();
  await adobeControls.locator('.solver-checklist > summary').click();
  await adobeControls.locator('.solver-checklist-refresh').click();
  await adobeControls.locator('.solver-chapters input').check();
  await adobeControls.locator('.solver-checklist-start').click();
  await adobe.waitForFunction(() => !document.querySelector('#netacad-solver-controls').dataset.checklistRunning);
  check('unlabelled Adobe scrubber reaches the end and commits native completion', await adobe.evaluate(() =>
    window.__adobe.timeline.value === '400' && window.__adobe.commits === 1
      && document.querySelector('.subModuleStatus--fixture img').alt === 'completed'));
  await adobeControls.locator('.solver-skip-animations').uncheck();
  await adobe.evaluate(() => window.__adobe.reset());
  await adobeControls.locator('.solver-checklist-start').click();
  await adobe.waitForFunction(() => window.__adobe.ticks >= 2);
  await adobeControls.locator('.solver-checklist-stop').click();
  await adobe.waitForFunction(() => !document.querySelector('#netacad-solver-controls').dataset.checklistRunning);
  const adobeTicks = await adobe.evaluate(() => window.__adobe.ticks);
  await adobe.waitForTimeout(200);
  check('Stop pauses full Adobe playback without marking it complete', await adobe.evaluate(ticks =>
    window.__adobe.player.paused && window.__adobe.ticks === ticks
      && document.querySelector('.subModuleStatus--fixture img').alt === 'start', adobeTicks));
  await adobe.close();

  console.log('\n== Native change events and delayed shadow Submit buttons ==');
  const native = await boot(browser, 'safe');
  const nativeWarnings = [];
  native.on('console', message => { if (message.type() === 'warning' && message.text().includes('[netacad-solver] brutal:')) nativeWarnings.push(message.text()); });
  await native.evaluate(url => {
    const first = window.__COMPONENTS__.find(component => component._id === 'q1');
    const definitions = [{...first, _id: 'native1', body: '<p>Native question one.</p>'}, {...first, _id: 'native2', body: '<p>Native question two.</p>'}];
    window.__COMPONENTS__ = definitions;
    window.__nativeDefinitions = definitions;
    for (const child of [...document.body.children]) {
      if (child.id !== 'netacad-solver-controls' && child.tagName !== 'STYLE') child.remove();
    }
    const frame = document.createElement('iframe');
    frame.style.cssText = 'width:900px;height:590px;border:0;display:block';
    document.body.prepend(frame);
    const doc = frame.contentDocument;
    doc.open(); doc.write('<!doctype html><title>Native self-check</title><body></body>'); doc.close();
    window.__nativeFrame = frame;
    frame.contentWindow.__listeners = [];
    frame.contentWindow.chrome = {
      runtime: {...window.chrome.runtime, onMessage: {addListener: listener => frame.contentWindow.__listeners.push(listener)}},
      storage: window.chrome.storage,
    };
    frame.contentWindow.fetch = async () => ({ok: true, json: async () => definitions});
    window.__nativeMount = delay => {
      doc.title = 'Native self-check';
      doc.body.replaceChildren();
      window.__nativeCounts = {native1: 0, native2: 0, answerChanges: 0, unrelated: 0};
      window.__nativeInputs = [];
      window.__nativeRoots = [];
      for (const component of definitions) {
        const id = component._id;
        const host = doc.createElement('mcq-view');
        host.className = id;
        host.style.display = 'block';
        doc.body.append(host);
        const root = host.attachShadow({mode: 'open'});
        window.__nativeRoots.push(root);
        root.innerHTML = `<style>.component{min-height:180px;padding:12px} [role=radio]{padding:8px} input{display:none} button{padding:10px}</style>
          <div class="component ${id}"><div>${component.body.replace(/<[^>]*>/g, '')}</div></div>`;
        const question = root.querySelector('.component');
        const controls = doc.createElement('buttons-view');
        const buttonRoot = controls.attachShadow({mode: 'open'});
        buttonRoot.innerHTML = '<button disabled aria-label="Submit answers"><span>Submit answers</span></button>';
        const submit = buttonRoot.querySelector('button');
        for (const [index, item] of component._items.entries()) {
          const role = doc.createElement('div');
          role.setAttribute('role', 'radio');
          role.setAttribute('aria-checked', 'false');
          role.tabIndex = 0;
          role.innerHTML = `<input type="radio" aria-hidden="true" id="${id}-${index}-input" name="${id}"><label id="${id}-${index}-label">${item.text.replace(/<[^>]*>/g, '')}</label>`;
          const input = role.querySelector('input');
          if (index === 0) window.__nativeInputs.push(input);
          input.onchange = () => {
            window.__nativeCounts.answerChanges++;
            role.setAttribute('aria-checked', String(input.checked));
            setTimeout(() => { submit.disabled = false; }, delay);
          };
          question.append(role);
        }
        question.append(controls);
        submit.onclick = () => {
          window.__nativeCounts[id]++;
          submit.disabled = true;
          question.classList.add('is-complete');
        };
      }
    };
    window.__nativeMount(1600);
  }, COMPONENT_URL);
  await native.frames()[1].addScriptTag({content: bundle});
  await native.evaluate(url => {
    window.__listeners.forEach(listener => listener({componentsUrl: `${url}?native-submit`}));
    window.__nativeFrame.contentWindow.__listeners.forEach(listener => listener({componentsUrl: `${url}?native-submit`}));
  }, COMPONENT_URL);
  await native.waitForFunction(() => window.__nativeInputs.every(input =>
    input.parentElement.querySelector('label').classList.contains('netacad-solver-highlight')));
  await native.waitForTimeout(1600);
  await native.evaluate(() => document.querySelector('#netacad-solver-controls button[data-mode="brutal"]').click());
  await native.waitForFunction(() => window.__nativeCounts.native1 === 1 && window.__nativeCounts.native2 === 1, null, {timeout: 10000});
  check('uses native input changes to update the answer controls', await native.evaluate(() =>
    window.__nativeCounts.answerChanges === 2 && window.__nativeInputs.every(input => input.checked)));
  check('waits for validation and submits each inline shadow question exactly once', await native.evaluate(() =>
    window.__nativeCounts.native1 === 1 && window.__nativeCounts.native2 === 1));
  await native.evaluate(() => {
    document.querySelector('#netacad-solver-controls button[data-mode="safe"]').click();
    document.querySelector('#netacad-solver-controls button[data-mode="brutal"]').click();
  });
  await native.waitForTimeout(5500);
  check('completed self-checks are not retried or reported as missing Submit', nativeWarnings.length === 0, nativeWarnings.join('; '));
  await native.frames()[1].evaluate(press('y'));
  await native.waitForTimeout(600);
  check('does not resubmit completed self-checks', await native.evaluate(() =>
    window.__nativeCounts.native1 === 1 && window.__nativeCounts.native2 === 1));

  await native.evaluate(() => {
    document.querySelector('#netacad-solver-controls button[data-mode="safe"]').click();
    window.__nativeMount(500);
    document.querySelector('#netacad-solver-controls button[data-mode="brutal"]').click();
  });
  await native.waitForFunction(() => window.__nativeInputs.some(input => input.checked));
  await native.evaluate(() => document.querySelector('#netacad-solver-controls button[data-mode="safe"]').click());
  await native.waitForTimeout(700);
  check('Easy cancels a Submit that is still waiting for validation', await native.evaluate(() =>
    window.__nativeCounts.native1 === 0 && window.__nativeCounts.native2 === 0));

  await native.evaluate(() => {
    window.__nativeMount(500);
    document.querySelector('#netacad-solver-controls button[data-mode="brutal"]').click();
  });
  await native.waitForFunction(() => window.__nativeInputs.some(input => input.checked));
  await native.evaluate(() => {
    const doc = window.__nativeFrame.contentDocument;
    doc.title = 'Next lesson';
    doc.body.innerHTML = '<button>Submit unrelated form</button>';
    doc.querySelector('button').onclick = () => { window.__nativeCounts.unrelated++; };
  });
  await native.waitForTimeout(700);
  check('navigation cancels the pending Submit instead of clicking the next form', await native.evaluate(() =>
    window.__nativeCounts.native1 === 0 && window.__nativeCounts.native2 === 0 && window.__nativeCounts.unrelated === 0));
  await native.evaluate(url => {
    const doc = window.__nativeFrame.contentDocument;
    const components = [
      {_id: 'reveal1', _component: 'hotgraphic', body: '<p>Course reveal, not a question.</p>', _items: [{text: '<p>Reveal instructions</p>'}]},
      {_id: 'opaque1', _component: 'mcq', body: '<p>Unreadable practice controls.</p>', _items: [{text: '<p>Unavailable answer</p>', _isCorrect: true}]},
    ];
    window.__COMPONENTS__ = components;
    window.__nativeFrame.contentWindow.fetch = async () => ({ok: true, json: async () => components});
    doc.title = 'Interactive instructions';
    doc.body.innerHTML = '<div class="reveal1"><p>Course reveal, not a question.</p><p>Reveal instructions</p></div><div class="opaque1"><p>Unreadable practice controls.</p></div><button>Submit unrelated form</button>';
    doc.querySelector('button').onclick = () => { window.__nativeCounts.unrelated++; };
    window.__listeners.forEach(listener => listener({componentsUrl: `${url}?reveal-only`}));
    window.__nativeFrame.contentWindow.__listeners.forEach(listener => listener({componentsUrl: `${url}?reveal-only`}));
  }, COMPONENT_URL);
  await native.waitForTimeout(1700);
  await native.evaluate(() => document.querySelector('#netacad-solver-controls button[data-mode="brutal"]').click());
  await native.waitForTimeout(1800);
  check('reveal-only and unreadable activities never submit another form or report a missing Submit', await native.evaluate(() =>
    window.__nativeCounts.unrelated === 0) && nativeWarnings.length === 0, nativeWarnings.join('; '));
  await native.evaluate(url => {
    document.querySelector('#netacad-solver-controls button[data-mode="safe"]').click();
    window.__COMPONENTS__ = window.__nativeDefinitions;
    window.__nativeFrame.contentWindow.fetch = async () => ({ok: true, json: async () => window.__nativeDefinitions});
    window.__nativeMount(0);
    window.__nativeRoots.forEach(root => {
      root.querySelector('buttons-view').remove();
      root.addEventListener('change', () => root.querySelector('.component').classList.add('is-complete'));
    });
    window.__listeners.forEach(listener => listener({componentsUrl: `${url}?auto-check`}));
    window.__nativeFrame.contentWindow.__listeners.forEach(listener => listener({componentsUrl: `${url}?auto-check`}));
  }, COMPONENT_URL);
  await native.waitForTimeout(1700);
  await native.evaluate(() => document.querySelector('#netacad-solver-controls button[data-mode="brutal"]').click());
  await native.waitForFunction(() => window.__nativeCounts.answerChanges === 2);
  await native.waitForTimeout(5500);
  check('automatically completed questions do not require a Submit button', await native.evaluate(() =>
    window.__nativeCounts.native1 === 0 && window.__nativeCounts.native2 === 0
      && window.__nativeRoots.every(root => root.querySelector('.component').classList.contains('is-complete')))
    && nativeWarnings.length === 0, nativeWarnings.join('; '));
  await native.close();

  await browser.close();

  console.log(`\n========================================`);
  console.log(`TOTAL: ${totalPass}/${totalPass + totalFail} checks passed`);

  if (totalFail) {
    console.log('FAILURES:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
}

main();
