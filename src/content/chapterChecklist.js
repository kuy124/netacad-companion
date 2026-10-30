import { deepHtmlSearchAll } from './domHelper';

// ponytail: native timelines and readable frames; opaque players still need manual playback.
// NetAcad's CSS-module prefixes are stable; the generated suffixes are not.
const HEADER = 'button[class*="nodeInfoContainer"]';
const TOPIC = 'button[class*="subModuleBtn"]';
const text = element => (element?.textContent || '').replace(/\s+/g, ' ').trim();
const label = element => (element.getAttribute('aria-label') || element.getAttribute('title')
  || text(element) || element.value || '').replace(/\s+/g, ' ').trim();
const rendered = element => {
  const view = element.ownerDocument.defaultView;
  if (!view || !element.isConnected) return false;
  const frame = view.frameElement;
  const host = element.getRootNode().host;
  return element.getClientRects().length > 0 && view.getComputedStyle(element).visibility !== 'hidden'
    && !element.closest('[hidden], [inert], [aria-hidden="true"]')
    && (!frame || rendered(frame)) && (!host || rendered(host));
};
let activeRun = null;

const complete = topic => {
  if (!topic?.button?.isConnected)
    return false;
  const status = topic.button.querySelector('[class*="subModuleStatus"] img[alt]')?.alt;
  if (status)
    return status.trim().toLowerCase() === 'completed';
  const counts = text(topic.button).match(/(\d+)\s*\/\s*(\d+)\s*$/);
  return Boolean(counts && Number(counts[2]) > 0 && Number(counts[1]) === Number(counts[2]));
};

const readOutline = () => {
  const chapters = [];
  let chapter = null;
  for (const button of document.querySelectorAll(`${HEADER}, ${TOPIC}`)) {
    if (button.matches(HEADER)) {
      chapter = null;
      const title = text(button).replace(/\s*\d+\s*%\s*$/, '').trim();
      const number = title.match(/\b(?:module|chapter)\s+(\d+)\b/i)?.[1];
      if (number && rendered(button)) {
        chapter = { number, title, button, topics: [] };
        chapters.push(chapter);
      }
    } else if (chapter) {
      const title = text(button).replace(/\s*\d+\s*\/\s*\d+\s*$/, '').trim();
      chapter.topics.push({
        title, key: title.match(/^(\d+\.\d+)(?=[.\s]|$)/)?.[1] || title,
        button, locked: button.disabled || button.getAttribute('aria-disabled') === 'true'
          || /\bprerequisites?\b/i.test(title),
      });
    }
  }
  return chapters;
};

const topicDocument = topic => {
  const documents = [];
  for (const iframe of deepHtmlSearchAll(document, 'iframe')) {
    try { if (iframe.contentDocument) documents.push(iframe.contentDocument); } catch (e) { /* Different origin. */ }
  }
  documents.push(document);
  const key = topic.key.toLowerCase();
  return documents.find(doc => doc.title.split('|').some(part => {
    const title = part.trim().toLowerCase();
    return title === key || title.startsWith(`${key}.`) || title.startsWith(`${key} `);
  }));
};

const delay = (ms, signal) => {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
};

const waitFor = async (read, signal, message, timeout = 15000) => {
  const deadline = performance.now() + timeout;
  do {
    signal.throwIfAborted();
    const result = await read();
    if (result) return result;
    await delay(250, signal);
  } while (performance.now() < deadline);
  throw new Error(message);
};

const scrollTo = async (element, block, signal, pace) => {
  signal.throwIfAborted();
  element.scrollIntoView({ block, behavior: 'instant' });
  await delay(pace, signal);
};

const ACTIVITY_SELECTOR = '.component, .adaptive-start-screen__widget';
const parentElement = element => element.parentElement || element.getRootNode().host
  || element.ownerDocument.defaultView?.frameElement;
const LAB_START = /^(start|begin|open|launch)(\s+((the\s+)?(interactive\s+)?lab(oratory)?|activity))?$/i;
const NEXT = /^(next|continue)(\s+(to\s+(the\s+)?)?(next\s+)?(step|task|slide|frame|page|part|section)(\s+\d+)?)?$/i;
const ANIMATION_END = /^(skip(\s+(animation|to\s+(the\s+)?end))?|(jump|go)\s+to\s+(the\s+)?end|(last|final)\s+(step|slide|frame)|end(\s+animation)?)$/i;
const isLab = (scope, title = '') => scope.matches('.lab, [data-component="lab"], [class*="lab__" i], [class*="lab-" i]')
  || /\blabs?\b/i.test(`${title} ${text(deepHtmlSearchAll(scope, '.js-heading, h1, h2')[0])}`);
const assessmentControl = element => {
  for (let node = element; node; node = parentElement(node))
    if (node.matches('assessment-block-strip-view, .adaptive-start-screen__widget, .assessment, .quiz, .exam, [data-graded="true"]')) return true;
  return false;
};
const findAssessmentStart = (scope, title = '') => deepHtmlSearchAll(scope, 'button, [role="button"], a').find(element =>
  rendered(element) && /^(start|begin)(?: (?:quiz|assessment|activity|check|exam|test))?$/i.test(label(element))
  && !(isLab(scope, title) && LAB_START.test(label(element)) && !assessmentControl(element)
    && !/\b(quiz|exam|graded|assessment|check your understanding)\b/i.test(text(scope))));
const activityFor = element => {
  let activity;
  for (let node = element; node; node = parentElement(node))
    if (node.matches?.(ACTIVITY_SELECTOR)) activity = node;
  return activity;
};

// Cover the text between viewport positions, including readers with nested scrolling.
const readContent = async (element, signal, pace, guard) => {
  const doc = element.ownerDocument;
  let container = doc.scrollingElement;
  for (let node = element; node?.ownerDocument === doc; node = parentElement(node)) {
    if (node.clientHeight > 80 && node.scrollHeight > node.clientHeight + 2
      && /auto|scroll/.test(doc.defaultView.getComputedStyle(node).overflowY)) {
      container = node;
      break;
    }
  }
  await scrollTo(element, 'start', signal, pace);
  while (container && element.isConnected) {
    guard();
    const viewport = container === doc.scrollingElement ? doc.defaultView.innerHeight : container.clientHeight;
    const edge = container === doc.scrollingElement ? viewport : container.getBoundingClientRect().top + container.clientTop + viewport;
    const remaining = container === element ? container.scrollHeight - container.scrollTop - viewport
      : element.getBoundingClientRect().bottom - edge;
    if (remaining <= 2) break;
    const before = container.scrollTop;
    container.scrollBy({ top: Math.min(viewport * 0.75, remaining), behavior: 'instant' });
    await delay(pace, signal);
    if (container.scrollTop <= before) break;
  }
};

const isDocumentLink = link => [link.getAttribute('href'), link.getAttribute('download')].some(value =>
  /\.(pdf|docx?|pptx?|xlsx?|od[tps]|rtf|txt)(?:$|[?#])/i.test(value || ''))
  || /^(application\/(pdf|msword|vnd\.(openxmlformats-officedocument|ms-|oasis\.opendocument))|text\/plain)/i.test(link.type);

const isDocumentButton = button => /^description\s|^(open|view|read)\s+(the\s+)?(document|instructions|pdf)\b/i.test(
  `${button.getAttribute('aria-label') || ''} ${text(button)}`.trim())
  || deepHtmlSearchAll(button, '*').some(element => !element.childElementCount && text(element) === 'description');

const documentRequest = request => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage({ type: 'netacad-solver-document', ...request }, response => {
    const error = chrome.runtime.lastError?.message || response?.error;
    if (error || !response) reject(new Error(error || 'The document tab could not be opened. Reload the extension.'));
    else resolve(response);
  });
});

const visitDocument = async (link, signal, pace, guard) => {
  const url = link.matches('a[href]') ? new URL(link.href) : null;
  if (url && (url.protocol !== 'https:' || url.username || url.password))
    throw new Error('Only HTTPS document links without embedded credentials can be visited.');
  let tabId;
  try {
    if (url) ({ tabId } = await documentRequest({ action: 'open', url: url.href }));
    else await documentRequest({ action: 'watch' });
    guard();
    // Keep NetAcad's click handlers, but let the extension own the document tab.
    const preventNavigation = event => { if (url) event.preventDefault(); };
    link.addEventListener('click', preventNavigation, true);
    try {
      link.focus({ preventScroll: true });
      link.click();
    } finally { link.removeEventListener('click', preventNavigation, true); }
    await waitFor(async () => {
      guard();
      const state = await documentRequest({ action: 'state', tabId });
      return state.loaded;
    }, signal, url ? 'The document did not finish loading. Open it manually.'
      : 'The document did not open a readable PDF tab. Check Chrome’s popup indicator.');
    await delay(pace, signal);
  } finally {
    if (!url || Number.isInteger(tabId))
      await documentRequest({ action: 'close', tabId });
  }
  guard();
};

const walkTopic = async (topic, currentTopic, controls, controller, pace, solve, status, options) => {
  const { signal } = controller;
  const doc = await waitFor(() => topicDocument(topic), signal,
    'The topic did not load in a readable course frame.');
  const title = doc.title;
  const frame = doc.defaultView.frameElement;
  const guard = () => {
    if (!controls.isConnected || doc.title !== title || (frame && frame.contentDocument !== doc))
      controller.abort('Course navigation changed. Start the checklist again.');
    if (!globalThis.chrome?.runtime?.id)
      controller.abort('Reload the extension and refresh NetAcad, then start again.');
    signal.throwIfAborted();
  };
  await waitFor(() => {
    guard();
    return complete(currentTopic()) || deepHtmlSearchAll(doc, '.js-heading').length;
  }, signal, 'This topic has no supported reading/activity headings.');

  const visited = new Set();
  const steps = new Map();
  const animationSteps = new WeakMap();
  const nativePlayers = new WeakSet();
  const scrolled = new Set();
  const attempted = new Set();
  const errors = new Map();
  const documents = new Set();
  const fallbackIds = new WeakMap();
  let nextActivityId = 0;
  const activityKey = element => {
    const nativeId = element.id || String(element.className).match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i)?.[0];
    if (nativeId) return nativeId;
    if (!fallbackIds.has(element)) fallbackIds.set(element, `component:${nextActivityId++}`);
    return fallbackIds.get(element);
  };
  let pass = 1;
  let activeKey;
  let lastProgress = '';
  let idleDeadline = performance.now() + 30000;
  const advance = () => { idleDeadline = performance.now() + 30000; };
  const actions = '[role="tab"], summary, [aria-expanded="false"], [aria-controls], '
    + '[class*="reveal" i], [class*="hotspot" i], [class*="hotgraphic"] button, [class*="flipcard" i]';
  const buttons = 'button, [role="button"], [role="tab"], summary, a[href^="#"], input[type="button"]';
  const dialogs = 'dialog[open], [role="dialog"], .notify__popup';

  while (true) {
    guard();
    // ponytail: 1,000 changing controls per topic; raise for a known longer activity.
    if (visited.size > 1000) throw new Error('This activity keeps changing. Finish it manually.');
    if (complete(currentTopic())) return;
    if (!currentTopic()) {
      controller.abort('The course outline changed. Choose chapters again.');
      signal.throwIfAborted();
    }
    const nodes = deepHtmlSearchAll(doc, '*');
    const headings = nodes.filter(element => element.matches('.js-heading'));
    const finished = headings.filter(heading => heading.classList.contains('is-complete')).length;
    const progress = `${finished}/${headings.length}:${nodes.filter(element => element.matches('.component.is-complete')).length}`;
    if (progress !== lastProgress) { lastProgress = progress; advance(); }
    const counts = [...text(currentTopic().button).matchAll(/(\d+)\s*\/\s*(\d+)/g)].pop();
    status(`${topic.title} — ${counts ? `${counts[1]}/${counts[2]}` : `${finished}/${headings.length}`} sections checked`);

    const activities = nodes.filter(element => element.matches(ACTIVITY_SELECTOR)
      && activityFor(element) === element);
    const pending = (activities.length ? activities : [doc.body]).map(element => ({
      element,
      // Identical prose can occur in separate sections; text is not an identity.
      key: activityKey(element),
    })).filter(({ element }) => rendered(element) && (!element.classList.contains('is-complete')
      || findAssessmentStart(element, topic.title)));
    const current = pending.find(item => !attempted.has(item.key));
    if (!current) {
      // Give native progress time to settle, then revisit only unfinished content once.
      try {
        await waitFor(() => { guard(); return complete(currentTopic()); }, signal, '', pass === 1 ? 1000 : 3000);
        return;
      } catch (error) { guard(); }
      if (pass === 1) {
        pass++;
        attempted.clear();
        scrolled.clear();
        visited.clear();
        steps.clear();
        activeKey = undefined;
        status(`${topic.title} — rechecking unfinished sections`);
        continue;
      }
      const details = [...errors.values(), ...headings.filter(element => !element.classList.contains('is-complete')).map(text)];
      throw new Error(`NetAcad has not confirmed completion after two passes.${details.length ? ` Pending: ${[...new Set(details)].slice(0, 6).join('; ')}` : ' An activity needs attention.'}`);
    }
    const scope = current.element;
    const scopeNodes = deepHtmlSearchAll(scope, '*');
    const lab = isLab(scope, topic.title);
    const animation = scopeNodes.some(element => element.matches('aa-scrubber'))
      || scope.matches('.animation, [data-component="animation"], [class*="animation__" i]')
      || /\banimations?\b/i.test(`${topic.title} ${text(scopeNodes.find(element => element.matches('.js-heading, h1, h2')))}`);
    for (const player of scopeNodes.filter(element => element.matches('play-pause'))) {
      if (nativePlayers.has(player)) continue;
      nativePlayers.add(player);
      signal.addEventListener('abort', () => {
        if (player.paused === false) player.shadowRoot?.querySelector('button')?.click();
      }, { once: true });
    }
    const handsOn = lab && scopeNodes.some(element => rendered(element) && element.matches(
      'textarea, select, input:not([type="hidden"]):not([type="button"]):not([type="range"]), [draggable="true"], [contenteditable="true"]'));
    const step = `${pass}:${steps.get(current.key) || 0}`;
    const state = () => deepHtmlSearchAll(scope, '*').filter(rendered).map(element =>
      `${element.childElementCount ? '' : text(element)}:${element.getAttribute('aria-current') || ''}:${element.getAttribute('aria-selected') || ''}:${element.getAttribute('data-step') || ''}`).join('|');
    const eligible = element => rendered(element) && !element.matches(':disabled, [aria-disabled="true"]')
      && !assessmentControl(element)
      && !(element.tagName === 'A' && !element.getAttribute('href')?.startsWith('#'))
      && !/\b(submit|reset|restart|retry|previous|back|close|download|file_download|finish)\b|check\s+answers?|transcript|closed captions|subtitles|playback speed|full.?screen/i.test(`${label(element)} ${text(element)}`);
    const controlKey = element => {
      const path = [];
      for (let node = element; node && node !== scope; node = parentElement(node)) {
        path.push(node.id ? `${node.tagName}#${node.id}`
          : `${node.tagName}:${Array.prototype.indexOf.call(node.parentNode?.children || [], node)}`);
      }
      const phase = (lab || animation) && /^(start|begin|open|launch|next|continue|play|skip|end)\b/i.test(label(element)) ? label(element) : '';
      return `${current.key}/${step}/${path.join('/')}/${phase}`;
    };
    if (activeKey !== current.key) { activeKey = current.key; advance(); }
    try {
      if (performance.now() >= idleDeadline) throw new Error('This section stopped making progress.');
      if (!scrolled.has(current.key)) {
        await readContent(scope, signal, pace, guard);
        scrolled.add(current.key);
        continue;
      }

    if (findAssessmentStart(scope, topic.title))
      throw new Error('Start this self-check yourself, then use Select answers. The checklist did not start it.');
    if (scopeNodes.some(element => rendered(element) && !element.childElementCount && /\d+\s*of\s*\d+\s*questions?/i.test(text(element))))
      throw new Error('An assessment is open. Complete it manually; the checklist did not submit it.');
    if (scopeNodes.some(element => rendered(element) && element.matches('.js-heading, h1, h2')
      && /\b(quiz|exam|graded assessment|graded lab)\b/i.test(text(element)) && !/check your understanding/i.test(text(element))))
      throw new Error('A graded activity needs manual review; the checklist did not submit it.');

    // Video.js inserts its <video> only after the poster's Play control is clicked.
    const play = scopeNodes.find(element => element.matches('button, [role="button"]') && !visited.has(controlKey(element))
      && eligible(element) && (element.matches('button.vjs-big-play-button')
        || animation && (/^play(\s+(the\s+)?animation)?$/i.test(label(element))
          || element.getRootNode().host?.matches('play-pause') && element.getRootNode().host.paused === true)));
    if (play) {
      visited.add(controlKey(play));
      await scrollTo(play, 'center', signal, pace);
      guard();
      play.click();
      try {
        if (play.matches('button.vjs-big-play-button')) await waitFor(() => {
          guard();
          return deepHtmlSearchAll(scope, 'video').some(rendered);
        }, signal, 'This video player did not expose a supported video. Play it manually.');
        advance();
        await delay(pace, signal);
      } finally {
        if (signal.aborted && animation)
          for (const item of deepHtmlSearchAll(scope, '*').flatMap(element => element.getAnimations?.() || []))
            if (item.playState === 'running') item.pause();
      }
      continue;
    }
    const video = scopeNodes.find(element => element.matches('video') && !visited.has(controlKey(element)) && !element.ended && rendered(element));
    if (video) {
      const skipVideo = animation ? options.skipAnimations : options.skipVideos;
      visited.add(controlKey(video));
      const muted = video.muted;
      const paused = video.paused;
      const loop = video.loop;
      let playbackError;
      try {
        await scrollTo(video, 'center', signal, pace);
        video.muted = true;
        video.loop = false;
        status(`${topic.title} — ${skipVideo ? 'skipping to the end of' : 'playing'} video`);
        video.play()?.catch(error => { playbackError = error; });
        if (skipVideo) {
          await waitFor(() => {
            guard();
            if (playbackError || video.error) throw new Error('The video could not play. Open it manually.');
            return video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0;
          }, signal, 'The video metadata did not load. Open the video manually, then restart.');
          video.currentTime = Math.max(0, video.duration - 0.25);
        }
        // Play the tail normally: never fabricate ended events or saved progress.
        const duration = Number.isFinite(video.duration) ? video.duration : 300;
        await waitFor(() => {
          guard();
          if (playbackError || video.error) throw new Error('The video could not play. Open it manually, then restart.');
          return video.ended;
        }, signal, 'Video playback did not finish. The player may require full playback.', skipVideo
          ? 15000 : Math.min(1800000, Math.max(60000, duration * 1000 + 15000)));
      } finally {
        if (paused) video.pause();
        video.muted = muted;
        video.loop = loop;
      }
      advance();
      continue;
    }

    const timeline = animation && scopeNodes.find(element =>
      element.matches('input[type="range"], [role="slider"]') && eligible(element) && !visited.has(controlKey(element))
        && (options.skipAnimations || element.getRootNode().host?.matches('aa-scrubber'))
        && (/seek|timeline|progress|scrub|playhead|position/i.test(`${label(element)} ${text(element.labels?.[0])} ${element.id} ${element.className}`)
          || element.getRootNode().host?.matches('aa-scrubber'))
        && !/volume|speed|zoom/i.test(`${label(element)} ${text(element.labels?.[0])}`));
    if (timeline) {
      visited.add(controlKey(timeline));
      await scrollTo(timeline, 'center', signal, pace);
      guard();
      status(`${topic.title} — ${options.skipAnimations ? 'skipping to the end of' : 'playing'} animation`);
      const view = timeline.ownerDocument.defaultView;
      if (!options.skipAnimations) {
        await waitFor(() => {
          guard();
          return !scope.isConnected || scope.classList.contains('is-complete') || Number(timeline.value) >= Number(timeline.max || 100);
        }, signal, 'Animation playback did not finish. Open it manually.', 1800000);
      } else if (timeline.matches('input[type="range"]')) {
        Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value').set.call(timeline, timeline.max || '100');
        timeline.dispatchEvent(new view.Event('input', { bubbles: true }));
        timeline.dispatchEvent(new view.Event('change', { bubbles: true }));
        // Adobe Animate commits scrubbing on click, not input/change.
        if (timeline.getRootNode().host?.matches('aa-scrubber')) timeline.click();
      } else {
        timeline.focus();
        for (const type of ['keydown', 'keyup'])
          timeline.dispatchEvent(new view.KeyboardEvent(type, { key: 'End', code: 'End', keyCode: 35, which: 35, bubbles: true }));
      }
      await delay(pace, signal);
      advance();
      continue;
    }

    const nativeAnimations = animation ? [...new Set(scopeNodes.filter(rendered).flatMap(element => element.getAnimations?.() || []))]
      .filter(item => item.playState !== 'finished' && item.playState !== 'idle' && item.playbackRate !== 0
        && Number.isFinite(item.effect?.getComputedTiming().endTime) && animationSteps.get(item) !== step) : [];
    if (nativeAnimations.length) {
      for (const item of nativeAnimations) { visited.add(item); animationSteps.set(item, step); }
      status(`${topic.title} — ${options.skipAnimations ? 'skipping to the end of' : 'playing'} animation`);
      try {
        if (options.skipAnimations) nativeAnimations.forEach(item => item.finish());
        else {
          nativeAnimations.forEach(item => item.play());
          const duration = Math.max(...nativeAnimations.map(item => item.effect.getComputedTiming().endTime / Math.abs(item.playbackRate)));
          await waitFor(() => {
            guard();
            return !scope.isConnected || nativeAnimations.every(item => item.playState === 'finished' || item.playState === 'idle');
          }, signal, 'Animation playback did not finish. Open it manually.', Math.min(1800000, duration + 15000));
        }
      } finally {
        if (signal.aborted) nativeAnimations.forEach(item => item.pause());
      }
      await delay(pace, signal);
      guard();
      if (scope.isConnected) await readContent(scope, signal, pace, guard);
      advance();
      continue;
    }

    const link = options.visitDocuments && deepHtmlSearchAll(scope, 'a[href], button, [role="button"]').find(element =>
      (element.matches('a[href]') ? isDocumentLink(element) : isDocumentButton(element))
      && !element.disabled && element.getAttribute('aria-disabled') !== 'true'
      && rendered(element) && !documents.has(element.href || controlKey(element))
      && element.getAttribute('aria-disabled') !== 'true');
    if (link) {
      documents.add(link.href || controlKey(link));
      await scrollTo(link, 'center', signal, pace);
      guard();
      status(`${topic.title} — opening ${text(link) || 'document'}`);
      await visitDocument(link, signal, pace, guard);
      status(`${topic.title} — returned to the course; checking completion`);
      advance();
      continue;
    }

    const candidates = scopeNodes.filter(element => element.matches(buttons) && !visited.has(controlKey(element)) && eligible(element)
      && ((element.matches(actions) || /^reveal\b|^show\s+(the\s+)?(answers?|solutions?|explanations?|hints?|feedback|more|details)\b/i.test(label(element)))
        && !scope.matches('.media, .video, [class*="transcript"]') && !element.closest('.video-js, [class*="transcript"]')
        && !NEXT.test(label(element)) && !ANIMATION_END.test(label(element)) && !(lab && LAB_START.test(label(element)))
        || !handsOn && (lab && LAB_START.test(label(element)) || (lab || animation) && NEXT.test(label(element)))
        || animation && !handsOn && options.skipAnimations && ANIMATION_END.test(label(element))));
    // Reveal each task before moving on, even when Next appears first in the DOM.
    const action = candidates.find(element => !NEXT.test(label(element))) || candidates[0];
    if (action) {
      visited.add(controlKey(action));
      const forward = NEXT.test(label(action));
      const before = forward ? state() : null;
      const openDialogs = new Set(deepHtmlSearchAll(doc, dialogs).filter(rendered));
      await scrollTo(action, 'center', signal, pace);
      guard();
      if (!(action.tagName === 'SUMMARY' && action.parentElement.open)
        && action.getAttribute('aria-expanded') !== 'true' && action.getAttribute('aria-selected') !== 'true') {
        action.click();
        advance();
      }
      await delay(pace, signal);
      guard();
      if (forward) {
        await waitFor(() => { guard(); return !scope.isConnected || complete(currentTopic()) || state() !== before; },
          signal, 'This step did not advance. Complete the remaining task manually.', 5000);
        steps.set(current.key, (steps.get(current.key) || 0) + 1);
      }
      const popup = deepHtmlSearchAll(doc, dialogs).find(element => rendered(element) && !openDialogs.has(element));
      const revealed = action.getRootNode().getElementById?.(action.getAttribute('aria-controls'))
        || (action.tagName === 'SUMMARY' ? action.parentElement : null)
        || popup
        || deepHtmlSearchAll(scope, '[role="tabpanel"], [role="region"]').find(rendered);
      if (revealed?.isConnected && rendered(revealed)) await readContent(revealed, signal, pace, guard);
      else if (scope.isConnected) await readContent(scope, signal, pace, guard);
      if (popup?.isConnected && rendered(popup)) {
        const close = deepHtmlSearchAll(popup, 'button, [role="button"]').find(element => rendered(element)
          && !element.matches(':disabled, [aria-disabled="true"]')
          && (/^close\b/i.test(label(element)) || element.matches('.notify__close-btn, .js-notify-close-btn')));
        guard();
        if (close) close.click();
        else if (popup.tagName === 'DIALOG') popup.close();
        else throw new Error('Close this reveal popup manually, then restart the checklist.');
        await delay(pace, signal);
      }
      continue;
    }

    if (lab) throw new Error('Remaining lab tasks need manual review; no lab answers were entered or submitted.');
    await solve(doc, signal, scope);
    guard();
    if (!scope.isConnected) continue;
    attempted.add(current.key);
    } catch (error) {
      guard();
      errors.set(current.key, error.message);
      attempted.add(current.key);
    }
  }
};

export const mountChapterChecklist = (controls, solve, updateControls) => {
  activeRun?.abort('Controls reloaded. Start the checklist again.');
  const panel = document.createElement('details');
  panel.className = 'solver-checklist';
  panel.innerHTML = `
    <style>
      #netacad-solver-controls .solver-checklist { border-top: 1px solid #e3e7e9; }
      #netacad-solver-controls .solver-checklist > summary { padding: 14px 18px; cursor: pointer; font-weight: 600; }
      #netacad-solver-controls .solver-checklist > summary::marker { color: #4c8a31; }
      #netacad-solver-controls .solver-checklist-body { padding: 0 18px 16px; }
      #netacad-solver-controls .solver-checklist p { margin: 0 0 10px; color: #59636b; font-size: 12px; }
      #netacad-solver-controls .solver-chapters { display: grid; max-height: 160px; overflow: auto; margin: 8px 0; padding: 0; border: 0; }
      #netacad-solver-controls .solver-chapters legend { font-size: 12px; margin-bottom: 4px; }
      #netacad-solver-controls .solver-chapters label { display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 4px; cursor: pointer; }
      #netacad-solver-controls .solver-chapters label:has(input:checked) { background: #eef7e9; }
      #netacad-solver-controls .solver-chapters input, #netacad-solver-controls .solver-checklist-options input { appearance: auto; flex: 0 0 16px; width: 16px; height: 16px; accent-color: #4c8a31; }
      #netacad-solver-controls .solver-checklist-options { border: 0; margin: 8px 0; padding: 0; }
      #netacad-solver-controls .solver-checklist-options label { display: flex; align-items: center; gap: 8px; min-height: 30px; font-size: 12px; cursor: pointer; }
      #netacad-solver-controls .solver-checklist button { padding: 6px 10px; border: 1px solid #d4dadd; border-radius: 3px; background: #f7f9f9; text-align: center; }
      #netacad-solver-controls .solver-checklist button:disabled { opacity: .5; cursor: default; }
      #netacad-solver-controls .solver-checklist-actions { display: flex; gap: 8px; margin: 10px 0; }
      #netacad-solver-controls .solver-checklist-start { flex: 1; background: #6abf4b !important; color: #17320c; border-color: #579e39 !important; }
      #netacad-solver-controls .solver-checklist-pace { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 10px; font-size: 12px; }
      #netacad-solver-controls .solver-checklist-pace input { width: 64px; padding: 4px; border: 1px solid #a2adb5; border-radius: 3px; background: #fff; color: #273139; font: inherit; }
      #netacad-solver-controls .solver-checklist progress { width: 100%; height: 8px; accent-color: #4c8a31; }
      #netacad-solver-controls .solver-checklist-issues { max-height: 120px; overflow: auto; margin: 8px 0 0; padding-left: 18px; color: #8c5515; font-size: 12px; }
      #netacad-solver-controls .solver-checklist [hidden] { display: none !important; }
      #netacad-solver-controls .solver-checklist-running { display: none; padding: 2px 6px; color: #3d7825; background: #eef7e9; font-size: 10px; font-weight: 700; border-radius: 3px; }
      #netacad-solver-controls[data-checklist-running] .solver-checklist-running { display: inline; }
      #netacad-solver-controls[data-checklist-running] #netacad-solver-mode-badge { display: none; }
    </style>
      <summary>Chapter checklist</summary>
      <div class="solver-checklist-body">
      <p>Visits checked chapters, scrolls activities and submits supported self-checks.</p>
      <fieldset class="solver-chapters"><legend>Chapters in this course</legend></fieldset>
      <fieldset class="solver-checklist-options" aria-label="Automation options">
        <label><input type="checkbox" class="solver-skip-videos" checked>Skip to the end of videos</label>
        <label><input type="checkbox" class="solver-skip-animations" checked>Skip to the end of animations</label>
        <label><input type="checkbox" class="solver-visit-documents" checked>Open documents, then return to the course</label>
      </fieldset>
      <p>Documents open in a temporary tab. Only NetAcad's own indicators count as completed.</p>
      <label class="solver-checklist-pace">Step delay (seconds)<input type="number" min="0.1" max="10" step="0.1" value="0.2" required></label>
      <div class="solver-checklist-actions"><button type="button" class="solver-checklist-refresh">Refresh</button><button type="button" class="solver-checklist-start" disabled>Start chapters</button><button type="button" class="solver-checklist-stop" hidden>Stop</button></div>
      <progress value="0" max="1" aria-label="Verified topics"></progress>
      <p class="solver-checklist-status" role="status">Open the Course Outline, then refresh this list.</p>
      <ul class="solver-checklist-issues" aria-label="Topics needing attention" hidden></ul>
    </div>`;
  controls.querySelector('.solver-footer').before(panel);
  const badge = document.createElement('span');
  badge.className = 'solver-checklist-running';
  badge.textContent = 'RUNNING';
  badge.setAttribute('role', 'status');
  controls.querySelector('#netacad-solver-mode-badge').after(badge);
  const list = panel.querySelector('fieldset');
  const start = panel.querySelector('.solver-checklist-start');
  const stop = panel.querySelector('.solver-checklist-stop');
  const refresh = panel.querySelector('.solver-checklist-refresh');
  const paceInput = panel.querySelector('input[type="number"]');
  const optionsInput = panel.querySelector('.solver-checklist-options');
  const progress = panel.querySelector('progress');
  const issues = panel.querySelector('.solver-checklist-issues');
  const statusNode = panel.querySelector('[role="status"]');
  const status = message => { if (statusNode.textContent !== message) statusNode.textContent = message; };
  let running = false;
  const updateStart = () => { start.disabled = running || !list.querySelector('input:checked'); };
  const refreshList = () => {
    if (running) return;
    const selected = new Set([...list.querySelectorAll('input:checked')].map(input => input.value));
    list.querySelectorAll('label').forEach(label => label.remove());
    const chapters = readOutline();
    for (const chapter of chapters) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = chapter.number;
      input.checked = selected.has(chapter.number);
      const name = document.createElement('span');
      name.textContent = chapter.title;
      label.append(input, name);
      list.append(label);
    }
    status(chapters.length ? 'Select chapters, then start. Already completed topics are skipped.'
      : 'Open a course and its Course Outline, then refresh this list.');
    updateStart();
  };
  panel.addEventListener('toggle', () => { if (panel.open && !running) refreshList(); });
  list.addEventListener('change', updateStart);
  refresh.addEventListener('click', refreshList);
  stop.addEventListener('click', () => activeRun?.abort('Stopped. Completed topics will be skipped next time.'));
  start.addEventListener('click', async () => {
    if (running || !paceInput.reportValidity()) return;
    const pace = Number(paceInput.value) * 1000;
    if (!Number.isFinite(pace) || pace < 100 || pace > 10000) return;
    const selected = new Set([...list.querySelectorAll('input:checked')].map(input => input.value));
    const chapters = readOutline().filter(chapter => selected.has(chapter.number));
    if (!chapters.length) { refreshList(); return; }
    if (controls.dataset.mode !== 'safe') {
      status('Switch to Easy mode before starting the checklist, so Brutal cannot keep submitting after it stops.');
      return;
    }
    const controller = new AbortController();
    activeRun = controller;
    controls.dataset.checklistRunning = 'true';
    const { signal } = controller;
    running = true;
    list.disabled = refresh.disabled = paceInput.disabled = optionsInput.disabled = true;
    const options = {
      skipVideos: panel.querySelector('.solver-skip-videos').checked,
      skipAnimations: panel.querySelector('.solver-skip-animations').checked,
      visitDocuments: panel.querySelector('.solver-visit-documents').checked,
    };
    stop.hidden = false;
    issues.replaceChildren();
    issues.hidden = true;
    progress.value = 0;
    progress.max = 1;
    updateStart();
    let verified = 0;
    let total = 0;
    try {
      updateControls();
      for (const chapter of chapters) {
        signal.throwIfAborted();
        const currentChapter = () => readOutline().find(item => item.number === chapter.number && item.title === chapter.title);
        const header = currentChapter()?.button;
        if (!header) throw new Error('The course outline changed. Refresh the chapter list.');
        if (header.getAttribute('aria-expanded') === 'false') header.click();
        const topics = await waitFor(() => {
          const items = currentChapter()?.topics;
          return items?.length ? items : null;
        }, signal, `${chapter.title}: no topics appeared.`);
        total += topics.length;
        progress.max = total;
        for (const topic of topics) {
          signal.throwIfAborted();
          const currentTopic = () => currentChapter()?.topics.find(item => item.key === topic.key);
          try {
            let current = currentTopic();
            if (!current) throw new Error('Topic is no longer in the course outline.');
            if (!complete(current)) {
              if (current.locked) throw new Error('Prerequisites have not been completed.');
              if (/\b(quiz|exam|test|assessment|graded|packet tracer|survey|project)\b/i.test(topic.title))
                throw new Error('This activity needs manual review; it was not opened or submitted.');
              status(`Opening ${topic.title}…`);
              current = await waitFor(() => {
                const item = currentTopic();
                return item && rendered(item.button) ? item : null;
              }, signal, 'The topic is not available in the expanded outline.');
              current.button.click();
              await walkTopic(topic, currentTopic, controls, controller, pace, solve, status, options);
            }
            if (!complete(currentTopic())) throw new Error('Completion has not been confirmed by NetAcad.');
            const openDoc = topicDocument(topic);
            const graded = openDoc && deepHtmlSearchAll(openDoc, '.js-heading').filter(element =>
              !element.classList.contains('is-complete') && /\b(quiz|exam|graded assessment|graded lab)\b/i.test(text(element))
                && !/check your understanding/i.test(text(element)));
            if (graded?.length)
              throw new Error(`Reading completed; remaining graded activity needs manual review: ${graded.map(text).join('; ')}`);
            progress.value = ++verified;
          } catch (error) {
            if (signal.aborted) throw error;
            const item = document.createElement('li');
            item.textContent = `${topic.title}: ${error.message}`;
            issues.append(item);
            issues.hidden = false;
          }
        }
      }
      status(`${verified}/${total} topics verified${issues.children.length ? ` · ${issues.children.length} need attention` : ' · complete'}.`);
    } catch (error) {
      status(signal.aborted ? String(signal.reason) : error.message);
    } finally {
      running = false;
      list.disabled = refresh.disabled = paceInput.disabled = optionsInput.disabled = false;
      stop.hidden = true;
      if (activeRun === controller) activeRun = null;
      delete controls.dataset.checklistRunning;
      updateControls();
      updateStart();
    }
  });
};
