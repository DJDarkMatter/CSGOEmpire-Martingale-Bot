'use strict';
importScripts('core.js');
const Core = RouletteCore;
const ACTIONS = new Set(['getState', 'saveConfig', 'saveSettings', 'stopBot', 'resetSession', 'saveSelector', 'hello', 'observe', 'betAck', 'pageError', 'pageUnavailable', 'reloadPage', 'recoverPage', 'checkpoint']);
let queue = Promise.resolve();

async function readState() {
  const data = await chrome.storage.local.get(['config', 'session', 'revision']);
  let config;
  try { config = Core.settings(data.config || {}); }
  catch { config = Core.settings(); }
  return { config, session: data.session || null, revision: Number.isSafeInteger(data.revision) ? data.revision : 0 };
}
async function writeState(state) {
  state.revision++;
  await chrome.storage.local.set(state);
}
function isSite(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ['csgoempire.com', 'www.csgoempire.com'].includes(parsed.hostname);
  } catch { return false; }
}
function requireController(request, sender) {
  if (!sender.tab && sender.url === chrome.runtime.getURL('popup.html')) return null;
  if (!sender.tab || !isSite(sender.url || sender.tab.url) || sender.frameId !== 0 ||
      typeof request.documentId !== 'string' || !request.documentId ||
      (request.tabId !== undefined && request.tabId !== sender.tab.id)) {
    throw new Error('This action must come from the extension popup or the top bar on CSGOEmpire.');
  }
  return sender.tab.id;
}
function requireSessionController(state, request, sender) {
  const tabId = requireController(request, sender);
  if (tabId !== null && state.session && state.session.tabId !== tabId) {
    throw new Error('This session belongs to another tab. Use that tab or the extension popup.');
  }
}
function requireOwner(state, request, sender) {
  if (!sender.tab || !isSite(sender.url || sender.tab.url) || sender.frameId !== 0 ||
      !state.session || sender.tab.id !== state.session.tabId ||
      request.documentId !== state.session.documentId || request.sessionId !== state.session.id) {
    throw new Error('This page does not own the current session.');
  }
}
function prepareReload(session, review = false) {
  if (review && session.pending?.status === 'submitted' && !session.userStopped) {
    if (session.reviewReloaded) return null;
    session.reviewReloaded = true;
    session.needsReview = true;
    session.recovery = null;
    Core.pause(session, 'Roulette reloading — bet click was not confirmed. Check that outstanding bet before resetting.');
    return session.tabId;
  }
  if (!session.active || session.userStopped || !session.recovery || session.pending?.status === 'submitted') return null;
  if (session.recovery.reloads >= 1) return null;
  session.recovery.reloads++;
  session.status = 'Loading — reloading roulette; the saved betting session will be checked on return.';
  return session.tabId;
}
async function handle(request, sender) {
  const state = await readState();
  let instruction = null;
  let reloadTab = null;
  switch (request.action) {
    case 'getState':
      return { success: true, ...state, controllerTabId: sender.tab?.id ?? null };
    case 'saveConfig': {
      const controllerTabId = requireController(request, sender);
      if (state.session?.pending) throw new Error('An outstanding bet must finish, or be reviewed and cleared with Reset session.');
      if (state.session?.active) throw new Error('Stop the running session before starting a new one.');
      const config = Core.settings(request.settings);
      const tab = await chrome.tabs.get(controllerTabId ?? request.tabId);
      if (!isSite(tab.url)) throw new Error('Open CSGOEmpire roulette and start from that tab.');
      let page;
      const historyDirection = state.config.selectors.history === config.selectors.history ? state.session?.historyDirection : null;
      try { page = await chrome.tabs.sendMessage(tab.id, { action: 'inspect', config, historyDirection }); }
      catch { throw new Error('Refresh the roulette tab after loading/reloading the extension.'); }
      if (!page?.success || !page.ready) throw new Error(page?.error || 'Page setup is incomplete. Use Check page.');
      if (page.documentId !== request.documentId) throw new Error('The page changed; refresh it and try again.');
      state.config = config;
      state.session = Core.create(config, tab.id, page.documentId, crypto.randomUUID(), page.initialHistory || [], page.historyDirection || null);
      state.session.pageUrl = tab.url;
      if (page.checkpoint) Core.checkpoint(state.session, page.checkpoint);
      if (page.phase === 'closed' || page.phase === 'waiting') {
        state.session.status = `${config.dryRun ? 'Simulation armed' : 'Running'} — waiting for the current roll to finish and betting to reopen.`;
      }
      break;
    }
    case 'saveSettings':
      requireController(request, sender);
      if (state.session?.active || state.session?.pending) throw new Error('Stop and resolve the current session before changing settings.');
      state.config = Core.settings(request.settings);
      break;
    case 'stopBot':
      requireSessionController(state, request, sender);
      if (state.session) Core.stop(state.session);
      break;
    case 'resetSession':
      requireSessionController(state, request, sender);
      if (state.session?.active) throw new Error('Stop the bot before resetting it.');
      state.session = null;
      break;
    case 'saveSelector': {
      if (!sender.tab || !isSite(sender.url || sender.tab.url) || sender.frameId !== 0) throw new Error('Invalid selector source.');
      if (state.session?.active || state.session?.pending) throw new Error('Stop and resolve the current session before changing page setup.');
      if (!Object.hasOwn(Core.DEFAULTS.selectors, request.key)) throw new Error('Unknown page selector.');
      state.config = Core.settings({ ...state.config, selectors: { ...state.config.selectors, [request.key]: request.selector } });
      break;
    }
    case 'hello':
      if (sender.tab && sender.frameId === 0 && isSite(sender.url || sender.tab.url) &&
          state.session?.tabId === sender.tab.id && state.session.documentId !== request.documentId) {
        if (state.session.needsReview && (!state.session.pageUrl || state.session.pageUrl === (sender.url || sender.tab.url))) {
          state.session.documentId = request.documentId;
        } else if (state.session.active && (state.session.checkpoint?.history?.length || state.session.lastOpenKey === null) &&
            (!state.session.pageUrl || state.session.pageUrl === (sender.url || sender.tab.url))) {
          state.session.documentId = request.documentId;
          Core.loading(state.session, 'Page reloaded — reconciling saved bets and recent results.');
        } else Core.pause(state.session, 'Page reloaded — session paused. Check any outstanding bet before resetting.');
      }
      break;
    case 'observe':
      requireOwner(state, request, sender);
      if (state.session.active || state.session.pending) {
        instruction = Core.observe(state.session, request.observation, () => crypto.randomUUID());
        if (!state.session.recovery && (state.session.lastOpenKey === request.observation?.openKey ||
            request.observation?.phase === 'closed')) {
          Core.checkpoint(state.session, request.observation?.checkpoint);
        }
      }
      break;
    case 'checkpoint':
      requireOwner(state, request, sender);
      if (state.session.active && !state.session.recovery && request.openKey === state.session.lastOpenKey) {
        Core.checkpoint(state.session, request.checkpoint);
      }
      break;
    case 'pageUnavailable':
      requireOwner(state, request, sender);
      if (!state.session.active || state.session.userStopped) break;
      if (request.notClickedBetId && request.notClickedBetId === state.session.pending?.id &&
          ['reserved', 'submitted'].includes(state.session.pending.status)) {
        Core.acknowledge(state.session, request.notClickedBetId, 'deferred', request.error);
      }
      Core.loading(state.session, request.error);
      if (request.reload === true) reloadTab = prepareReload(state.session, state.session.pending?.status === 'submitted');
      break;
    case 'reloadPage': {
      requireOwner(state, request, sender);
      reloadTab = prepareReload(state.session, request.review === true);
      break;
    }
    case 'recoverPage':
      requireOwner(state, request, sender);
      Core.recover(state.session, request.page);
      break;
    case 'betAck':
      requireOwner(state, request, sender);
      Core.acknowledge(state.session, request.betId, request.outcome, request.reason);
      break;
    case 'pageError':
      requireOwner(state, request, sender);
      if (state.session.active) {
        const recovering = !!state.session.recovery;
        if (state.session.pending?.status === 'reserved') state.session.pending = null;
        Core.pause(state.session, String(request.error || 'Page controls unavailable.'));
        state.session.recovery = null;
        if (recovering && state.session.pending) state.session.needsReview = true;
      }
      break;
  }
  // Reservations and acknowledgements are durable before the reply authorizes a click.
  await writeState(state);
  if (reloadTab !== null) {
    try { await chrome.tabs.reload(reloadTab); }
    catch (error) {
      Core.pause(state.session, 'Could not reload roulette: ' + error.message);
      state.session.needsReview = !!state.session.pending;
      state.session.recovery = null;
      await writeState(state);
    }
  }
  return { success: true, ...state, instruction, controllerTabId: sender.tab?.id ?? null };
}
function serialize(task) {
  const result = queue.then(task);
  queue = result.catch(() => {});
  return result;
}
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || !ACTIONS.has(request.action)) return false;
  serialize(() => handle(request, sender))
    .then(sendResponse, error => sendResponse({ success: false, error: error.message }));
  return true;
});
async function pauseSession(reason, tabId) {
  const state = await readState();
  if (state.session && (tabId === undefined || state.session.tabId === tabId)) {
    Core.pause(state.session, reason);
    await writeState(state);
  }
}
chrome.tabs.onRemoved.addListener(tabId => {
  serialize(() => pauseSession('Roulette tab closed — session paused.', tabId)).catch(console.error);
});
chrome.runtime.onStartup.addListener(() => {
  serialize(() => pauseSession('Browser restarted — start a new session after checking outstanding bets.')).catch(console.error);
});
chrome.runtime.onInstalled.addListener(() => {
  serialize(async () => {
    const state = await readState();
    if (state.session) Core.pause(state.session, 'Extension updated — session paused.');
    await writeState(state);
  }).catch(console.error);
});
