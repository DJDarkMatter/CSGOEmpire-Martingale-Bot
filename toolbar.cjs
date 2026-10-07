'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Core = require('../core.js');
const clone = value => JSON.parse(JSON.stringify(value));
async function flush() {
  for (let index = 0; index < 10; index++) await new Promise(resolve => setImmediate(resolve));
}

// A small DOM harness exercises the real toolbar module without browser/account access.
function harness(overrides = {}, options = {}) {
  let clock = options.now ?? 10000;
  class VirtualDate extends Date { static now() { return clock; } }
  class Style {
    constructor() { this.values = new Map(); this.priorities = new Map(); }
    setProperty(name, value, priority = '') { this.values.set(name, value); this.priorities.set(name, priority); }
    getPropertyValue(name) { return this.values.get(name) || ''; }
    getPropertyPriority(name) { return this.priorities.get(name) || ''; }
    removeProperty(name) { this.values.delete(name); this.priorities.delete(name); }
  }
  class Element {
    constructor(tag) {
      this.localName = tag; this.children = []; this.style = new Style();
      this.isConnected = false; this.listeners = new Map(); this.attributes = {};
      this.textContent = ''; this.hidden = false; this.disabled = false; this.dataset = {};
      this._value = ''; this.className = '';
    }
    set value(value) { this._value = String(value); }
    get value() { return this._value; }
    appendChild(child) { this.children.push(child); child.parentElement = this; child.isConnected = this.isConnected; return child; }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
      this.isConnected = false;
    }
    contains(element) { return this.children.includes(element); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name]; }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    async fire(type) {
      if (this.disabled) return;
      await this.listeners.get(type)?.({ target: this, preventDefault() {} });
      await flush();
    }
    attachShadow(options) {
      this.shadowMode = options.mode;
      this.testShadow = new Shadow();
      return this.testShadow;
    }
    get shadowRoot() { return this.shadowMode === 'closed' ? null : this.testShadow; }
    getBoundingClientRect() {
      return { height: 90 + (this.testShadow?.getElementById('setup').hidden === false ? 230 : 0) };
    }
  }
  class Shadow {
    constructor() { this.nodes = []; }
    set innerHTML(html) {
      this.html = html;
      for (const match of html.matchAll(/<(input|select|button|form|span|b|div)\b([^>]*)>/g)) {
        const node = new Element(match[1]);
        const attrs = match[2];
        node.id = attrs.match(/\bid="([^"]+)"/)?.[1];
        node.dataset.pick = attrs.match(/\bdata-pick="([^"]+)"/)?.[1];
        node.hidden = /\bhidden\b/.test(attrs);
        this.nodes.push(node);
      }
    }
    getElementById(id) { return this.nodes.find(node => node.id === id); }
    querySelectorAll(selector) {
      if (selector === 'input, select') return this.nodes.filter(node => ['input', 'select'].includes(node.localName));
      if (selector === '[data-pick]') return this.nodes.filter(node => node.dataset.pick);
      throw new Error('Unexpected test selector: ' + selector);
    }
  }
  const html = new Element('html'); html.isConnected = true;
  html.style.setProperty('--csgo-roulette-bot-height', '4px', 'important');
  const body = new Element('body'); body.isConnected = true;
  const head = new Element('head'); head.isConnected = true;
  let header = options.lateHeader ? null : new Element('div');
  if (header) { header.isConnected = true; header.position = 'fixed'; }
  const created = [];
  let resize;
  let disconnected = false;
  const windowListeners = new Map();
  const document = {
    documentElement: html, body, head,
    createElement(tag) { const element = new Element(tag); created.push(element); return element; },
    getElementById(id) { return id === 'empire-header' ? header : null; }
  };
  const context = vm.createContext({
    RouletteCore: Core, document, console, Date: VirtualDate,
    window: {
      addEventListener(type, callback) { windowListeners.set(type, callback); },
      removeEventListener(type) { windowListeners.delete(type); }
    },
    ResizeObserver: class {
      constructor(callback) { resize = callback; }
      observe() {}
      disconnect() { disconnected = true; }
    },
    getComputedStyle(element) {
      return { paddingTop: element === body ? '12px' : '0px',
        position: element.position || 'static', top: '0px' };
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../toolbar.js'), 'utf8'), context);
  const calls = [];
  const callbacks = Object.fromEntries(['start', 'stop', 'reset', 'save', 'check', 'pick'].map(action =>
    [action, (...args) => { calls.push({ action, args }); return action === 'check' ? 'Controls found.' : undefined; }]
  ));
  const bar = context.RouletteToolbar.mount({ ...callbacks, ...overrides });
  const host = created.find(element => element.id === 'csgo-roulette-bot-toolbar');
  const shadow = host.testShadow;
  const sheet = created.find(element => element.localName === 'style');
  const state = { config: Core.settings(), session: null, revision: 0, tabId: 1 };
  bar.update(state);
  return { bar, state, host, shadow, sheet, html, calls, byId: id => shadow.getElementById(id),
    resize: () => resize(), disconnected: () => disconnected, windowListeners,
    advance(milliseconds) { clock += milliseconds; bar.refreshLayout(); },
    addHeader() { header = new Element('div'); header.position = 'fixed'; header.isConnected = true; } };
}

module.exports = async function runToolbarTests(test) {
  await test('runtime ticks between round updates, survives stored state, freezes on stop and resets for a new session', () => {
    const ui = harness();
    const state = clone(ui.state);
    state.session = Core.create(state.config, 1, 'doc-1', 'timed-session', [], null, 10000);
    state.revision++; ui.bar.update(state);
    assert.equal(ui.byId('runtime').textContent, '00:00:00');
    assert.ok(ui.shadow.html.indexOf('id="runtime"') > ui.shadow.html.indexOf('id="withoutCT"'));
    ui.advance(3662000);
    assert.equal(ui.byId('runtime').textContent, '01:01:02');
    const restored = harness({}, { now: 3672000 });
    restored.bar.update(clone(state));
    assert.equal(restored.byId('runtime').textContent, '01:01:02');
    Core.stop(state.session, 3672000);
    const stoppedAt = state.session.stoppedAt;
    state.revision++; ui.bar.update(state); ui.advance(5000);
    assert.equal(ui.byId('runtime').textContent, '01:01:02');
    Core.pause(state.session, 'Page closed.', 3677000);
    assert.equal(state.session.stoppedAt, stoppedAt);
    state.session = null; state.revision++; ui.bar.update(state);
    assert.equal(ui.byId('runtime').textContent, '00:00:00');
    state.session = Core.create(state.config, 1, 'doc-1', 'new-timed-session', [], null, 3677000);
    state.revision++; ui.bar.update(state); ui.advance(2000);
    assert.equal(ui.byId('runtime').textContent, '00:00:02');
    assert.equal(Core.runtime({ active: false }), '00:00:00');
  });
  await test('Betting stays through the base bet, Dice loss, waiting to double and doubled bet until a win; profit signs match results', () => {
    const ui = harness();
    const state = clone(ui.state);
    const config = Core.settings({ betAmount: .01, turnsWait: 1 });
    state.session = Core.create(config, 1, 'doc-1', 'betting-display', ['CT'], null, 10000);
    const observe = extra => Core.observe(state.session, extra, () => 'bet-' + state.revision);
    const update = () => { state.revision++; ui.bar.update(clone(state)); };
    const first = { phase: 'open', openKey: 'open-0', resultKey: 'result-0', side: 'CT', controlsReady: true,
      placementWindow: 'waiting', betAtSeconds: 10 };
    observe(first); update();
    assert.ok(!ui.byId('phase').textContent.startsWith('Betting — '));
    const base = observe({ ...first, placementWindow: 'ready' }); update();
    assert.match(ui.byId('phase').textContent, /^Betting — Preparing/);
    Core.acknowledge(state.session, base.id, 'accepted'); update();
    assert.match(ui.byId('phase').textContent, /^Betting — Waiting for the T bet result/);
    observe({ phase: 'closed' });
    const loss = { ...first, openKey: 'open-1', resultKey: 'result-1', side: 'Dice' };
    observe(loss); update();
    assert.equal(state.session.pending, null);
    assert.match(ui.byId('phase').textContent, /^Betting — Waiting to place T bet/);
    assert.equal(ui.byId('netProfit').textContent, '-0.01');
    const doubled = observe({ ...loss, placementWindow: 'ready' });
    assert.equal(doubled.amountCents, 2);
    Core.acknowledge(state.session, doubled.id, 'accepted'); update();
    assert.match(ui.byId('phase').textContent, /^Betting — Waiting for the T bet result \(0.02 coins\)/);
    observe({ phase: 'closed' });
    observe({ ...first, openKey: 'open-2', resultKey: 'result-2', side: 'T' }); update();
    assert.equal(state.session.wins, 1); assert.equal(state.session.chaseSide, null);
    assert.ok(!ui.byId('phase').textContent.startsWith('Betting — '));
    assert.equal(ui.byId('netProfit').textContent, '0.01');
    assert.equal(ui.byId('nextBet').textContent, '0.01');
  });
  await test('toolbar accepts comma decimals and a one-roll threshold with clear labels and no lower status row', async () => {
    const ui = harness();
    assert.ok(ui.shadow.html.includes('Base bet'));
    assert.ok(ui.shadow.html.includes('Bet after streak'));
    assert.ok(ui.shadow.html.includes('Next bet'));
    assert.ok(ui.shadow.html.includes('id="turnsWait" type="number" min="1"'));
    assert.equal(ui.byId('notice'), undefined);
    ui.byId('betAmount').value = '0,01';
    await ui.byId('betAmount').fire('input');
    assert.equal(ui.byId('betAmount').value, '0.01');
    await ui.byId('betAmount').fire('blur');
    ui.byId('turnsWait').value = '1';
    ui.byId('stopLoss').value = '10,50';
    await ui.byId('stopLoss').fire('input');
    await ui.byId('save').fire('click');
    assert.equal(ui.calls[0].args[0].betAmount, .01);
    assert.equal(ui.calls[0].args[0].turnsWait, 1);
    assert.equal(ui.calls[0].args[0].stopLoss, 10.5);
    assert.equal(ui.byId('phase').textContent, 'Idle — ready to start.');
  });
  await test('toolbar mounts automatically, reserves measured height, and offsets the balance header', async () => {
    const ui = harness();
    assert.equal(ui.host.isConnected, true);
    assert.equal(ui.host.shadowRoot, null);
    assert.match(ui.host.style.cssText, /position:fixed/);
    assert.equal(ui.html.style.getPropertyValue('--csgo-roulette-bot-height'), '90px');
    assert.match(ui.sheet.textContent, /body \{ padding-top: calc\(12px/);
    assert.match(ui.sheet.textContent, /#empire-header \{ top: calc\(0px/);
    assert.equal(ui.calls.length, 0, 'Mounting must not start a session.');
    await ui.byId('setupToggle').fire('click');
    assert.equal(ui.byId('setup').hidden, false);
    assert.equal(ui.byId('setupToggle').getAttribute('aria-expanded'), 'true');
    assert.equal(ui.html.style.getPropertyValue('--csgo-roulette-bot-height'), '320px');
    await ui.byId('setupToggle').fire('click');
    assert.equal(ui.html.style.getPropertyValue('--csgo-roulette-bot-height'), '90px');
    assert.equal(ui.calls.length, 0, 'Expanding settings must not change the session.');
    ui.bar.destroy();
    assert.equal(ui.host.isConnected, false);
    assert.equal(ui.sheet.isConnected, false);
    assert.equal(ui.html.style.getPropertyValue('--csgo-roulette-bot-height'), '4px');
    assert.equal(ui.html.style.getPropertyPriority('--csgo-roulette-bot-height'), 'important');
    assert.equal(ui.disconnected(), true);
  });
  await test('toolbar catches a balance header loaded later without covering it', () => {
    const ui = harness({}, { lateHeader: true });
    assert.ok(!ui.sheet.textContent.includes('#empire-header'));
    ui.addHeader(); ui.bar.refreshLayout();
    assert.match(ui.sheet.textContent, /#empire-header/);
  });
  await test('toolbar shows session numbers and preserves unsaved settings during round updates', () => {
    const ui = harness();
    ui.byId('betAmount').value = '7.25';
    const state = clone(ui.state);
    state.session = Core.create(state.config, 1, 'doc-1', 'session-1');
    state.session.status = 'Waiting for CT result.';
    state.session.netLossCents = 1234; state.session.nextBetCents = 2468;
    state.session.wins = 2; state.session.losses = 3;
    state.session.missingRounds = { T: 1, CT: 15 };
    state.revision++;
    ui.bar.update(state);
    assert.equal(ui.byId('netProfit').textContent, '-12.34');
    assert.equal(ui.byId('nextBet').textContent, '24.68');
    assert.equal(ui.byId('withoutCT').textContent, '15');
    assert.equal(ui.byId('wins').textContent, '2');
    assert.equal(ui.byId('losses').textContent, '3');
    assert.equal(ui.byId('betAmount').value, '7.25');
    assert.equal(ui.byId('start').disabled, true);
    assert.equal(ui.byId('stop').disabled, false);
    state.session.countsLowerBound = { CT: true };
    state.revision++; ui.bar.update(state);
    assert.equal(ui.byId('withoutCT').textContent, '≥15');
    assert.equal(ui.byId('withoutT').textContent, '1');
    ui.bar.update(ui.state);
    assert.equal(ui.byId('nextBet').textContent, '24.68', 'A stale response must not overwrite newer state.');
  });
  await test('toolbar saves exact settings and rejects invalid amounts before sending them', async () => {
    const ui = harness();
    ui.byId('betAmount').value = '0.25';
    ui.byId('turnsWait').value = '15';
    ui.byId('stopLoss').value = '0';
    ui.byId('betBeforeSeconds').value = '10.3';
    ui.byId('timingVarianceSeconds').value = '0.2';
    await ui.byId('save').fire('click');
    const config = ui.calls[0].args[0];
    assert.equal(config.betAmount, .25); assert.equal(config.turnsWait, 15);
    assert.equal(config.stopLoss, 0); assert.equal(config.dryRun, true);
    assert.equal(config.betBeforeSeconds, 10.3); assert.equal(config.timingVarianceSeconds, .2);
    ui.byId('betAmount').value = '-1';
    await ui.byId('settingsForm').fire('submit');
    assert.equal(ui.calls.length, 1);
    assert.match(ui.byId('phase').textContent, /Base bet/);
    assert.equal(ui.byId('start').disabled, false);
  });
  await test('toolbar surfaces failed starts and permits Stop while a Start reply is pending', async () => {
    let ui;
    let finish;
    const gate = new Promise(resolve => { finish = resolve; });
    ui = harness({
      async start() {
        const state = clone(ui.state);
        state.session = Core.create(state.config, 1, 'doc-1', 'session-1');
        state.revision = 1; ui.bar.update(state);
        await gate;
      },
      async stop() {
        const state = clone(ui.state);
        state.session = Core.create(state.config, 1, 'doc-1', 'session-1');
        Core.stop(state.session);
        state.revision = 2; ui.bar.update(state);
      }
    });
    await ui.byId('settingsForm').fire('submit');
    assert.equal(ui.byId('start').disabled, true);
    assert.equal(ui.byId('stop').disabled, false);
    await ui.byId('stop').fire('click');
    finish(); await flush();
    assert.match(ui.byId('phase').textContent, /Stopped/);
    assert.equal(ui.byId('notice'), undefined);
    const failed = harness({ start() { throw new Error('Betting is closed.'); } });
    await failed.byId('settingsForm').fire('submit');
    assert.equal(failed.byId('phase').textContent, 'Betting is closed.');
    assert.equal(failed.byId('start').disabled, false);
  });
  await test('toolbar check and selector picking do not start a bet or leave setup covering the page', async () => {
    const ui = harness();
    await ui.byId('check').fire('click');
    assert.equal(ui.byId('phase').textContent, 'Controls found.');
    await ui.byId('setupToggle').fire('click');
    const pick = ui.shadow.querySelectorAll('[data-pick]').find(node => node.dataset.pick === 'amount');
    await pick.fire('click');
    assert.equal(ui.byId('setup').hidden, true);
    assert.equal(ui.calls[1].action, 'pick');
    assert.equal(ui.calls[1].args[0], 'amount');
    assert.equal(ui.calls.filter(call => call.action === 'start').length, 0);
  });
  await test('toolbar disables another tab controls and invalidated extension controls', () => {
    const ui = harness();
    const state = clone(ui.state);
    state.session = Core.create(state.config, 2, 'doc-2', 'session-2');
    state.revision = 1; ui.bar.update(state);
    assert.match(ui.byId('phase').textContent, /^Another tab:/);
    assert.equal(ui.byId('stop').disabled, true);
    assert.equal(ui.byId('reset').disabled, true);
    ui.bar.invalidate('Refresh this tab.');
    assert.equal(ui.byId('phase').textContent, 'Refresh this tab.');
    assert.equal(ui.byId('check').disabled, true);
    assert.equal(ui.byId('setupToggle').disabled, true);
  });
};
