document.addEventListener('DOMContentLoaded', async () => {
  'use strict';
  const Core = RouletteCore;
  const byId = id => document.getElementById(id);
  const fields = ['amount', 'tButton', 'ctButton', 'result', 'history', 'countdown', 'balance', 'closed', 'ownT', 'ownCT'];
  let current = { config: Core.settings(), session: null, revision: -1 };
  let working = false;
  let feedback = '';
  function message(text, error = false) {
    if (!error) return;
    feedback = text;
    status();
  }
  for (const id of ['betAmount', 'stopLoss']) {
    const input = byId(id);
    input.addEventListener('input', () => { input.value = input.value.replace(/,/g, '.'); });
    input.addEventListener('blur', () => {
      try { input.value = Core.formatAmount(Core.cents(input.value, id === 'betAmount' ? 'Base bet' : 'Stop loss', id === 'stopLoss')); }
      catch { /* Validate incomplete edits when submitted. */ }
    });
  }
  function fill(config) {
    byId('strategy').value = config.strategy;
    byId('betAmount').value = Core.formatAmount(Core.cents(config.betAmount, 'Base bet'));
    byId('turnsWait').value = config.turnsWait;
    byId('stopLoss').value = Core.formatAmount(Core.cents(config.stopLoss, 'Stop loss', true));
    byId('mode').value = config.dryRun ? 'simulation' : 'live';
    byId('betBeforeSeconds').value = config.betBeforeSeconds;
    byId('timingVarianceSeconds').value = config.timingVarianceSeconds;
    for (const key of fields) byId(`${key}Selector`).value = config.selectors[key];
  }
  function settings() {
    const selectors = {};
    for (const key of fields) selectors[key] = byId(`${key}Selector`).value;
    const config = Core.settings({
      strategy: byId('strategy').value, betAmount: byId('betAmount').value,
      turnsWait: byId('turnsWait').value, stopLoss: byId('stopLoss').value,
      betBeforeSeconds: byId('betBeforeSeconds').value, timingVarianceSeconds: byId('timingVarianceSeconds').value,
      dryRun: byId('mode').value !== 'live', selectors
    });
    byId('betAmount').value = Core.formatAmount(Core.cents(config.betAmount, 'Base bet'));
    byId('stopLoss').value = Core.formatAmount(Core.cents(config.stopLoss, 'Stop loss', true));
    return config;
  }
  function status() {
    const session = current.session;
    byId('botStatus').textContent = feedback || Core.displayStatus(session);
    byId('botStatus').style.color = feedback ? '#a52a24' : session?.active ? '#247440' : '#bf4200';
    byId('currentProfit').textContent = (-(session?.netLossCents || 0) / 100).toFixed(2);
    byId('currentBet').textContent = session ? (session.nextBetCents / 100).toFixed(2) : current.config.betAmount;
    byId('wins').textContent = session?.wins || 0;
    byId('losses').textContent = session?.losses || 0;
    for (const button of document.querySelectorAll('button')) button.disabled = working;
    byId('saveSettings').disabled = working || !!session?.active || !!session?.pending;
    byId('resetSession').disabled = working || !!session?.active;
    byId('stopButton').disabled = working || !session?.active;
    for (const button of document.querySelectorAll('[data-pick], #saveSetup')) {
      button.disabled = working || !!session?.active || !!session?.pending;
    }
  }
  async function send(request) {
    const response = await chrome.runtime.sendMessage(request);
    if (!response?.success) throw new Error(response?.error || 'No response from the extension.');
    if (response.revision >= current.revision) {
      if (response.revision > current.revision) feedback = '';
      current = { config: response.config, session: response.session, revision: response.revision };
    }
    status();
    return response;
  }
  async function rouletteTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let url;
    try { url = new URL(tab?.url); } catch { /* handled below */ }
    if (!tab?.id || url?.protocol !== 'https:' || !['csgoempire.com', 'www.csgoempire.com'].includes(url.hostname)) {
      throw new Error('Open the CSGOEmpire roulette tab and open this popup there.');
    }
    return tab;
  }
  async function tabMessage(tab, request) {
    let response;
    try { response = await chrome.tabs.sendMessage(tab.id, request); }
    catch { throw new Error('Refresh the roulette tab after loading/reloading the extension.'); }
    if (!response?.success) throw new Error(response?.error || 'The page did not respond.');
    return response;
  }
  async function work(action) {
    if (working) return;
    working = true;
    feedback = '';
    status();
    try { await action(); }
    catch (error) { message(error.message, true); }
    finally { working = false; status(); }
  }
  byId('settingsForm').addEventListener('submit', event => {
    event.preventDefault();
    void work(async () => {
      const config = settings();
      const tab = await rouletteTab();
      const page = await tabMessage(tab, { action: 'inspect', config });
      if (!page.ready) { byId('pageSetup').open = true; throw new Error(page.error); }
      await send({ action: 'saveConfig', settings: config, tabId: tab.id, documentId: page.documentId });
      message(page.phase === 'closed' || page.phase === 'waiting'
        ? 'Started on this tab. Waiting for the current roll to finish.'
        : config.dryRun ? 'Simulation started. It will not click bets.' : 'Started on this tab. Waiting for new completed rounds.');
    });
  });
  byId('stopButton').addEventListener('click', () => void work(async () => {
    await send({ action: 'stopBot' });
    message('Stopped. An accepted outstanding bet is still tracked until its result.');
  }));
  byId('resetSession').addEventListener('click', () => void work(async () => {
    await send({ action: 'resetSession' });
    message('Local session reset. Website bets are unaffected.');
  }));
  byId('saveSetup').addEventListener('click', () => void work(async () => {
    await send({ action: 'saveSettings', settings: settings() });
    message('Settings saved.');
  }));
  byId('checkPage').addEventListener('click', () => void work(async () => {
    const tab = await rouletteTab();
    const page = await tabMessage(tab, { action: 'inspect', config: settings() });
    if (!page.ready) throw new Error(page.error);
    message(`Page controls found. ${page.detail} ${page.confirmation === 'balance' ? 'Live acceptance uses the displayed balance deduction.' : ''}`);
  }));
  for (const button of document.querySelectorAll('[data-pick]')) {
    button.addEventListener('click', () => void work(async () => {
      const tab = await rouletteTab();
      await send({ action: 'saveSettings', settings: settings() });
      await tabMessage(tab, { action: 'pickElement', key: button.dataset.pick });
      window.close();
    }));
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const revision = changes.revision?.newValue ?? current.revision;
    if (revision < current.revision) return;
    if (revision > current.revision) feedback = '';
    current.revision = revision;
    if (changes.config) {
      current.config = changes.config.newValue;
      for (const key of fields) byId(`${key}Selector`).value = current.config.selectors[key];
    }
    if (changes.session) current.session = changes.session.newValue || null;
    status();
  });
  try {
    await send({ action: 'getState' });
    fill(current.config);
    status();
  } catch (error) { message(error.message, true); }
});
