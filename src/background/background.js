import browser from 'webextension-polyfill';

// Only temporary tabs created for a chapter run may be closed by the runner.
const documentTabs = new Map();
const documentLaunches = new Set();
const captureDocumentTab = tab => {
  if (documentLaunches.has(tab.openerTabId)
    && /^https:\/\/[^/]+\/.*\.(pdf|docx?|pptx?|xlsx?|od[tps]|rtf|txt)(?:[?#]|$)/i.test(tab.url || tab.pendingUrl || '')) {
    documentTabs.set(tab.id, tab.openerTabId);
    documentLaunches.delete(tab.openerTabId);
  }
};
browser.tabs.onCreated.addListener(captureDocumentTab);
const handleDocumentRequest = async (request, sender) => {
  const source = sender.tab;
  const origin = new URL(source?.url || 'about:blank');
  if (sender.id !== chrome.runtime.id || !Number.isInteger(source?.id) || sender.frameId !== 0 || origin.protocol !== 'https:'
    || !(origin.hostname === 'netacad.com' || origin.hostname.endsWith('.netacad.com')))
    throw new Error('Document visits must start from the main NetAcad course tab.');

  if (request.action === 'watch') {
    if (documentLaunches.has(source.id) || [...documentTabs.values()].includes(source.id))
      throw new Error('A document visit is already running in this course.');
    documentLaunches.add(source.id);
    return { watching: true };
  }
  if (['state', 'close'].includes(request.action) && request.tabId === undefined) {
    request.tabId = [...documentTabs].find(([, owner]) => owner === source.id)?.[0];
    if (request.action === 'close') documentLaunches.delete(source.id);
    if (request.action === 'state' && request.tabId === undefined) return { loaded: false };
  }
  if (request.action === 'open') {
    const url = new URL(request.url);
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('Only HTTPS document links without embedded credentials can be visited.');
    if (documentLaunches.has(source.id) || [...documentTabs.values()].includes(source.id))
      throw new Error('A document visit is already running in this course.');
    const tab = await browser.tabs.create({ url: url.href, active: true, openerTabId: source.id, windowId: source.windowId });
    documentTabs.set(tab.id, source.id);
    try { await browser.tabs.get(source.id); } catch (error) {
      documentTabs.delete(tab.id);
      await browser.tabs.remove(tab.id).catch(() => {});
      throw error;
    }
    return { tabId: tab.id };
  }

  if (request.action === 'close' && !documentTabs.has(request.tabId)) return { closed: true };
  if (documentTabs.get(request.tabId) !== source.id)
    throw new Error('The document tab was closed or does not belong to this course.');
  if (request.action === 'state') {
    const tab = await browser.tabs.get(request.tabId);
    return { tabId: tab.id, loaded: tab.status === 'complete' };
  }
  if (request.action === 'close') {
    documentTabs.delete(request.tabId);
    await browser.tabs.remove(request.tabId);
    await browser.tabs.update(source.id, { active: true }).catch(() => {});
    return { closed: true };
  }
  throw new Error('Unknown document action.');
};

const closeCourseDocuments = tabId => {
  documentLaunches.delete(tabId);
  for (const [documentId, sourceId] of documentTabs) {
    if (sourceId === tabId) {
      documentTabs.delete(documentId);
      void browser.tabs.remove(documentId).catch(() => {});
    }
  }
};
browser.tabs.onRemoved.addListener(tabId => {
  documentTabs.delete(tabId);
  closeCourseDocuments(tabId);
});
browser.tabs.onUpdated.addListener((tabId, changes, tab) => {
  if (changes.url) closeCourseDocuments(tabId);
  if (tab) captureDocumentTab(tab);
});

const isInternalRequest = (details) => {
  return details.initiator &&
    (details.initiator.startsWith('chrome-extension://') || details.initiator.startsWith('moz-extension://'));
};

const sendMessage = (message) => {
  chrome.tabs.query({url: ['https://*.netacad.com/*']}, tabs => {
    tabs.forEach(tab => {
      if (!tab.id)
        return;

      chrome.tabs.sendMessage(tab.id, message, () => {
        void chrome.runtime.lastError;
      });
    });
  });
};

// catches component URLs
chrome.webRequest.onSendHeaders.addListener((details) => {
    if (isInternalRequest(details))
      return;

    sendMessage({componentsUrl: details.url});
  },
  {
    urls: ['https://*.netacad.com/*/components.json*']
  }
);

// get message with final exam url form catcher.js and save it to local storage
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'netacad-solver-document') {
    void handleDocumentRequest(message, sender).then(sendResponse, error => sendResponse({ error: error.message }));
    return true;
  }
  if (sender.id === chrome.runtime.id && message.type === 'netacad-solver-interceptor') {
    sendMessage({componentsUrl: message.url});

    const name = `service-${message.serviceId}`;

    chrome.storage.local.get(name, result => {
      const obj = result[name] || [];

      if (!obj.includes(message.url))
        chrome.storage.local.set({[name]: [...obj, message.url]});
    });
  }
});

chrome.commands.onCommand.addListener(command => {
  if (command !== 'solve-current-question' && command !== 'toggle-highlights')
    return;

  chrome.tabs.query({active: true, lastFocusedWindow: true}, tabs => {
    const tab = tabs[0];

    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, {type: command}, () => {
        void chrome.runtime.lastError;
      });
    }
  });
});
