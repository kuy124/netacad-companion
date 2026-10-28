// The background handler must never close a tab it did not open for this course.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const id = 'test-extension-id';
const handlers = [];
const removed = [];
const opened = [];
const focused = [];
const tabs = new Map([
  [1, { id: 1, url: 'https://www.netacad.com/course/12', windowId: 1 }],
  [2, { id: 2, url: 'https://www.netacad.com/manual.pdf', openerTabId: 1 }],
]);
const onRemoved = [];
const onUpdated = [];
const onCreated = [];
let nextId = 10;
const browserTabs = {
  onRemoved: { addListener(fn) { onRemoved.push(fn); } },
  onUpdated: { addListener(fn) { onUpdated.push(fn); } },
  onCreated: { addListener(fn) { onCreated.push(fn); } },
  async create(options) {
    opened.push(options);
    const tab = { ...options, id: nextId++, status: 'loading' };
    tabs.set(tab.id, tab);
    return tab;
  },
  async get(tabId) {
    if (!tabs.has(tabId)) throw new Error('No such tab.');
    return tabs.get(tabId);
  },
  async remove(tabId) {
    assert(tabs.has(tabId));
    removed.push(tabId);
    tabs.delete(tabId);
    onRemoved.forEach(fn => fn(tabId));
  },
  async update(tabId, options) {
    assert(tabs.has(tabId));
    if (options.active) focused.push(tabId);
  },
};
const chrome = {
  runtime: { id, onMessage: { addListener(fn) { handlers.push(fn); } } },
  webRequest: { onSendHeaders: { addListener() {} } },
  commands: { onCommand: { addListener() {} } },
};
vm.runInNewContext(fs.readFileSync(new URL('../dist/background.js', import.meta.url), 'utf8'), {
  chrome, browser: { runtime: { id }, tabs: browserTabs }, URL, console,
});
const sender = { id, tab: tabs.get(1), frameId: 0 };
const request = (data, from = sender) => new Promise(resolve => {
  handlers.forEach(fn => fn({ type: 'netacad-solver-document', ...data }, from,
    response => resolve(JSON.parse(JSON.stringify(response)))));
});

for (const url of ['javascript:alert(1)', 'data:text/plain,hello', 'http://www.netacad.com/a.pdf', 'https://user:pass@www.netacad.com/a.pdf']) {
  assert((await request({ action: 'open', url })).error);
}
assert((await request({ action: 'open', url: 'https://www.netacad.com/a.pdf' }, { ...sender, frameId: 1 })).error);
assert((await request({ action: 'open', url: 'https://www.netacad.com/a.pdf' }, {
  ...sender, tab: { ...sender.tab, url: 'https://netacad.com.attacker.example/' },
})).error);
assert.equal(opened.length, 0);

const { tabId } = await request({ action: 'open', url: 'https://www.netacad.com/a.pdf' });
assert.equal(opened[0].openerTabId, 1);
assert.equal(opened[0].active, true);
assert.equal((await request({ action: 'state', tabId })).loaded, false);
tabs.get(tabId).status = 'complete';
assert.equal((await request({ action: 'state', tabId })).loaded, true);
assert((await request({ action: 'open', url: 'https://www.netacad.com/b.pdf' })).error);
assert((await request({ action: 'close', tabId }, { ...sender, tab: { ...sender.tab, id: 2 } })).error);
await request({ action: 'close', tabId: 2 });
assert(tabs.has(2));
assert((await request({ action: 'close', tabId })).closed);
assert.deepEqual(removed, [tabId]);
assert.deepEqual(focused, [1]);
await request({ action: 'close', tabId }); // Cleanup is safe to repeat.
assert((await request({ action: 'state', tabId })).error);

assert((await request({ action: 'watch' })).watching);
const unrelated = { id: 50, openerTabId: 2, url: 'https://www.netacad.com/unrelated.pdf', status: 'complete' };
tabs.set(unrelated.id, unrelated);
onCreated.forEach(fn => fn(unrelated));
assert.equal((await request({ action: 'state' })).loaded, false);
const native = { id: 51, openerTabId: 1, url: 'about:blank', status: 'loading' };
tabs.set(native.id, native);
onCreated.forEach(fn => fn(native));
assert.equal((await request({ action: 'state' })).loaded, false);
Object.assign(native, { url: 'https://www.netacad.com/native.pdf', status: 'complete' });
onUpdated.forEach(fn => fn(native.id, { url: native.url }, native));
assert.equal((await request({ action: 'state' })).tabId, native.id);
assert.equal((await request({ action: 'state' })).loaded, true);
await request({ action: 'close' });
assert(!tabs.has(native.id));
assert(tabs.has(unrelated.id));
tabs.delete(unrelated.id);
await request({ action: 'watch' });
await request({ action: 'close' });
onCreated.forEach(fn => fn({ ...native, id: 52 }));
assert.equal((await request({ action: 'state' })).loaded, false);

const second = await request({ action: 'open', url: 'https://www.netacad.com/b.pdf' });
onUpdated.forEach(fn => fn(1, { url: 'https://www.netacad.com/other-course' }));
assert(!tabs.has(second.tabId));
const third = await request({ action: 'open', url: 'https://www.netacad.com/b.pdf' });
await browserTabs.remove(1);
assert(!tabs.has(third.tabId));
assert((await request({ action: 'open', url: 'https://www.netacad.com/b.pdf' })).error);
assert.equal(tabs.size, 1); // A late tab creation cannot leave an orphan behind.
assert(tabs.has(2));
console.log('Document tab checks passed: load, return, ownership, cancellation and URL validation.');
