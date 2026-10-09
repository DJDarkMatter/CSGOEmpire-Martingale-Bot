'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const Core = require('../core.js');
const root = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
let passed = 0;
async function test(name, action) {
  await action();
  passed++;
  console.log(`PASS ${name}`);
}
function round(session, number, side, accepted = true) {
  Core.observe(session, { phase: 'closed' }, randomUUID);
  const bet = Core.observe(session, {
    phase: 'open', openKey: `open-${number}`, resultKey: `result-${number}`, side, controlsReady: true
  }, randomUUID);
  if (bet && accepted) Core.acknowledge(session, bet.id, session.config.dryRun ? 'accepted' : 'submitted');
  if (bet && accepted && !session.config.dryRun) Core.acknowledge(session, bet.id, 'accepted');
  return bet;
}
function session(input = {}) {
  const state = Core.create(Core.settings({ turnsWait: 2, ...input }), 1, 'doc-1', 'session-1');
  Core.observe(state, { phase: 'open', openKey: 'open-0', resultKey: 'result-0', side: 'T', controlsReady: true }, randomUUID);
  return state;
}

function workerHarness(initial = {}, getNow = () => Date.now()) {
  let data = clone(initial);
  const changes = [];
  let currentWorker;
  const listeners = {};
  const reloadCalls = [];
  const popupSender = { id: 'test', url: 'chrome-extension://test/popup.html' };
  const contentSender = { id: 'test', url: 'https://csgoempire.com/', tab: { id: 1, url: 'https://csgoempire.com/' }, frameId: 0 };
  const storage = {
    local: {
      async get(keys) {
        await Promise.resolve();
        const result = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) if (data[key] !== undefined) result[key] = clone(data[key]);
        return result;
      },
      async set(values) {
        await Promise.resolve();
        const delta = {};
        for (const [key, value] of Object.entries(values)) {
          delta[key] = { oldValue: data[key], newValue: clone(value) };
          data[key] = clone(value);
        }
        for (const listener of changes) listener(clone(delta), 'local');
      }
    },
    onChanged: { addListener: listener => changes.push(listener) }
  };
  const tabs = {
    get: async id => ({ id, url: 'https://csgoempire.com/' }),
    sendMessage: async () => ({ success: true, ready: true, documentId: 'doc-1' }),
    reload: async id => { reloadCalls.push(id); },
    onRemoved: { addListener: listener => { listeners.removed = listener; } }
  };
  function boot() {
    const runtime = {
      getURL: file => `chrome-extension://test/${file}`,
      onMessage: { addListener: listener => { currentWorker = listener; } },
      onStartup: { addListener: listener => { listeners.startup = listener; } },
      onInstalled: { addListener: listener => { listeners.installed = listener; } }
    };
    class WorkerDate extends Date { static now() { return getNow(); } }
    const context = vm.createContext({ chrome: { storage, tabs, runtime }, console, URL, Date: WorkerDate, crypto: { randomUUID } });
    context.importScripts = filename => vm.runInContext(fs.readFileSync(path.join(root, filename), 'utf8'), context);
    vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
  }
  function dispatch(request, sender = popupSender) {
    return new Promise((resolve, reject) => {
      const keepAlive = currentWorker(clone(request), sender, resolve);
      if (keepAlive !== true) reject(new Error('Async message did not keep its response channel open.'));
    });
  }
  boot();
  return { dispatch, boot, tabs, storage, listeners, reloadCalls, popupSender, contentSender, read: () => clone(data) };
}
async function flush() {
  for (let index = 0; index < 30; index++) await new Promise(resolve => setImmediate(resolve));
}

async function contentHarness(options = {}) {
  const config = Core.settings({
    betAmount: options.betAmount ?? 12.34, turnsWait: options.turnsWait ?? 2, dryRun: options.dryRun !== false,
    betBeforeSeconds: options.betBeforeSeconds ?? 10, timingVarianceSeconds: options.timingVarianceSeconds ?? 0.5,
    ...(options.siteLayout ? {} : { selectors: { result: '#result', tButton: '#t', ctButton: '#ct', amount: '#amount', ownT: '#own-t', ownCT: '#own-ct', closed: '' } })
  });
  if (options.seedHistory && options.direction === 'first' && !options.useFallbackSelector) {
    config.selectors.result = '[data-testid="previous-rolls-item"]:first-child > div';
  }
  let clock = 10000;
  const worker = workerHarness({ config }, () => clock);
  let generation = 0;
  let pageLoading = false;
  let missingForOneRead = null;
  let visibilityListener;
  let replacedInput = false;
  let tick;
  let watchdogTick;
  let contentMessage;
  let inputStop = false;
  const events = [];
  const inputEvents = [];
  const clickedAmounts = [];
  const inputFocusedAtBet = [];
  const warnings = [];
  let requiresFormatting = false;
  let committedStake = 0;
  let activeElement = null;
  let clicked = 0;
  const timers = [];
  const documentListeners = new Map();
  let currencyModelStake = 0;
  let toolbarCallbacks;
  let toolbarState;
  let initialized = options.siteHealth ? true : undefined;
  let roundState = options.siteHealth ? (options.startClosed ? 'roll' : 'rolling') : undefined;
  let siteRoundId = options.siteHealth ? 0 : undefined;
  const siteSubscribers = new Set();
  const messages = [];
  const notifySite = (type, payload = {}) => {
    for (const listener of siteSubscribers) listener({ type: 'roulette/' + type, payload });
  };
  class Element {
    constructor(tag, attrs = {}, text = '') {
      this.localName = tag; this.attrs = attrs; this.textContent = text;
      this.disabled = false; this.readOnly = false; this.isConnected = true;
      this.style = {}; this.classList = Object.assign([], { contains: () => false });
      this.listeners = new Map();
    }
    getClientRects() { return this.isConnected && !(options.zeroRectsHidden && document.hidden) ? [{}] : []; }
    getAttribute(name) { return this.attrs[name] ?? null; }
    querySelectorAll() { return []; }
    matches() { return this.localName === 'button'; }
    closest(selector) { return selector.includes('data-round-id') && this.attrs['data-round-id'] ? this : null; }
    contains(element) { return element === this; }
    focus() {
      if (options.focusUnavailable && this === amount) return;
      if (activeElement === this) return;
      activeElement?.blur(); activeElement = this; this.focused = true;
      if (this === amount && options.commitOnAmountFocus) committedStake = Core.cents(this.value, 'Focused site stake', true);
    }
    blur() { if (activeElement === this) activeElement = null; this.focused = false; }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
    }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    dispatchEvent(event) {
      Object.defineProperty(event, 'target', { value: this, configurable: true });
      if (!event.type.startsWith('roulette-bot:')) events.push(event.type);
      if (event.type === 'input') inputEvents.push({ data: event.data, inputType: event.inputType, composed: event.composed });
      if (event.type === 'input' && options.hiddenCharacter) requiresFormatting = true;
      if (event.type === 'input' && options.rejectAmount) this.value = '1';
      if (event.type === 'beforeinput' && options.blockBeforeInput) event.preventDefault();
      if (event.type === 'input' && options.requiresClickBeforeInput && event.data && !this.activated) committedStake = 0;
      else if (event.type === 'input' && options.requiresClickBeforeInput && event.data) committedStake = Core.cents(this.value, 'Activated stake');
      if (event.type === 'input' && options.commitAfterDebounce) {
        const text = this.value;
        timers.push({ at: clock + options.commitAfterDebounce, callback: () => { if (this.value === text) committedStake = text ? Core.cents(text, 'Debounced stake', true) : 0; } });
      }
      if (event.type === 'input' && options.siteBlurModel) {
        const text = this.value;
        timers.push({ at: clock + (options.modelDelayMs ?? 50), callback: () => {
          if (!options.ignoreModelUpdates) currencyModelStake = text ? Core.cents(text, 'CurrencyInput model', true) : 0;
        } });
      }
      if (event.type === 'input' && options.closeOnInput) {
        countdown.textContent = '0'; t.disabled = true; ct.disabled = true;
      }
      if (event.type === 'input' && options.changeRoundOnInput) result.attrs['data-round-id'] = 'changed';
      if (event.type === 'input' && options.stopOnInput && !inputStop) {
        inputStop = true;
        void worker.dispatch({ action: 'stopBot' });
      }
      for (const listener of [...(this.listeners.get(event.type) || [])]) listener(event);
      if (event.bubbles) for (const listener of [...(documentListeners.get(event.type) || [])]) listener(event);
      return !event.defaultPrevented;
    }
  }
  class Input extends Element {
    constructor() { super('input'); this.type = 'number'; this._value = '99'; }
    get value() { return this._value; }
    set value(value) { this._value = String(value); }
    blur() {
      const wasFocused = this.focused;
      super.blur();
      if (wasFocused) this.dispatchEvent(new Event('blur', { composed: true }));
    }
    dispatchEvent(event) {
      if (event.type !== 'blur') return super.dispatchEvent(event);
      if (options.siteBlurModel) committedStake = currencyModelStake;
      if (options.commitOnBlur) committedStake = Core.cents(this.value, 'Committed site stake', true);
      if (options.resetAmountOnBlur) this.value = '0';
      if (options.hiddenCharacter && requiresFormatting && !this.value.includes(options.hiddenCharacter)) this.value += options.hiddenCharacter;
      if (options.replaceInputOnBlur && !replacedInput) {
        replacedInput = true;
        timers.push({ at: clock + 400, callback: () => {
          const previous = amount;
          amount = new Input(); amount.type = previous.type; amount.value = previous.value;
          previous.isConnected = false;
          nodes[Core.DEFAULTS.selectors.amount] = amount; nodes['#amount'] = amount;
          committedStake = 0;
        } });
      }
      return super.dispatchEvent(event);
    }
    click() {
      this.activated = true;
      this.dispatchEvent(new Event('click', { bubbles: true }));
      if (options.normalizeOnAmountClick) {
        this.value = this.value.replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, '').replace(',', '.');
        requiresFormatting = false;
      }
      if (options.commitOnAmountClick) committedStake = Core.cents(this.value, 'Clicked site stake', true);
      if (options.stopOnAmountClick) void worker.dispatch({ action: 'stopBot' });
    }
  }
  const result = new Element('span', { 'data-round-id': '0', 'data-side': 't' });
  let amount = new Input();
  const ownT = new Element('span', {}, options.commaDecimal ? '0,00' : '0');
  const ownCT = new Element('span', {}, options.commaDecimal ? '0,00' : '0');
  const t = new Element('button');
  const ct = new Element('button');
  const nodes = { '#result': result, '#t': t, '#ct': ct, '#amount': amount, '#own-t': ownT, '#own-ct': ownCT };
  const countdown = new Element('div', {}, String(options.initialSeconds ?? '9,8'));
  nodes[Core.DEFAULTS.selectors.countdown] = countdown;
  const wheel = new Element('div');
  const balance = new Element('span', {}, options.balance || '100.00');
  const hiddenBalance = new Element('span', {}, '900.00');
  hiddenBalance.parentElement = new Element('div');
  hiddenBalance.parentElement.style.display = 'none';
  let history = [];
  if (options.siteLayout) {
    const fixture = fs.readFileSync(path.join(root, 'tests/site-fixture.html'), 'utf8');
    let classes = [...fixture.matchAll(/data-testid="previous-rolls-item"[^>]*>\s*<div class="([^"]+)"/g)].map(match => match[1]);
    assert.equal(classes.length, 10, 'Read actual history icons from the sanitized fixture.');
    if (options.initialHistory) classes = options.initialHistory.map(side => 'coin-' + (side === 'Dice' ? 'bonus' : side.toLowerCase()));
    history = classes.map(value => {
      const element = new Element('div');
      const tokens = value.split(/\s+/);
      element.classList = Object.assign(tokens, { contains: token => tokens.includes(token) });
      return element;
    });
    t.attrs.disable = 'false'; ct.attrs.disable = 'false';
    if (options.disabledSide === 'T') t.attrs.disable = 'true';
    if (options.disabledSide === 'CT') ct.attrs.disable = 'true';
    amount.type = 'text'; amount.value = options.initialAmount ?? '0.1';
    nodes[Core.DEFAULTS.selectors.amount] = amount;
    nodes[Core.DEFAULTS.selectors.tButton] = t;
    nodes[Core.DEFAULTS.selectors.ctButton] = ct;
    nodes[Core.DEFAULTS.selectors.countdown] = countdown;
    nodes['[data-testid="wheel-container"]'] = wheel;
  }
  for (const [button, own] of [[t, ownT], [ct, ownCT]]) button.click = () => {
    clicked++;
    inputFocusedAtBet.push(amount.focused === true);
    const stake = options.siteBlurModel || options.commitOnBlur || options.commitOnAmountFocus || options.commitOnAmountClick || options.requiresClickBeforeInput || options.commitAfterDebounce
      ? committedStake : Core.cents(amount.value, 'Stake');
    clickedAmounts.push(stake);
    if (options.accept !== false && stake >= 1) {
      if (options.siteLayout) {
        balance.textContent = String((Core.cents(balance.textContent, 'Balance', true) - stake - (options.extraDebit || 0)) / 100);
      } else {
        own.textContent = String((Core.cents(own.textContent, 'Own amount', true) + stake) / 100);
        if (options.commaDecimal) own.textContent = own.textContent.replace('.', ',');
      }
    }
    if (options.hideBalanceOnClick) {
      balance.isConnected = false;
      timers.push({ at: clock + options.hideBalanceOnClick, callback: () => { balance.isConnected = true; } });
    }
  };
  const runtime = {
    sendMessage: async request => {
      messages.push({ action: request.action, at: clock, request: clone(request) });
      if (!options.seedHistory && !options.startClosed && request.action === 'observe') delete request.observation?.initialHistory;
      const response = await worker.dispatch(request, worker.contentSender);
      if (options.stopAfterSubmit && request.action === 'betAck' && request.outcome === 'submitted' && response.success) {
        await worker.dispatch({ action: 'stopBot' }); // Deliver an older reply AFTER the newer Stop event.
      }
      if (options.resetAmountAfterSubmit && request.action === 'betAck' && request.outcome === 'submitted') amount.value = '0';
      if (options.resetStoredStakeAfterSubmit && request.action === 'betAck' && request.outcome === 'submitted') committedStake = 0;
      return response;
    },
    onMessage: { addListener: listener => { contentMessage = listener; } }
  };
  class VirtualDate extends Date { static now() { return clock; } }
  class Observer { observe() {} disconnect() {} }
  const siteStore = {
    subscribe(listener) { siteSubscribers.add(listener); return () => siteSubscribers.delete(listener); },
    state: { roulette: {
      get isInitialized() { return initialized; },
      get roundState() { return roundState; },
      get round() { return siteRoundId; },
      get betAmountRaw() {
        if (options.missingStakeStore) return {};
        const usesModel = options.siteBlurModel || options.commitOnBlur || options.commitOnAmountFocus ||
          options.commitOnAmountClick || options.requiresClickBeforeInput || options.commitAfterDebounce;
        return (usesModel ? committedStake : Core.cents(amount.value, 'Site stake', true)) / 100;
      }
    } }
  };
  const document = {
    hidden: false,
    addEventListener(type, listener) {
      if (type === 'visibilitychange') visibilityListener = listener;
      if (!documentListeners.has(type)) documentListeners.set(type, new Set());
      documentListeners.get(type).add(listener);
    },
    documentElement: new Element('html'),
    querySelectorAll(selector) {
      if (selector === '[data-v-app]') return [{ __vue_app__: { config: { globalProperties: { $store: siteStore } } } }];
      if (selector === missingForOneRead) { missingForOneRead = null; return []; }
      if (pageLoading && selector !== Core.DEFAULTS.selectors.balance) return [];
      if (options.siteLayout && selector === Core.DEFAULTS.selectors.history) return history;
      if (options.siteLayout && selector === Core.DEFAULTS.selectors.result) return [history.at(-1)];
      if (options.siteLayout && selector === '[data-testid="previous-rolls-item"]:first-child > div') return [history[0]];
      if (options.siteLayout && selector === Core.DEFAULTS.selectors.balance) return [balance, hiddenBalance].filter(node => node.isConnected);
      return nodes[selector]?.isConnected ? [nodes[selector]] : [];
    }
  };
  if (!options.noStakeProbe) vm.runInNewContext(fs.readFileSync(path.join(root, 'stake-probe.js'), 'utf8'), {
    document, HTMLInputElement: Input, CustomEvent
  });
  function bootContent() {
    const thisGeneration = ++generation;
    let intervalNumber = 0;
    const context = vm.createContext({
    chrome: { storage: { ...worker.storage, onChanged: { addListener(listener) {
      worker.storage.onChanged.addListener((...args) => { if (thisGeneration === generation) listener(...args); });
    } } }, runtime },
    RouletteCore: Core, crypto: { randomUUID }, Date: VirtualDate,
    Math: Object.assign(Object.create(Math), { random: () => options.randomValue ?? 0.5 }),
    HTMLInputElement: Input, Event, CustomEvent, FocusEvent: Event,
    InputEvent: class extends Event {
      constructor(type, options) { super(type, options); this.data = options.data; this.inputType = options.inputType; }
    },
    document, getComputedStyle: element => ({ display: 'block', visibility: 'visible', opacity: '1', ...element.style }),
    MutationObserver: Observer, queueMicrotask, console: { ...console, warn: (...args) => warnings.push(args) },
    RouletteToolbar: { mount(callbacks) {
      toolbarCallbacks = callbacks;
      return {
        update(state) { toolbarState = clone(state); },
        refreshLayout() {}, invalidate() {}, contains() { return false; },
        height: 90
      };
    } },
    setInterval: callback => {
      const guarded = () => { if (thisGeneration === generation) callback(); };
      if (++intervalNumber === 1) tick = guarded; else watchdogTick = guarded;
      return intervalNumber;
    }, clearInterval() {}, clearTimeout() {},
    setTimeout: (callback, milliseconds) => {
      const guarded = () => { if (thisGeneration === generation) callback(); };
      if (options.manualTimers) timers.push({ at: clock + milliseconds, callback: guarded });
      else {
        clock += milliseconds;
        const ready = timers.filter(timer => timer.at <= clock);
        for (const timer of ready) { timers.splice(timers.indexOf(timer), 1); timer.callback(); }
        queueMicrotask(guarded);
      }
      return 1;
    }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'content.js'), 'utf8'), context);
  }
  if (options.startClosed) {
    countdown.isConnected = false;
    t.attrs.disable = 'true'; ct.attrs.disable = 'true';
  }
  bootContent();
  await flush();
  worker.tabs.sendMessage = async (tabId, request) => new Promise(resolve => contentMessage(request, {}, response => {
    // Existing transition tests isolate newly observed rounds. Startup cases use the full history path.
    if (!options.seedHistory && request.action === 'inspect') response.initialHistory = [];
    resolve(response);
  }));
  const page = await worker.tabs.sendMessage(1, { action: 'inspect', config });
  assert.equal(page.ready, true, page.error);
  if (options.autoStart !== false) {
    const start = await worker.dispatch({ action: 'saveConfig', settings: config, tabId: 1, documentId: page.documentId });
    assert.equal(start.success, true, start.error);
  }
  clock += 1200; tick(); await flush();
  async function closeRound() {
    if (options.siteHealth) { roundState = 'roll'; notifySite('SOCKET_ROULETTE_roll'); }
    if (options.siteLayout) {
      countdown.isConnected = false;
      if (!options.onlyCountdown) { t.attrs.disable = 'true'; ct.attrs.disable = 'true'; }
    } else { t.disabled = true; ct.disabled = true; }
    tick(); await flush();
  }
  async function openRound(id, side) {
    countdown.textContent = String(options.roundSeconds ?? '9,8');
    if (options.clearAmountEachRound) { amount.value = '0.00'; committedStake = 0; }
    if (options.siteLayout) {
      const pending = worker.read().session?.pending;
      if (pending?.status === 'accepted' && pending.side === Core.normalizeSide(side) && !config.dryRun) {
        balance.textContent = String((Core.cents(balance.textContent, 'Balance', true) + 2 * pending.amountCents) / 100);
      }
      const icon = new Element('div');
      icon.classList = Object.assign([`coin-${side.toLowerCase()}`], { contains: token => token === `coin-${side.toLowerCase()}` });
      if (options.direction === 'first') history = [icon, ...(options.animatedHistory ? history : history.slice(0, -1))];
      else history = [...(options.animatedHistory ? history : history.slice(1)), icon];
      countdown.isConnected = true;
      t.attrs.disable = 'false'; ct.attrs.disable = 'false';
    } else { result.attrs['data-round-id'] = String(id); result.attrs['data-side'] = side; }
    ownT.textContent = options.commaDecimal ? '0,00' : '0';
    ownCT.textContent = options.commaDecimal ? '0,00' : '0';
    t.disabled = false; ct.disabled = false; clock += 100;
    if (options.siteHealth) { initialized = true; roundState = 'rolling'; siteRoundId = id; notifySite('rolling'); }
    tick(); await flush(); clock += 1200; tick(); await flush();
    if (options.animatedHistory) {
      history = options.direction === 'first' ? history.slice(0, 10) : history.slice(-10);
      clock += 500; tick(); await flush(); clock += 500; tick(); await flush();
    }
  }
  async function complete(id, side) { await closeRound(); await openRound(id, side); }
  return { worker, complete, closeRound, openRound, tick, result, get amount() { return amount; }, ownT, ownCT, t, ct, countdown, balance, wheel, events, clicked: () => clicked,
    inspect: alternate => worker.tabs.sendMessage(1, { action: 'inspect', config: alternate || config }), config,
    toolbar: toolbarCallbacks, toolbarState: () => clone(toolbarState), inputEvents, clickedAmounts,
    inputFocusedAtBet, warnings, messages,
    watchdog: () => watchdogTick(),
    async siteState(values) {
      if (Object.hasOwn(values, 'initialized')) initialized = values.initialized;
      if (Object.hasOwn(values, 'roundState')) roundState = values.roundState;
      if (Object.hasOwn(values, 'roundId')) siteRoundId = values.roundId;
      if (values.animationMs) notifySite('SOCKET_ROULETTE_spin', { animationTimer: values.animationMs });
      else notifySite(values.initialized === false ? 'SOCKET_ROULETTE_disconnect' : 'rolling');
      await flush();
    },
    async timer(value) { countdown.isConnected = true; countdown.textContent = String(value); watchdogTick(); tick(); await flush(); },
    async loading(value) { pageLoading = value; tick(); await flush(); },
    restoreForFinalCheck(selector) { pageLoading = false; missingForOneRead = selector; },
    async hidden(value) { document.hidden = value; visibilityListener(); await flush(); },
    async reload() { bootContent(); await flush(); clock += 1200; tick(); await flush(); clock += 1000; tick(); await flush(); tick(); await flush(); },
    async advance(milliseconds) {
      if (options.manualTimers) {
        const end = clock + milliseconds;
        while (true) {
          timers.sort((left, right) => left.at - right.at);
          if (!timers.length || timers[0].at > end) break;
          const next = timers.shift(); clock = next.at; next.callback(); watchdogTick(); await flush();
        }
        clock = end;
      } else clock += milliseconds;
      watchdogTick(); tick(); await flush();
    } };
}

function recoveryFixture(target = 'T', mode = 'accepted') {
  const other = target === 'T' ? 'CT' : 'T';
  const history = [target, 'Dice', other, other, other];
  const config = Core.settings({ betAmount: .01, turnsWait: 3, stopLoss: 10, dryRun: false });
  const state = Core.create(config, 1, 'doc-1', 'recovery-session', history, 'last', 10000);
  const bet = Core.observe(state, { phase: 'open', side: other, openKey: 'saved-open', resultKey: 'saved-result',
    controlsReady: true, placementWindow: 'ready' }, randomUUID);
  Core.acknowledge(state, bet.id, 'submitted');
  if (mode !== 'submitted') Core.acknowledge(state, bet.id, 'accepted');
  if (mode === 'chase') { state.pending = null; state.nextBetCents = 4; state.netLossCents = 3; state.losses = 2; }
  Core.checkpoint(state, { phase: 'open', history, historyDirection: 'last', seconds: 25, hasWheel: true }, 10000);
  Core.loading(state, 'Loading', 11000);
  const page = (results = history, seconds = 22) => ({ phase: 'open', history: results, historyDirection: 'last',
    seconds, hasWheel: true, openKey: 'recovered-open', resultKey: 'recovered-result' });
  return { state, history, page, other };
}

(async () => {
  await test('recovery in the same betting window preserves an accepted stake without clicking or settling it twice', () => {
    const { state, page } = recoveryFixture();
    const id = state.pending.id;
    assert.equal(Core.recover(state, page(), 13000), true);
    assert.equal(state.active, true); assert.equal(state.pending.id, id); assert.equal(state.netLossCents, 0);
    assert.equal(state.nextBetCents, 1); assert.equal(state.recovery, null);
    assert.equal(Core.observe(state, { phase: 'open', side: 'CT', openKey: 'recovered-open', resultKey: 'recovered-result', controlsReady: true }, randomUUID), null);
  });
  await test('a recovered accepted Dice loss doubles once on either coin; a recovered accepted win resets the stake', () => {
    for (const side of ['T', 'CT']) for (const result of ['Dice', side]) {
      const { state, history, page } = recoveryFixture(side);
      assert.equal(Core.recover(state, page([...history.slice(1), result]), 13000), true);
      assert.equal(state.pending, null); assert.equal(state.active, true);
      assert.equal(state.nextBetCents, result === side ? 1 : 2);
      assert.equal(state.netLossCents, result === side ? -1 : 1);
      assert.equal(state.wins, result === side ? 1 : 0); assert.equal(state.losses, result === side ? 0 : 1);
    }
  });
  await test('a required next betting window missed during losing rolls aborts without fabricating additional losses or doubling', () => {
    for (const mode of ['accepted', 'chase']) {
      const { state, history, page } = recoveryFixture('T', mode);
      const before = state.netLossCents;
      const after = [...history.slice(2), 'CT', 'Dice'];
      assert.equal(Core.recover(state, page(after), 22000), false);
      assert.equal(state.active, false); assert.equal(state.nextBetCents, mode === 'accepted' ? 2 : 4);
      assert.equal(state.netLossCents, before + (mode === 'accepted' ? 1 : 0));
      assert.match(state.status, /next T betting window closed/); assert.equal(state.pending, null);
    }
  });
  await test('a winning opportunity missed during a chase stops betting, while still settling a known previous loss', () => {
    for (const mode of ['accepted', 'chase']) {
      const { state, history, page } = recoveryFixture('T', mode);
      const before = state.netLossCents;
      const after = [...history.slice(2), 'Dice', 'T'];
      assert.equal(Core.recover(state, page(after), 22000), false);
      assert.equal(state.active, false); assert.match(state.status, /next T betting window closed/);
      assert.equal(state.netLossCents, before + (mode === 'accepted' ? 1 : 0));
      assert.equal(state.wins, 0); assert.equal(state.pending, null);
    }
  });
  await test('recovered losses continue in the immediately following open window and abort after any further unbet result on either coin', () => {
    for (const side of ['T', 'CT']) {
      const stillOpen = recoveryFixture(side);
      const afterLoss = [...stillOpen.history.slice(1), 'Dice'];
      assert.equal(Core.recover(stillOpen.state, stillOpen.page(afterLoss), 13000), true);
      const next = Core.observe(stillOpen.state, { phase: 'open', side: 'Dice', openKey: 'recovered-open', resultKey: 'recovered-result',
        controlsReady: true, placementWindow: 'ready' }, randomUUID);
      assert.ok(next); assert.equal(next.side, side); assert.equal(next.amountCents, 2);
      assert.equal(stillOpen.state.active, true); assert.equal(stillOpen.state.losses, 1);
      for (const unbetResult of ['Dice', 'T', 'CT']) {
        const missed = recoveryFixture(side);
        const after = [...missed.history.slice(2), 'Dice', unbetResult];
        assert.equal(Core.recover(missed.state, missed.page(after), 22000), false);
        assert.equal(missed.state.active, false); assert.match(missed.state.status, /betting window closed/);
        assert.equal(missed.state.losses, 1); assert.equal(missed.state.wins, 0); assert.equal(missed.state.netLossCents, 1);
        assert.equal(missed.state.nextBetCents, 2); assert.equal(missed.state.pending, null);
      }
    }
  });
  await test('closed recovery aborts an unplaced doubled stake but never mistakes an accepted current spin or an unbet startup for the next window', () => {
    for (const side of ['T', 'CT']) {
      const chase = recoveryFixture(side, 'chase');
      assert.equal(Core.recover(chase.state, { phase: 'closed' }, 13000), false);
      assert.equal(chase.state.active, false); assert.match(chase.state.status, /betting window closed/);
      assert.equal(chase.state.losses, 2); assert.equal(chase.state.netLossCents, 3); assert.equal(chase.state.nextBetCents, 4);
      const accepted = recoveryFixture(side);
      const betId = accepted.state.pending.id;
      assert.equal(Core.recover(accepted.state, { phase: 'closed' }, 13000), false);
      assert.equal(accepted.state.active, true); assert.ok(accepted.state.recovery); assert.equal(accepted.state.pending.id, betId);
      assert.equal(accepted.state.losses, 0);
    }
    const startup = Core.create(Core.settings(), 1, 'doc-1', 'startup');
    Core.loading(startup, 'Loading');
    assert.equal(Core.recover(startup, { phase: 'closed' }), false);
    assert.equal(startup.active, true); assert.ok(startup.recovery); assert.equal(startup.losses, 0);
  });
  await test('an accepted recovered win ends its progression so later unbet rounds do not trigger a doubled-window abort', () => {
    for (const side of ['T', 'CT']) {
      const won = recoveryFixture(side);
      const previous = [side, side === 'T' ? 'CT' : 'T', 'Dice', side, side === 'T' ? 'CT' : 'T'];
      won.state.checkpoint.history = previous;
      won.state.missingRounds = Core.missingFromHistory(previous);
      const after = [...previous.slice(2), side, 'Dice'];
      assert.equal(Core.recover(won.state, won.page(after), 22000), true);
      assert.equal(won.state.active, true); assert.equal(won.state.pending, null); assert.equal(won.state.chaseSide, null);
      assert.equal(won.state.wins, 1); assert.equal(won.state.losses, 0); assert.equal(won.state.netLossCents, -1);
      assert.equal(won.state.nextBetCents, 1);
    }
  });
  await test('ambiguous or overwritten history and unconfirmed submitted stakes stop recovery without invented outcomes', () => {
    for (const scenario of ['ambiguous', 'overwritten', 'submitted']) {
      const { state, page } = recoveryFixture('T', scenario === 'submitted' ? 'submitted' : 'accepted');
      if (scenario === 'ambiguous') state.checkpoint.history = ['CT', 'CT', 'CT'];
      const after = scenario === 'ambiguous' ? ['CT', 'CT', 'T'] : scenario === 'overwritten' ? ['Dice', 'Dice', 'Dice', 'Dice', 'Dice'] : state.checkpoint.history;
      assert.equal(Core.recover(state, page(after), 13000), false);
      assert.equal(state.active, false); assert.equal(state.needsReview, true);
      assert.equal(state.netLossCents, 0); assert.equal(state.wins, 0); assert.equal(state.losses, 0);
      assert.ok(state.pending);
      const pending = clone(state.pending);
      round(state, 10, 'T'); assert.deepEqual(state.pending, pending);
    }
  });
  await test('unmatched history with no outstanding bet or losing progression resumes from a fresh baseline and preserves settled profit', () => {
    const history = ['T', 'Dice', 'CT', 'CT', 'CT'];
    const state = Core.create(Core.settings({ betAmount: .01, turnsWait: 50 }), 1, 'doc-1', 'safe-recovery', history, 'last', 10000);
    Core.observe(state, { phase: 'open', side: 'CT', openKey: 'saved-open', resultKey: 'saved-result', controlsReady: true }, randomUUID);
    state.wins = 2; state.losses = 1; state.netLossCents = -3;
    Core.checkpoint(state, { phase: 'open', history, seconds: 10, hasWheel: true }, 10000);
    Core.loading(state, 'Loading', 11000);
    const after = ['Dice', 'Dice', 'Dice', 'Dice', 'Dice'];
    assert.equal(Core.recover(state, { phase: 'open', history: after, seconds: 25, hasWheel: true,
      openKey: 'restored-open', resultKey: 'restored-result' }, 60000), true);
    assert.equal(state.active, true); assert.equal(state.recovery, null); assert.equal(state.pending, null);
    assert.deepEqual(state.missingRounds, { T: 5, CT: 5 }); assert.equal(state.rounds, 0);
    assert.equal(state.wins, 2); assert.equal(state.losses, 1); assert.equal(state.netLossCents, -3);
    assert.equal(state.startedAt, 10000); assert.equal(state.nextBetCents, 1);
  });
  await test('unreadable history with no bet stays in recovery and retries without stopping or inventing counters', () => {
    const state = Core.create(Core.settings({ turnsWait: 50 }), 1, 'doc-1', 'empty-history', ['CT', 'CT']);
    Core.loading(state, 'Loading');
    assert.equal(Core.recover(state, { phase: 'open', history: [], openKey: 'bad-open', resultKey: 'bad-result' }), false);
    assert.equal(state.active, true); assert.ok(state.recovery); assert.equal(state.needsReview, undefined);
    assert.deepEqual(state.missingRounds, { T: 2, CT: 0 }); assert.equal(state.losses, 0);
    assert.equal(Core.recover(state, { phase: 'open', history: ['T', 'CT', 'CT'], seconds: 25,
      openKey: 'good-open', resultKey: 'good-result' }), true);
    assert.equal(state.recovery, null); assert.deepEqual(state.missingRounds, { T: 2, CT: 0 });
  });
  await test('an unclicked first reservation interrupted by loading is not a losing progression, while a doubled stake retains its coin', () => {
    const first = recoveryFixture('T', 'submitted');
    first.state.pending.status = 'reserved'; first.state.recovery = null;
    Core.loading(first.state, 'Controls disappeared', 12000);
    assert.equal(first.state.pending, null); assert.equal(first.state.chaseSide, null);
    const after = [...first.history.slice(1), 'T'];
    assert.equal(Core.recover(first.state, first.page(after), 13000), true);
    assert.equal(first.state.active, true); assert.equal(first.state.losses, 0); assert.equal(first.state.wins, 0);
    assert.equal(first.state.netLossCents, 0); assert.equal(first.state.nextBetCents, 1);
    const doubled = recoveryFixture('CT', 'chase');
    assert.equal(Core.recover(doubled.state, doubled.page(), 13000), true);
    const bet = Core.observe(doubled.state, { phase: 'open', side: 'T', openKey: 'recovered-open', resultKey: 'recovered-result',
      controlsReady: true, placementWindow: 'ready' }, randomUUID);
    assert.ok(bet);
    Core.loading(doubled.state, 'Controls disappeared', 14000);
    assert.equal(doubled.state.pending, null); assert.equal(doubled.state.chaseSide, 'CT'); assert.equal(doubled.state.nextBetCents, 4);
    assert.equal(Core.recover(doubled.state, doubled.page(doubled.history, 20), 15000), true);
    assert.equal(doubled.state.active, true); assert.equal(doubled.state.losses, 2); assert.equal(doubled.state.netLossCents, 3);
  });
  await test('an overwritten history during an actual losing progression still stops even with no current bet outstanding', () => {
    const { state, page } = recoveryFixture('T', 'chase');
    assert.equal(Core.recover(state, page(['Dice', 'Dice', 'Dice', 'Dice', 'Dice']), 60000), false);
    assert.equal(state.active, false); assert.match(state.status, /history cannot be matched/);
    assert.equal(state.losses, 2); assert.equal(state.netLossCents, 3); assert.equal(state.nextBetCents, 4);
  });
  await test('Stop during loading can settle an outstanding accepted loss but never resumes or reserves a bet', () => {
    const { state, history, page } = recoveryFixture();
    Core.stop(state, 12000);
    assert.equal(Core.recover(state, page([...history.slice(1), 'Dice']), 13000), true);
    assert.equal(state.active, false); assert.equal(state.losses, 1); assert.equal(state.pending, null);
    const bet = Core.observe(state, { phase: 'open', side: 'Dice', openKey: 'recovered-open', resultKey: 'recovered-result', controlsReady: true }, randomUUID);
    assert.equal(bet, null); assert.equal(state.status, 'Stopped');
  });
  await test('reload checkpoints survive worker restart and transfer ownership only to the same tab and page', async () => {
    const { state, history, page } = recoveryFixture();
    state.pageUrl = 'https://csgoempire.com/'; state.recovery = null;
    const worker = workerHarness({ config: state.config, session: state }, () => 13000);
    const owner = { documentId: 'doc-1', sessionId: state.id };
    assert.equal((await worker.dispatch({ action: 'pageUnavailable', ...owner }, worker.contentSender)).success, true);
    await worker.dispatch({ action: 'reloadPage', ...owner }, worker.contentSender);
    assert.deepEqual(worker.reloadCalls, [1]); assert.equal(worker.read().session.pending.id, state.pending.id);
    worker.boot();
    await worker.dispatch({ action: 'hello', documentId: 'new-doc' }, worker.contentSender);
    assert.equal(worker.read().session.active, true); assert.equal(worker.read().session.documentId, 'new-doc');
    assert.equal((await worker.dispatch({ action: 'observe', ...owner, observation: { phase: 'closed' } }, worker.contentSender)).success, false);
    const recovery = await worker.dispatch({ action: 'recoverPage', ...owner, documentId: 'new-doc', page: page([...history.slice(1), 'Dice']) }, worker.contentSender);
    assert.equal(recovery.success, true); assert.equal(recovery.session.nextBetCents, 2); assert.equal(recovery.session.losses, 1);
    const response = await worker.dispatch({ action: 'observe', ...owner, documentId: 'new-doc', observation: {
      phase: 'open', side: 'Dice', openKey: 'recovered-open', resultKey: 'recovered-result', controlsReady: true, placementWindow: 'ready'
    } }, worker.contentSender);
    assert.equal(response.instruction.amountCents, 2);
    const duplicate = await worker.dispatch({ action: 'observe', ...owner, documentId: 'new-doc', observation: {
      phase: 'open', side: 'Dice', openKey: 'recovered-open', resultKey: 'recovered-result', controlsReady: true, placementWindow: 'ready'
    } }, worker.contentSender);
    assert.equal(duplicate.instruction, null);
  });
  await test('reload recovery rejects foreign controllers, avoids loops, and does not reload an unconfirmed money action', async () => {
    for (const mode of ['accepted', 'submitted']) {
      const { state } = recoveryFixture('T', mode);
      const worker = workerHarness({ config: state.config, session: state }, () => 13000);
      const request = { action: 'reloadPage', documentId: 'doc-1', sessionId: state.id };
      assert.equal((await worker.dispatch(request, { ...worker.contentSender, tab: { ...worker.contentSender.tab, id: 2 } })).success, false);
      await worker.dispatch(request, worker.contentSender);
      assert.equal(worker.reloadCalls.length, mode === 'accepted' ? 1 : 0);
      if (mode === 'accepted') {
        await worker.dispatch(request, worker.contentSender);
        assert.equal(worker.reloadCalls.length, 1); assert.equal(worker.read().session.active, true);
        assert.equal(worker.read().session.pending.id, state.pending.id);
      }
    }
    const { state } = recoveryFixture(); state.recovery = null; state.pageUrl = 'https://csgoempire.com/roulette';
    const worker = workerHarness({ config: state.config, session: state });
    await worker.dispatch({ action: 'hello', documentId: 'different-page' }, worker.contentSender);
    assert.equal(worker.read().session.active, false);
  });
  await test('the site blur model receives one-cent and doubled stakes even when native focus does nothing', async () => {
    for (const target of ['T', 'CT']) {
      for (const focusUnavailable of [true, false]) {
        const other = target === 'T' ? 'CT' : 'T';
        const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true,
          siteBlurModel: true, focusUnavailable, betAmount: '0,01', turnsWait: 3,
          initialAmount: '77.77', initialHistory: [other, other, other] });
        assert.deepEqual(page.clickedAmounts, [1]);
        assert.equal(page.amount.value, '0.01');
        assert.equal(page.worker.read().session.pending.status, 'accepted');
        await page.complete(1, 'bonus');
        assert.deepEqual(page.clickedAmounts, [1, 2]);
        assert.equal(page.amount.value, '0.02');
        await page.complete(2, target.toLowerCase());
        assert.equal(page.worker.read().session.wins, 1);
        assert.equal(page.worker.read().session.netLossCents, -1);
      }
    }
  });
  await test('a visually correct amount with a zero internal stake never reaches the Bet button', async () => {
    const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true,
      siteBlurModel: true, ignoreModelUpdates: true, betAmount: '0.01', turnsWait: 1,
      initialHistory: ['CT', 'CT'] });
    assert.equal(page.amount.value, '0.01');
    assert.equal(page.clicked(), 0);
    const state = page.worker.read().session;
    assert.equal(state.active, false);
    assert.equal(state.pending, null);
    assert.equal(state.netLossCents, 0);
    assert.match(state.status, /stored stake is 0/);
    assert.equal(page.warnings[0][1].siteStake, 0);
  });
  await test('a stored stake reset during the submitted reply is caught before any money click', async () => {
    const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true,
      siteBlurModel: true, resetStoredStakeAfterSubmit: true, betAmount: '0.01', turnsWait: 1,
      initialHistory: ['CT', 'CT'] });
    assert.equal(page.amount.value, '0.01');
    assert.equal(page.clicked(), 0);
    assert.equal(page.worker.read().session.pending, null);
    assert.equal(page.worker.read().session.netLossCents, 0);
    assert.match(page.worker.read().session.status, /stored stake is 0/);
  });
  await test('missing or unsupported site stake checks prevent money clicks and leave simulation usable', async () => {
    for (const probeOptions of [{ noStakeProbe: true }, { missingStakeStore: true }]) {
      const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true,
        betAmount: '0.01', turnsWait: 1, initialHistory: ['CT', 'CT'], ...probeOptions });
      assert.equal(page.clicked(), 0);
      assert.equal(page.worker.read().session.active, false);
      assert.equal(page.worker.read().session.pending, null);
      assert.match(page.worker.read().session.status, /No bet clicked/i);
      const simulation = await contentHarness({ siteLayout: true, seedHistory: true,
        turnsWait: 1, initialHistory: ['CT', 'CT'], ...probeOptions });
      assert.equal(simulation.worker.read().session.pending.status, 'accepted');
      assert.equal(simulation.clicked(), 0);
    }
  });
  await test('one-cent and doubled stakes synchronize a click-activated or debounced widget before Bet', async () => {
    for (const option of [{ requiresClickBeforeInput: true }, { commitAfterDebounce: 600 }]) {
      const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true, betAmount: .01, turnsWait: 3,
        initialHistory: ['T', 'Dice', 'CT', 'CT', 'CT'], clearAmountEachRound: true, ...option });
      assert.deepEqual(page.clickedAmounts, [1]); assert.equal(page.worker.read().session.pending.status, 'accepted');
      await page.complete(1, 'dice');
      assert.deepEqual(page.clickedAmounts, [1, 2]); assert.deepEqual(page.inputFocusedAtBet, [false, false]);
    }
  });
  await test('a replaced input defers preparation without clicking or losing the chase, and a blocked edit never clicks', async () => {
    const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true, betAmount: .01, turnsWait: 3,
      initialHistory: ['T', 'Dice', 'CT', 'CT', 'CT'], commitOnAmountClick: true, replaceInputOnBlur: true });
    assert.equal(page.clicked(), 0); assert.equal(page.worker.read().session.active, true);
    assert.equal(page.worker.read().session.pending, null); assert.ok(page.worker.read().session.recovery);
    await page.advance(1200); await page.advance(1200); page.tick(); await flush();
    assert.deepEqual(page.clickedAmounts, [1], JSON.stringify(page.worker.read().session)); assert.equal(page.worker.read().session.pending.status, 'accepted');
    const blocked = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true, betAmount: .01, turnsWait: 3,
      initialHistory: ['T', 'Dice', 'CT', 'CT', 'CT'], blockBeforeInput: true });
    assert.equal(blocked.clicked(), 0); assert.equal(blocked.worker.read().session.active, false);
    assert.match(blocked.worker.read().session.status, /blocked amount entry/);
  });
  await test('missing controls request an immediate reload and preserve an accepted bet without a duplicate click', async () => {
    const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true, betAmount: .01, turnsWait: 3,
      initialHistory: ['T', 'Dice', 'CT', 'CT', 'CT'] });
    await page.loading(true); assert.equal(page.worker.read().session.active, true);
    assert.deepEqual(page.worker.reloadCalls, [1], 'Reload must be requested on the first missing-control observation.');
    assert.match(page.worker.read().session.status, /Loading/);
    await page.advance(500); await page.loading(false); await page.advance(1000); page.tick(); await flush();
    assert.equal(page.worker.reloadCalls.length, 1); assert.equal(page.clicked(), 1);
    assert.equal(page.worker.read().session.recovery, null); assert.equal(page.worker.read().session.pending.status, 'accepted');
    await page.complete(1, 'dice'); assert.deepEqual(page.clickedAmounts, [1, 2]);
  });
  await test('loading immediately requests one reload and a new content document retains the accepted stake', async () => {
    const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true, betAmount: .01, turnsWait: 3,
      initialHistory: ['T', 'Dice', 'CT', 'CT', 'CT'] });
    const saved = page.worker.read().session;
    await page.loading(true); await page.advance(2100);
    assert.deepEqual(page.worker.reloadCalls, [1]); assert.equal(page.worker.read().session.id, saved.id);
    await page.loading(false); await page.reload();
    const restored = page.worker.read().session;
    assert.notEqual(restored.documentId, saved.documentId); assert.equal(restored.active, true);
    assert.equal(restored.pending.id, saved.pending.id); assert.equal(restored.recovery, null);
    assert.equal(page.clicked(), 1); assert.equal(restored.losses, 0);
    await page.complete(1, 'dice'); assert.deepEqual(page.clickedAmounts, [1, 2]);
  });
  await test('a loss completed while controls are missing is reconciled once before placing the doubled bet', async () => {
    for (const direction of ['first', 'last']) {
      const initialHistory = ['T', 'Dice', 'CT', 'CT', 'CT'];
      const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true, betAmount: .01, turnsWait: 3,
        direction, initialHistory: direction === 'first' ? [...initialHistory].reverse() : initialHistory });
      await page.loading(true); await page.openRound(1, 'dice'); await page.loading(false);
      await page.advance(1000); page.tick(); await flush();
      const state = page.worker.read().session;
      assert.equal(state.active, true); assert.equal(state.losses, 1); assert.equal(state.netLossCents, 1);
      assert.deepEqual(page.clickedAmounts, [1, 2]); assert.equal(state.pending.side, 'T');
    }
  });
  await test('Stop during page loading prevents additional reloads and every subsequent money click', async () => {
    const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true, betAmount: .01, turnsWait: 3,
      initialHistory: ['T', 'Dice', 'CT', 'CT', 'CT'] });
    await page.loading(true); await page.worker.dispatch({ action: 'stopBot' });
    await page.advance(2100); assert.equal(page.worker.reloadCalls.length, 1);
    await page.loading(false); await page.advance(1000); page.tick(); await flush();
    await page.complete(1, 'dice');
    assert.equal(page.clicked(), 1); assert.equal(page.worker.read().session.active, false);
    assert.equal(page.worker.read().session.losses, 1);
  });
  await test('hidden-tab zero layout rectangles do not make connected visible controls disappear or stop the progression', async () => {
    const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true, betAmount: .01, turnsWait: 3,
      initialHistory: ['T', 'Dice', 'CT', 'CT', 'CT'], zeroRectsHidden: true });
    await page.hidden(true); await page.advance(1000); await page.advance(1000);
    assert.equal(page.worker.read().session.active, true); assert.equal(page.clicked(), 1);
    await page.complete(1, 'dice'); assert.deepEqual(page.clickedAmounts, [1, 2]);
    assert.equal(page.worker.read().session.pending.status, 'accepted'); assert.equal(page.worker.reloadCalls.length, 0);
  });
  await test('missing confirmation after a money click reloads immediately and retains the unconfirmed bet for review', async () => {
    const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true, betAmount: .01, turnsWait: 3,
      initialHistory: ['T', 'Dice', 'CT', 'CT', 'CT'], hideBalanceOnClick: 1800 });
    assert.equal(page.clicked(), 1); assert.equal(page.worker.read().session.active, false);
    assert.deepEqual(page.worker.reloadCalls, [1]); assert.equal(page.worker.read().session.needsReview, true);
    assert.equal(page.worker.read().session.pending.status, 'submitted'); assert.equal(page.worker.read().session.losses, 0);
    await page.advance(2000); await page.reload();
    assert.equal(page.clicked(), 1); assert.equal(page.worker.read().session.pending.status, 'submitted');
    assert.equal(page.worker.read().session.active, false); assert.equal(page.worker.read().session.needsReview, true);
  });
  await test('a doubled bet with too little preparation time aborts on closure without waiting for the unbet result', () => {
    const { state, history, page } = recoveryFixture('T', 'chase');
    Core.recover(state, page(history, 4), 13000);
    const opening = { phase: 'open', side: 'CT', openKey: 'recovered-open', resultKey: 'recovered-result',
      controlsReady: true, placementWindow: 'late' };
    assert.equal(Core.observe(state, opening, randomUUID), null);
    assert.equal(state.active, true); assert.ok(state.skippedChaseRoundKey); assert.equal(state.nextBetCents, 4);
    Core.observe(state, { phase: 'closed' }, randomUUID);
    assert.equal(state.active, false); assert.match(state.status, /next T betting window closed/);
    assert.equal(round(state, 1, 'T', false), null);
    assert.equal(state.active, false); assert.match(state.status, /next T betting window closed/);
    assert.equal(state.wins, 0); assert.equal(state.netLossCents, 3); assert.equal(state.losses, 2);
  });
  await test('a required doubled window missed while waiting aborts even when the following unbet result is Dice', () => {
    const { state, history, page } = recoveryFixture('T', 'chase');
    Core.recover(state, page(history), 13000);
    Core.observe(state, { phase: 'open', side: 'CT', openKey: 'recovered-open', resultKey: 'recovered-result',
      controlsReady: true, placementWindow: 'waiting', betAtSeconds: 10 }, randomUUID);
    Core.observe(state, { phase: 'closed' }, randomUUID);
    assert.equal(state.active, false); assert.match(state.status, /next T betting window closed/);
    const bet = round(state, 1, 'Dice');
    assert.equal(bet, null); assert.equal(state.nextBetCents, 4); assert.equal(state.losses, 2); assert.equal(state.netLossCents, 3);
    const next = round(state, 2, 'CT'); assert.equal(next, null);
    assert.equal(state.losses, 2); assert.equal(state.netLossCents, 3);
  });
  await test('a missed winning opportunity during a page gap stops the content adapter instead of following the chase', async () => {
    const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true, betAmount: .01, turnsWait: 3,
      initialHistory: ['T', 'Dice', 'CT', 'CT', 'CT'] });
    await page.loading(true); await page.openRound(1, 'dice'); await page.openRound(2, 't');
    await page.loading(false); await page.advance(1000); page.tick(); await flush();
    const state = page.worker.read().session;
    assert.equal(state.active, false); assert.match(state.status, /next T betting window closed/);
    assert.equal(state.losses, 1); assert.equal(state.wins, 0); assert.equal(state.netLossCents, 1);
    assert.equal(page.clicked(), 1);
  });
  await test('a failed reload requires two fresh delayed failure checks and retains the outstanding stake for review without a reload loop', async () => {
    const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true, betAmount: .01, turnsWait: 3,
      initialHistory: ['T', 'Dice', 'CT', 'CT', 'CT'] });
    await page.loading(true); await page.advance(2100); await page.advance(15000);
    assert.equal(page.worker.read().session.active, true, 'The first final failure check alone must not stop a bet.');
    await page.advance(749); assert.equal(page.worker.read().session.active, true);
    await page.advance(1);
    const state = page.worker.read().session;
    assert.equal(state.active, false); assert.equal(state.needsReview, true); assert.ok(state.pending);
    assert.equal(state.losses, 0); assert.equal(page.clicked(), 1); assert.deepEqual(page.worker.reloadCalls, [1]);
    const reports = page.messages.filter(message => message.action === 'recoveryFailed');
    assert.equal(reports.length, 1); assert.match(reports[0].request.error, /found no visible elements/);
  });
  await test('a failed reload with no placed bet keeps running and resumes after the page returns, without fake wins or losses', async () => {
    const page = await contentHarness({ siteLayout: true, siteHealth: true, dryRun: false, seedHistory: true, betAmount: .01,
      turnsWait: 50, initialHistory: ['T', 'Dice', 'CT', 'CT', 'CT'] });
    const saved = page.worker.read().session;
    await page.loading(true); await page.reload(); await page.advance(16000); await page.advance(750);
    assert.equal(page.worker.read().session.active, true); assert.ok(page.worker.read().session.recovery);
    assert.equal(page.worker.read().session.pending, null); assert.match(page.worker.read().session.status, /Waiting for roulette to recover/);
    await page.advance(20000);
    assert.equal(page.messages.filter(message => message.action === 'recoveryFailed').length, 1);
    await page.loading(false); await page.advance(1000);
    const restored = page.worker.read().session;
    assert.equal(restored.active, true); assert.equal(restored.recovery, null); assert.equal(restored.id, saved.id);
    assert.equal(restored.startedAt, saved.startedAt); assert.notEqual(restored.documentId, saved.documentId);
    assert.equal(restored.losses, 0); assert.equal(restored.wins, 0); assert.equal(restored.netLossCents, 0);
    assert.equal(page.clicked(), 0); assert.deepEqual(page.worker.reloadCalls, [1]);
  });
  await test('a healthy final page read overrides a transient missing-control observation after the old timeout', async () => {
    const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true, betAmount: .01, turnsWait: 3,
      initialHistory: ['T', 'Dice', 'CT', 'CT', 'CT'], initialSeconds: 25 });
    await page.timer(9.8); // Place one accepted stake, then expose a longer saved countdown.
    await page.timer(25);
    const betId = page.worker.read().session.pending.id;
    await page.loading(true); await page.advance(16000);
    page.restoreForFinalCheck(Core.DEFAULTS.selectors.tButton);
    await page.advance(750);
    assert.equal(page.worker.read().session.active, true);
    assert.equal(page.messages.filter(message => message.action === 'recoveryFailed').length, 0);
    await page.advance(1000);
    assert.equal(page.worker.read().session.recovery, null); assert.equal(page.worker.read().session.pending.id, betId);
    assert.equal(page.clicked(), 1); assert.equal(page.worker.read().session.losses, 0);
  });
  await test('returning controls during a legitimate spin clear the earlier failure clock instead of timing out after reload', async () => {
    const page = await contentHarness({ siteLayout: true, siteHealth: true, dryRun: false, seedHistory: true, betAmount: .01, turnsWait: 3,
      initialHistory: ['T', 'Dice', 'CT', 'CT', 'CT'] });
    await page.loading(true); await page.advance(14000);
    await page.closeRound(); await page.loading(false);
    await page.advance(10000); await page.advance(750);
    assert.equal(page.worker.read().session.active, true, 'A later spin stall has its own failure window.');
    assert.equal(page.messages.filter(message => message.action === 'recoveryFailed').length, 0);
    await page.openRound(1, 'dice'); await page.advance(1000);
    assert.equal(page.worker.read().session.active, true); assert.equal(page.worker.read().session.losses, 1);
    assert.deepEqual(page.clickedAmounts, [1, 2]); assert.deepEqual(page.worker.reloadCalls, [1]);
  });
  await test('a delayed recovery-failure message cannot stop a recovered session or a newer interruption', async () => {
    const { state, page } = recoveryFixture(); state.recovery.reloads = 1;
    let now = 13000;
    const worker = workerHarness({ config: state.config, session: state }, () => now);
    const owner = { documentId: state.documentId, sessionId: state.id };
    const delayed = { action: 'recoveryFailed', ...owner, recoverySince: state.recovery.since, error: 'Old failure' };
    await worker.dispatch({ action: 'recoverPage', ...owner, page: page() }, worker.contentSender);
    await worker.dispatch(delayed, worker.contentSender);
    assert.equal(worker.read().session.active, true); assert.equal(worker.read().session.recovery, null);
    now = 14000;
    await worker.dispatch({ action: 'pageUnavailable', ...owner, error: 'New interruption', reload: true }, worker.contentSender);
    await worker.dispatch(delayed, worker.contentSender);
    assert.equal(worker.read().session.active, true); assert.equal(worker.read().session.recovery.since, 14000);
    assert.equal(worker.read().session.pending.status, 'accepted'); assert.equal(worker.read().session.needsReview, undefined);
  });
  await test('a recovery failure with no current bet preserves a doubled progression until its readable history can be reconciled', async () => {
    const { state, history, page } = recoveryFixture('CT', 'chase'); state.recovery.reloads = 1;
    const worker = workerHarness({ config: state.config, session: state }, () => 26000);
    const owner = { documentId: state.documentId, sessionId: state.id };
    await worker.dispatch({ action: 'recoveryFailed', ...owner, recoverySince: state.recovery.since, error: 'Still loading' }, worker.contentSender);
    assert.equal(worker.read().session.active, true); assert.ok(worker.read().session.recovery);
    assert.equal(worker.read().session.nextBetCents, 4); assert.equal(worker.read().session.chaseSide, 'CT');
    assert.equal(worker.read().session.losses, 2); assert.equal(worker.read().session.netLossCents, 3);
    const recovered = await worker.dispatch({ action: 'recoverPage', ...owner, page: page(history, 8) }, worker.contentSender);
    assert.equal(recovered.session.active, true); assert.equal(recovered.session.recovery, null);
    assert.equal(recovered.session.nextBetCents, 4); assert.equal(recovered.session.losses, 2);
  });
  await test('a known loss waiting for its doubled bet aborts as soon as the following window closes with no extra click or loss', async () => {
    for (const side of ['T', 'CT']) {
      const other = side === 'T' ? 'CT' : 'T';
      const page = await contentHarness({ siteLayout: true, siteHealth: true, dryRun: false, seedHistory: true,
        betAmount: .01, turnsWait: 3, initialHistory: [side, 'Dice', other, other, other], roundSeconds: 25 });
      await page.complete(1, 'dice');
      assert.equal(page.worker.read().session.active, true); assert.equal(page.worker.read().session.losses, 1);
      assert.equal(page.worker.read().session.pending, null); assert.equal(page.worker.read().session.nextBetCents, 2);
      await page.closeRound();
      const stopped = page.worker.read().session;
      assert.equal(stopped.active, false); assert.match(stopped.status, /betting window closed/);
      assert.equal(stopped.losses, 1); assert.equal(stopped.netLossCents, 1); assert.deepEqual(page.clickedAmounts, [1]);
      await page.openRound(2, 'dice'); assert.deepEqual(page.clickedAmounts, [1]);
      assert.equal(page.worker.read().session.losses, 1);
    }
  });
  await test('the recovery watchdog aborts a known unplaced doubled stake when returning controls prove its window is closed', async () => {
    const page = await contentHarness({ siteLayout: true, siteHealth: true, dryRun: false, seedHistory: true,
      betAmount: .01, turnsWait: 3, initialHistory: ['T', 'Dice', 'CT', 'CT', 'CT'], roundSeconds: 25 });
    await page.complete(1, 'dice');
    await page.loading(true);
    assert.equal(page.worker.read().session.active, true); assert.ok(page.worker.read().session.recovery);
    await page.closeRound();
    page.restoreForFinalCheck(null); page.watchdog(); await flush();
    const stopped = page.worker.read().session;
    assert.equal(stopped.active, false); assert.equal(stopped.recovery, null);
    assert.match(stopped.status, /next T betting window closed/);
    assert.equal(stopped.losses, 1); assert.equal(stopped.netLossCents, 1); assert.equal(stopped.nextBetCents, 2);
    assert.deepEqual(page.clickedAmounts, [1]); assert.deepEqual(page.worker.reloadCalls, [1]);
  });
  await test('closure during doubled-stake preparation cancels the reservation and prevents a delayed money click', async () => {
    const page = await contentHarness({ siteLayout: true, siteHealth: true, dryRun: false, seedHistory: true,
      betAmount: .01, turnsWait: 3, initialHistory: ['T', 'Dice', 'CT', 'CT', 'CT'], roundSeconds: 25, manualTimers: true });
    await page.advance(2000); assert.deepEqual(page.clickedAmounts, [1]);
    await page.complete(1, 'dice'); await page.timer(9.8);
    assert.equal(page.worker.read().session.pending.status, 'reserved'); assert.equal(page.worker.read().session.pending.amountCents, 2);
    await page.closeRound();
    assert.equal(page.worker.read().session.active, false); assert.equal(page.worker.read().session.pending, null);
    assert.match(page.worker.read().session.status, /next T betting window closed/);
    await page.advance(2000); await page.openRound(2, 'dice');
    assert.deepEqual(page.clickedAmounts, [1]); assert.equal(page.worker.read().session.losses, 1);
    assert.equal(page.worker.read().session.netLossCents, 1);
  });
  await test('temporarily disabled controls and zero while the site still reports open never fabricate a closed doubled window', async () => {
    const page = await contentHarness({ siteLayout: true, siteHealth: true, dryRun: false, seedHistory: true,
      betAmount: .01, turnsWait: 3, initialHistory: ['T', 'Dice', 'CT', 'CT', 'CT'], roundSeconds: 25 });
    await page.complete(1, 'dice');
    page.t.attrs.disable = 'true'; page.ct.attrs.disable = 'true';
    await page.advance(1000);
    assert.equal(page.worker.read().session.active, true); assert.equal(page.worker.read().session.losses, 1);
    assert.equal(page.worker.read().session.pending, null); assert.deepEqual(page.worker.reloadCalls, []);
    await page.timer(0); await page.advance(1500);
    assert.equal(page.worker.read().session.active, true); assert.deepEqual(page.worker.reloadCalls, [1]);
    page.t.attrs.disable = 'false'; page.ct.attrs.disable = 'false';
    await page.timer(9.8); await page.advance(1000); page.tick(); await flush();
    assert.equal(page.worker.read().session.active, true); assert.equal(page.worker.read().session.recovery, null);
    assert.deepEqual(page.clickedAmounts, [1, 2]); assert.equal(page.worker.read().session.pending.status, 'accepted');
    await page.complete(2, 't');
    assert.equal(page.worker.read().session.active, true); assert.equal(page.worker.read().session.nextBetCents, 1);
    assert.equal(page.worker.read().session.wins, 1); assert.equal(page.worker.read().session.losses, 1);
  });
  await test('Stop while a no-bet recovery keeps waiting cancels automatic resume and additional reloads', async () => {
    const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true, turnsWait: 50,
      initialHistory: ['T', 'Dice', 'CT', 'CT', 'CT'] });
    await page.loading(true); await page.advance(16000); await page.advance(750);
    await page.toolbar.stop(); await page.loading(false); await page.advance(1000);
    await page.complete(1, 'dice'); await page.advance(20000);
    assert.equal(page.worker.read().session.active, false); assert.equal(page.worker.read().session.userStopped, true);
    assert.equal(page.clicked(), 0); assert.deepEqual(page.worker.reloadCalls, [1]);
    assert.equal(page.worker.read().session.netLossCents, 0);
  });
  await test('a round missed by the tab observer can be reconciled without a reload or a fabricated extra loss', async () => {
    const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true, betAmount: .01, turnsWait: 3,
      initialHistory: ['T', 'Dice', 'CT', 'CT', 'CT'] });
    await page.openRound(1, 'dice'); // No closed-phase observation was delivered.
    assert.ok(page.worker.read().session.recovery);
    await page.advance(1000); await page.advance(1000); page.tick(); await flush();
    const state = page.worker.read().session;
    assert.equal(state.active, true); assert.equal(state.losses, 1); assert.deepEqual(page.clickedAmounts, [1, 2]);
    assert.equal(page.worker.reloadCalls.length, 0);
  });
  await test('a missing or CSS-hidden wheel triggers immediate recovery even when the other controls remain', async () => {
    for (const change of ['detach', 'hide']) {
      const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true, betAmount: .01, turnsWait: 3,
        initialHistory: ['T', 'Dice', 'CT', 'CT', 'CT'] });
      if (change === 'detach') page.wheel.isConnected = false;
      else page.wheel.style.display = 'none';
      page.tick(); await flush();
      assert.deepEqual(page.worker.reloadCalls, [1]); assert.equal(page.worker.read().session.active, true);
      assert.equal(page.worker.read().session.pending.status, 'accepted'); assert.equal(page.clicked(), 1);
      assert.equal(page.worker.read().session.pending.sawClosed, false, 'Missing wheel is loading, not evidence of a completed spin.');
    }
  });
  await test('loading during preparation or click confirmation is handled immediately rather than waiting for the placement task', async () => {
    for (const clicked of [false, true]) {
      const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true, betAmount: .01, turnsWait: 3,
        initialHistory: ['T', 'Dice', 'CT', 'CT', 'CT'], manualTimers: true, accept: false });
      if (clicked) await page.advance(1350);
      await page.loading(true);
      assert.deepEqual(page.worker.reloadCalls, [1]); assert.equal(page.clicked(), clicked ? 1 : 0);
      const state = page.worker.read().session;
      assert.equal(state.active, !clicked); assert.equal(state.losses, 0); assert.equal(state.netLossCents, 0);
      if (clicked) { assert.equal(state.needsReview, true); assert.equal(state.pending.status, 'submitted'); }
      else assert.equal(state.pending, null);
    }
  });
  await test('review reload is single-use, keeps the submitted stake through document handoff, and honors a newer Stop', async () => {
    for (const stopped of [false, true]) {
      const { state } = recoveryFixture('T', 'submitted');
      const worker = workerHarness({ config: state.config, session: state });
      if (stopped) await worker.dispatch({ action: 'stopBot' });
      const request = { action: 'reloadPage', review: true, documentId: 'doc-1', sessionId: state.id };
      await worker.dispatch(request, worker.contentSender); await worker.dispatch(request, worker.contentSender);
      assert.equal(worker.reloadCalls.length, stopped ? 0 : 1);
      if (!stopped) {
        assert.equal(worker.read().session.needsReview, true); assert.equal(worker.read().session.active, false);
        await worker.dispatch({ action: 'hello', documentId: 'new-review-doc' }, worker.contentSender);
        assert.equal(worker.read().session.documentId, 'new-review-doc');
        const reply = await worker.dispatch({ action: 'observe', ...request, action: 'observe', documentId: 'new-review-doc', observation: {
          phase: 'open', side: 'Dice', openKey: 'review-open', resultKey: 'review-result', controlsReady: true
        } }, worker.contentSender);
        assert.equal(reply.instruction, null); assert.equal(reply.session.pending.id, state.pending.id);
        assert.equal(reply.session.netLossCents, 0);
      }
    }
  });
  await test('Start during a spin arms live or simulation, then scans the reopened history and follows the configured timing', async () => {
    for (const dryRun of [false, true]) for (const direction of ['first', 'last']) {
      const page = await contentHarness({ siteLayout: true, siteHealth: true, startClosed: true,
        seedHistory: true, dryRun, betAmount: .01, turnsWait: 2, direction,
        initialHistory: ['CT', 'CT'], roundSeconds: 25 });
      const armed = page.worker.read().session;
      assert.equal(armed.active, true); assert.equal(armed.pending, null);
      assert.match(armed.status, /current roll/);
      assert.equal(armed.checkpoint.hasWheel, true);
      assert.equal(page.clicked(), 0);
      await page.openRound(1, 'ct');
      const open = page.worker.read().session;
      assert.equal(open.missingRounds.T, 2);
      assert.equal(open.rounds, 0); assert.equal(open.wins, 0); assert.equal(open.losses, 0);
      assert.equal(open.pending, null);
      await page.timer(9.5);
      assert.equal(page.worker.read().session.pending.side, 'T');
      assert.equal(page.worker.read().session.pending.status, 'accepted');
      assert.equal(page.clicked(), dryRun ? 0 : 1);
    }
  });
  await test('an armed spin startup uses the latest result rather than the stale pre-spin streak', async () => {
    const page = await contentHarness({ siteLayout: true, siteHealth: true, startClosed: true,
      seedHistory: true, initialHistory: ['CT', 'CT'], turnsWait: 2 });
    await page.openRound(1, 't');
    const state = page.worker.read().session;
    assert.deepEqual(state.missingRounds, { T: 0, CT: 1 });
    assert.equal(state.pending, null); assert.equal(state.rounds, 0); assert.equal(page.clicked(), 0);
  });
  await test('Stop while armed prevents the first bet, and disconnected roulette cannot be started', async () => {
    const page = await contentHarness({ siteLayout: true, siteHealth: true, startClosed: true,
      seedHistory: true, dryRun: false, initialHistory: ['CT', 'CT'], turnsWait: 1, betAmount: .01 });
    await page.toolbar.stop(); await page.openRound(1, 'ct');
    assert.equal(page.worker.read().session.active, false); assert.equal(page.clicked(), 0);
    const idle = await contentHarness({ siteLayout: true, siteHealth: true, autoStart: false });
    await idle.siteState({ initialized: false });
    assert.equal((await idle.inspect()).ready, false);
    await assert.rejects(() => idle.toolbar.start(idle.config), /disconnected\/loading/);
    assert.equal(idle.worker.read().session, null); assert.equal(idle.worker.reloadCalls.length, 0);
  });
  await test('a disconnected site requests reload immediately even when all stale controls remain visible', async () => {
    for (const duringSpin of [false, true]) {
      const page = await contentHarness({ siteLayout: true, siteHealth: true, dryRun: false,
        seedHistory: true, initialHistory: ['T', 'CT', 'CT', 'CT'], turnsWait: 3, betAmount: .01 });
      const before = page.worker.read().session;
      if (duringSpin) await page.closeRound();
      await page.siteState({ initialized: false });
      assert.deepEqual(page.worker.reloadCalls, [1]);
      const state = page.worker.read().session;
      assert.equal(state.pending.id, before.pending.id); assert.equal(state.pending.status, 'accepted');
      assert.equal(state.netLossCents, 0); assert.equal(state.nextBetCents, 1); assert.equal(page.clicked(), 1);
      const detection = page.messages.find(message => message.action === 'pageUnavailable');
      assert.equal(detection.request.reload, true);
      assert.equal(page.messages.filter(message => message.action === 'reloadPage').length, 0);
      await page.siteState({ initialized: false });
      assert.equal(page.worker.reloadCalls.length, 1); assert.equal(page.worker.read().session.active, true);
    }
  });
  await test('the independent watchdog reloads during blocked confirmation after the spin was already recorded', async () => {
    const page = await contentHarness({ siteLayout: true, siteHealth: true, dryRun: false,
      seedHistory: true, initialHistory: ['CT', 'CT'], turnsWait: 1, betAmount: .01,
      manualTimers: true, accept: false });
    await page.advance(1350); await page.closeRound();
    assert.equal(page.worker.read().session.pending.sawClosed, true);
    assert.equal(page.worker.read().session.pending.status, 'submitted');
    await page.siteState({ initialized: false });
    assert.deepEqual(page.worker.reloadCalls, [1]);
    const state = page.worker.read().session;
    assert.equal(state.needsReview, true); assert.equal(state.active, false);
    assert.equal(state.pending.status, 'submitted'); assert.equal(state.netLossCents, 0);
    assert.equal(page.clicked(), 1);
  });
  await test('a zero countdown while the site still reports betting open reloads at 1.5 seconds without fabricating a spin', async () => {
    const page = await contentHarness({ siteLayout: true, siteHealth: true, dryRun: false,
      seedHistory: true, initialHistory: ['CT', 'CT'], turnsWait: 1, betAmount: .01 });
    const before = page.worker.read().session;
    await page.timer(0);
    assert.equal(page.worker.read().session.pending.sawClosed, false);
    await page.advance(1499); assert.equal(page.worker.reloadCalls.length, 0);
    await page.advance(1); assert.deepEqual(page.worker.reloadCalls, [1]);
    const state = page.worker.read().session;
    assert.equal(state.pending.id, before.pending.id); assert.equal(state.pending.status, 'accepted');
    assert.equal(state.pending.sawClosed, false); assert.equal(state.losses, 0); assert.equal(page.clicked(), 1);
    assert.match(state.recovery.reason, /stuck at zero/);
  });
  await test('a normal zero transition clears its stall timer when the real spin begins', async () => {
    const page = await contentHarness({ siteLayout: true, siteHealth: true, seedHistory: true,
      initialHistory: ['CT', 'CT'], turnsWait: 1 });
    await page.timer(0); await page.advance(1000); await page.closeRound();
    await page.timer(0); await page.advance(6500);
    assert.equal(page.worker.reloadCalls.length, 0);
    await page.openRound(1, 'dice');
    assert.equal(page.worker.read().session.losses, 1);
    assert.equal(page.worker.read().session.active, true); assert.equal(page.worker.reloadCalls.length, 0);
  });
  await test('an abnormal spin that never finishes reloads after its allowance, including longer announced animations', async () => {
    for (const animationMs of [6000, 12000]) {
      const page = await contentHarness({ siteLayout: true, siteHealth: true, seedHistory: true,
        initialHistory: ['CT', 'CT'], turnsWait: 1 });
      await page.closeRound(); await page.siteState({ animationMs }); await page.timer(0);
      const limit = Math.max(10000, animationMs + 2000);
      await page.advance(limit - 1); assert.equal(page.worker.reloadCalls.length, 0);
      await page.advance(1); assert.deepEqual(page.worker.reloadCalls, [1]);
      assert.equal(page.worker.read().session.losses, 0);
    }
  });
  await test('a zero countdown with unavailable site phase uses a spin-safe fallback and still reloads', async () => {
    const page = await contentHarness({ siteLayout: true, seedHistory: true,
      initialHistory: ['CT', 'CT'], turnsWait: 1, noStakeProbe: true });
    await page.timer(0); await page.advance(7999);
    assert.equal(page.worker.reloadCalls.length, 0);
    await page.advance(1); assert.deepEqual(page.worker.reloadCalls, [1]);
  });
  await test('a countdown missing while the site is internally open triggers fast recovery', async () => {
    const page = await contentHarness({ siteLayout: true, siteHealth: true, seedHistory: true,
      initialHistory: ['CT', 'CT'], turnsWait: 1 });
    page.countdown.isConnected = false; page.watchdog(); await flush();
    await page.advance(499); assert.equal(page.worker.reloadCalls.length, 0);
    await page.advance(1); assert.deepEqual(page.worker.reloadCalls, [1]);
  });
  await test('an armed session survives loading and document handoff before its first betting window', async () => {
    const page = await contentHarness({ siteLayout: true, siteHealth: true, startClosed: true,
      seedHistory: true, dryRun: false, initialHistory: ['CT', 'CT'], turnsWait: 1, betAmount: .01 });
    const id = page.worker.read().session.id;
    await page.siteState({ initialized: false }); assert.deepEqual(page.worker.reloadCalls, [1]);
    await page.reload();
    assert.equal(page.worker.read().session.id, id); assert.equal(page.worker.read().session.active, true);
    await page.siteState({ initialized: true }); await page.openRound(1, 'ct'); await page.advance(1000);
    assert.equal(page.worker.read().session.id, id); assert.equal(page.worker.read().session.recovery, null);
    assert.equal(page.worker.read().session.pending.status, 'accepted'); assert.equal(page.clicked(), 1);
    assert.equal(page.worker.read().session.rounds, 0);
  });
  await test('atomic loading/reload ignores a newer Stop and never discards an accepted outstanding bet', async () => {
    for (const stopped of [false, true]) {
      const { state } = recoveryFixture(); state.recovery = null;
      const worker = workerHarness({ config: state.config, session: state });
      if (stopped) await worker.dispatch({ action: 'stopBot' });
      await worker.dispatch({ action: 'pageUnavailable', reload: true, documentId: state.documentId,
        sessionId: state.id, notClickedBetId: state.pending.id, error: 'Disconnected' }, worker.contentSender);
      assert.equal(worker.reloadCalls.length, stopped ? 0 : 1);
      assert.equal(worker.read().session.pending.id, state.pending.id);
      assert.equal(worker.read().session.pending.status, 'accepted');
      assert.equal(worker.read().session.active, !stopped);
    }
  });
  await test('countdown timing validates safe ranges and distinguishes waiting, ready, late and unavailable', () => {
    assert.equal(Core.settings().betBeforeSeconds, 10);
    assert.equal(Core.settings().timingVarianceSeconds, .5);
    assert.equal(Core.settings({ timingVarianceSeconds: 0 }).timingVarianceSeconds, 0);
    assert.equal(Core.settings({ betBeforeSeconds: '10,5' }).betBeforeSeconds, 10.5);
    for (const value of [0, 5, 61, 'bad', Infinity, null]) assert.throws(() => Core.settings({ betBeforeSeconds: value }));
    for (const value of [-.1, 2.1, '', null, Infinity]) assert.throws(() => Core.settings({ timingVarianceSeconds: value }));
    assert.throws(() => Core.settings({ betBeforeSeconds: 6, timingVarianceSeconds: 2 }));
    assert.equal(Core.placementWindow(25, 10), 'waiting');
    assert.equal(Core.placementWindow(10, 10), 'ready');
    assert.equal(Core.placementWindow(5, 10), 'ready');
    assert.equal(Core.placementWindow(4.9, 10), 'late');
    assert.equal(Core.placementWindow(null, 10), 'unavailable');
    assert.equal(Core.placementWindow(Infinity, 10), 'unavailable');
  });
  await test('a waiting round reserves nothing until its timing window and never counts or reserves twice', () => {
    const state = Core.create(Core.settings({ turnsWait: 1 }), 1, 'doc-1', 'waiting', ['CT']);
    const observation = { phase: 'open', openKey: 'open-0', resultKey: 'result-0', side: 'CT', controlsReady: true,
      placementWindow: 'waiting', betAtSeconds: 10 };
    assert.equal(Core.observe(state, observation, randomUUID), null);
    assert.equal(state.pending, null); assert.equal(state.rounds, 0);
    assert.equal(state.missingRounds.T, 1);
    assert.match(state.status, /10.0 seconds remaining/);
    assert.equal(Core.observe(state, observation, randomUUID), null);
    const bet = Core.observe(state, { ...observation, placementWindow: 'ready' }, randomUUID);
    assert.equal(bet.side, 'T'); assert.equal(bet.amountCents, 1000);
    Core.acknowledge(state, bet.id, 'accepted');
    assert.equal(Core.observe(state, { ...observation, placementWindow: 'ready' }, randomUUID), null);
    assert.equal(state.rounds, 0); assert.equal(state.missingRounds.T, 1);
  });
  await test('stopping while waiting clears the scheduled decision without an outstanding bet', () => {
    const state = Core.create(Core.settings({ turnsWait: 1 }), 1, 'doc-1', 'waiting-stop', ['CT']);
    const observation = { phase: 'open', openKey: 'open-0', resultKey: 'result-0', side: 'CT', controlsReady: true,
      placementWindow: 'waiting', betAtSeconds: 10 };
    Core.observe(state, observation, randomUUID); Core.stop(state);
    assert.equal(state.pending, null); assert.equal(state.waitingRoundKey, null);
    assert.equal(Core.observe(state, { ...observation, placementWindow: 'ready' }, randomUUID), null);
    assert.equal(state.status, 'Stopped');
  });
  await test('a never-clicked reservation is cleared without a loss, and an earlier acceptance error is preserved', () => {
    const reserved = session({ dryRun: false }); round(reserved, 1, 'T'); round(reserved, 2, 'T', false);
    round(reserved, 3, 'T', false);
    assert.equal(reserved.pending, null); assert.equal(reserved.netLossCents, 0);
    assert.match(reserved.status, /before the bet was placed/);
    const uncertain = session({ dryRun: false }); round(uncertain, 1, 'T');
    const bet = round(uncertain, 2, 'T', false);
    Core.acknowledge(uncertain, bet.id, 'submitted');
    Core.acknowledge(uncertain, bet.id, 'uncertain', 'Exact balance deduction was not visible.');
    round(uncertain, 3, 'T', false);
    assert.equal(uncertain.status, 'Exact balance deduction was not visible.');
    assert.equal(uncertain.pending.id, bet.id); assert.equal(uncertain.losses, 0);
  });
  await test('validation preserves zero stop loss and decimals; rejects invalid values', () => {
    assert.equal(Core.settings({ stopLoss: 0, betAmount: '0.25' }).stopLoss, 0);
    assert.equal(Core.settings({ stopLoss: 0, betAmount: '0.25' }).betAmount, 0.25);
    for (const value of ['', -1, 'bad', 0, 0.001, Infinity]) assert.throws(() => Core.settings({ betAmount: value }));
    for (const value of ['', -1, 1.5, 0, 'bad']) assert.throws(() => Core.settings({ turnsWait: value }));
    assert.equal(Core.normalizeSide('counter-terrorist'), 'CT');
    assert.equal(Core.normalizeSide('T CT'), null);
  });
  await test('live one-cent then two-cent bets wait for each countdown window and settle exactly once on either side', async () => {
    for (const target of ['T', 'CT']) {
      const opposite = target === 'T' ? 'CT' : 'T';
      const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true, betAmount: .01,
        turnsWait: 1, initialHistory: [opposite, opposite], initialSeconds: 25, roundSeconds: 25, commitOnBlur: true });
      let state = page.worker.read().session;
      assert.equal(state.pending, null); assert.equal(page.clicked(), 0);
      assert.equal(page.amount.value, '0.1'); assert.match(state.status, /10.0 seconds remaining/);
      page.countdown.textContent = '10.1'; await page.advance(500);
      assert.equal(page.clicked(), 0);
      page.countdown.textContent = '9.9'; await page.advance(250);
      assert.equal(page.clicked(), 1); assert.equal(page.worker.read().session.pending.status, 'accepted');
      await page.complete(1, 'dice');
      state = page.worker.read().session;
      assert.equal(state.active, true); assert.equal(state.pending, null);
      assert.equal(state.losses, 1); assert.equal(state.netLossCents, 1); assert.equal(state.nextBetCents, 2);
      assert.equal(page.clicked(), 1); assert.match(state.status, /Waiting to place/);
      page.countdown.textContent = '9.9'; await page.advance(250);
      state = page.worker.read().session;
      assert.equal(page.clicked(), 2); assert.deepEqual(page.clickedAmounts, [1, 2]);
      assert.equal(state.pending.side, target); assert.equal(state.pending.status, 'accepted');
      assert.equal(state.losses, 1); assert.equal(state.netLossCents, 1);
      await page.complete(2, target.toLowerCase());
      state = page.worker.read().session;
      assert.equal(state.active, true); assert.equal(state.wins, 1); assert.equal(state.nextBetCents, 1);
      assert.equal(state.netLossCents, -1); assert.equal(page.clicked(), 2);
    }
  });
  await test('a spin beginning during live confirmation is recorded before the doubled second bet', async () => {
    const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true, betAmount: .01,
      turnsWait: 1, initialHistory: ['CT', 'CT'], accept: false, manualTimers: true });
    await page.advance(1350);
    assert.equal(page.clicked(), 1); assert.equal(page.worker.read().session.pending.status, 'submitted');
    await page.closeRound();
    assert.equal(page.worker.read().session.pending.sawClosed, true);
    page.balance.textContent = '99.99'; await page.advance(300);
    assert.equal(page.worker.read().session.pending.status, 'accepted');
    await page.openRound(1, 'dice');
    assert.equal(page.worker.read().session.losses, 1); assert.equal(page.worker.read().session.nextBetCents, 2);
    await page.advance(1350);
    assert.deepEqual(page.clickedAmounts, [1, 2]);
    page.balance.textContent = '99.97'; await page.advance(300);
    const state = page.worker.read().session;
    assert.equal(state.active, true); assert.equal(state.pending.status, 'accepted');
    assert.equal(state.pending.amountCents, 2); assert.equal(state.netLossCents, 1);
  });
  await test('simulation uses the delayed placement window without filling or clicking live controls', async () => {
    const page = await contentHarness({ siteLayout: true, seedHistory: true, turnsWait: 1,
      initialHistory: ['CT', 'CT'], initialSeconds: 25 });
    assert.equal(page.worker.read().session.pending, null);
    page.countdown.textContent = '9.9'; await page.advance(500);
    assert.equal(page.worker.read().session.pending.status, 'accepted');
    assert.equal(page.clicked(), 0); assert.equal(page.amount.value, '0.1');
  });
  await test('enabled controls are required inside the countdown window and transient unreadiness can recover', async () => {
    const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true, turnsWait: 1,
      initialHistory: ['CT', 'CT'], disabledSide: 'CT' });
    assert.equal(page.clicked(), 0); assert.equal(page.worker.read().session.active, true);
    assert.match(page.worker.read().session.status, /controls to become ready/);
    page.ct.attrs.disable = 'false'; await page.advance(500);
    assert.equal(page.clicked(), 1); assert.equal(page.worker.read().session.pending.status, 'accepted');
  });
  await test('Stop while waiting prevents a later click and a worker restart retains a waiting round', async () => {
    const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true, turnsWait: 1,
      initialHistory: ['CT', 'CT'], initialSeconds: 25 });
    page.worker.boot(); page.countdown.textContent = '15'; await page.advance(500);
    assert.equal(page.worker.read().session.pending, null);
    await page.toolbar.stop(); page.countdown.textContent = '9.9'; await page.advance(500);
    assert.equal(page.clicked(), 0); assert.equal(page.worker.read().session.pending, null);
    assert.equal(page.worker.read().session.status, 'Stopped');
    const restarted = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true, turnsWait: 1,
      initialHistory: ['CT', 'CT'], initialSeconds: 25 });
    restarted.worker.boot(); restarted.countdown.textContent = '9.9'; await restarted.advance(500);
    assert.equal(restarted.clicked(), 1); assert.equal(restarted.worker.read().session.pending.status, 'accepted');
  });
  await test('rounds continue to count if a waiting bet never reaches its window without creating a loss', async () => {
    const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true, turnsWait: 1,
      initialHistory: ['CT', 'CT'], initialSeconds: 25, roundSeconds: 25 });
    await page.complete(1, 'ct');
    const state = page.worker.read().session;
    assert.equal(state.rounds, 1); assert.equal(state.missingRounds.T, 3);
    assert.equal(state.pending, null); assert.equal(state.losses, 0); assert.equal(state.netLossCents, 0);
    page.countdown.textContent = '9.9'; await page.advance(500);
    assert.equal(page.clicked(), 1); assert.equal(page.worker.read().session.pending.amountCents, 1234);
  });
  await test('a late start skips the unsafe window and can place its first bet next round', async () => {
    const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true, turnsWait: 1,
      initialHistory: ['CT', 'CT'], initialSeconds: 4 });
    assert.equal(page.clicked(), 0); assert.equal(page.worker.read().session.pending, null);
    assert.match(page.worker.read().session.status, /Skipped/);
    await page.complete(1, 'ct');
    assert.equal(page.clicked(), 1); assert.equal(page.worker.read().session.losses, 0);
  });
  await test('the timing target varies within its bounds, stays fixed for a round, and supports zero variation', async () => {
    for (const [randomValue, variance, target] of [[0, .5, 9.5], [1, .5, 10.5], [.25, .5, 9.75], [0, 0, 10]]) {
      const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true, turnsWait: 1,
        initialHistory: ['CT', 'CT'], initialSeconds: 25, randomValue, timingVarianceSeconds: variance });
      const status = page.worker.read().session.status;
      await page.advance(500); assert.equal(page.worker.read().session.status, status);
      page.countdown.textContent = String(target + .05); await page.advance(500);
      assert.equal(page.clicked(), 0);
      page.countdown.textContent = String(target - .05); await page.advance(500);
      assert.equal(page.clicked(), 1); assert.equal(page.worker.read().session.pending.status, 'accepted');
    }
  });
  await test('closure or a changed round during amount entry prevents a late or misplaced click', async () => {
    for (const trigger of ['closeOnInput', 'changeRoundOnInput']) {
      const page = await contentHarness({ dryRun: false, [trigger]: true });
      await page.complete(1, 't'); await page.complete(2, 't');
      const state = page.worker.read().session;
      assert.equal(page.clicked(), 0); assert.equal(state.pending, null);
      assert.equal(state.netLossCents, 0); assert.equal(state.active, false);
      assert.match(state.status, /closed|round changed/);
    }
  });
  await test('one-cent amounts accept comma or point and always format with exactly two decimal digits', () => {
    for (const value of ['0,01', '0.01', '.01', ' 0,01 ', .01]) {
      assert.equal(Core.cents(value, 'Base bet'), 1);
      assert.equal(Core.settings({ betAmount: value }).betAmount, .01);
      assert.equal(Core.formatAmount(Core.cents(value, 'Base bet')), '0.01');
    }
    assert.equal(Core.settings({ stopLoss: '10,50' }).stopLoss, 10.5);
    assert.equal(Core.formatAmount(1000), '10.00');
    for (const value of ['0,001', '0.001', '0,01.0', '1,2,3', true, []]) assert.throws(() => Core.cents(value, 'Base bet'));
    assert.equal(Core.settings({ turnsWait: 1 }).turnsWait, 1);
  });
  await test('the displayed one-cent value can differ from the widget stake until its field interaction runs', async () => {
    const page = await contentHarness({ siteLayout: true, dryRun: false, autoStart: false,
      commitOnAmountClick: true, initialAmount: '0.00' });
    page.amount.value = '0.01'; page.t.click();
    assert.deepEqual(page.clickedAmounts, [0]); assert.equal(page.balance.textContent, '100.00');
    page.amount.click(); page.t.click();
    assert.deepEqual(page.clickedAmounts, [0, 1]); assert.equal(page.balance.textContent, '99.99');
  });
  await test('plain ASCII one-cent and doubled stakes reach focus- or click-synchronized widgets on either coin with the field unfocused', async () => {
    for (const target of ['T', 'CT']) {
      for (const commit of ['commitOnAmountClick', 'commitOnAmountFocus']) {
        const other = target === 'T' ? 'CT' : 'T';
        const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true, betAmount: .01,
          turnsWait: 3, initialHistory: [other, other, other], initialAmount: '0.00', clearAmountEachRound: true, [commit]: true });
        assert.deepEqual(page.clickedAmounts, [1]); assert.equal(page.worker.read().session.pending.status, 'accepted');
        assert.deepEqual(Array.from(page.amount.value, char => char.codePointAt(0)), [48, 46, 48, 49]);
        await page.complete(1, 'dice');
        assert.deepEqual(page.clickedAmounts, [1, 2]); assert.equal(page.worker.read().session.pending.side, target);
        assert.equal(page.amount.value, '0.02'); assert.deepEqual(page.inputFocusedAtBet, [false, false]);
        await page.complete(2, target.toLowerCase());
        assert.equal(page.worker.read().session.wins, 1); assert.equal(page.worker.read().session.nextBetCents, 1);
        assert.equal(page.worker.read().session.netLossCents, -1);
      }
    }
  });
  await test('site formatting removes invisible characters before the final stake check and before clicking Bet', async () => {
    for (const character of ['\u200B', '\u00A0', '\u202F', '\uFEFF']) {
      const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true, betAmount: .01,
        turnsWait: 3, initialHistory: ['CT', 'CT', 'CT'], hiddenCharacter: character,
        normalizeOnAmountClick: true, commitOnAmountClick: true });
      assert.equal(page.amount.value, '0.01'); assert.deepEqual(page.clickedAmounts, [1]);
      assert.deepEqual(page.inputFocusedAtBet, [false]);
      assert.equal(page.worker.read().session.pending.status, 'accepted');
      assert.equal(page.warnings.length, 0);
    }
  });
  await test('an unremoved invisible character blocks the bet and records the exact field characters for diagnosis', async () => {
    const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true, betAmount: .01,
      turnsWait: 3, initialHistory: ['CT', 'CT', 'CT'], hiddenCharacter: '\u200B' });
    const state = page.worker.read().session;
    assert.equal(page.clicked(), 0); assert.equal(state.pending, null); assert.equal(state.losses, 0);
    assert.match(state.status, /non-decimal characters/);
    assert.equal(page.warnings.length, 1);
    assert.ok(page.warnings[0][1].characters.includes('U+200B'));
  });
  await test('Stop during field formatting prevents a money click and a zeroed stake is checked again after submission permission', async () => {
    for (const trigger of ['stopOnAmountClick', 'resetAmountAfterSubmit']) {
      const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true, betAmount: .01,
        turnsWait: 3, initialHistory: ['CT', 'CT', 'CT'], [trigger]: true });
      const state = page.worker.read().session;
      assert.equal(page.clicked(), 0); assert.equal(state.active, false); assert.equal(state.pending, null);
      assert.equal(state.losses, 0); assert.equal(state.netLossCents, 0);
    }
  });
  await test('visible history seeds a two-CT streak and reserves one T bet without counting old wins or losses', () => {
    const state = Core.create(Core.settings({ turnsWait: 2, betAmount: .01 }), 1, 'doc-1', 'session-1', ['T', 'Dice', 'CT', 'CT']);
    assert.deepEqual(state.missingRounds, { T: 3, CT: 0 });
    const opening = { phase: 'open', openKey: 'initial', resultKey: 'initial-result', side: 'CT', controlsReady: true };
    const bet = Core.observe(state, opening, randomUUID);
    assert.equal(bet.side, 'T'); assert.equal(bet.amountCents, 1);
    assert.equal(state.rounds, 0); assert.equal(state.wins, 0); assert.equal(state.losses, 0);
    assert.equal(state.netLossCents, 0);
    Core.acknowledge(state, bet.id, 'accepted');
    assert.equal(Core.observe(state, opening, randomUUID), null);
    assert.deepEqual(state.missingRounds, { T: 3, CT: 0 });
    const afterDice = round(state, 1, 'Dice');
    assert.equal(afterDice.side, 'T'); assert.equal(afterDice.amountCents, 2);
    assert.equal(state.losses, 1); assert.equal(state.netLossCents, 1);
  });
  await test('a one-roll threshold bets against the latest coin and doubles Dice losses until winning', () => {
    const state = Core.create(Core.settings({ turnsWait: 1, betAmount: .01 }), 1, 'doc-1', 'session-1', ['T']);
    const first = Core.observe(state, { phase: 'open', openKey: 'initial', resultKey: 'result-0', side: 'T', controlsReady: true }, randomUUID);
    assert.equal(first.side, 'CT'); assert.equal(first.amountCents, 1);
    Core.acknowledge(state, first.id, 'accepted');
    const loss = round(state, 1, 'Dice');
    assert.equal(loss.side, 'CT'); assert.equal(loss.amountCents, 2);
    const win = round(state, 2, 'CT');
    assert.equal(win.side, 'T'); assert.equal(win.amountCents, 1);
    assert.equal(state.wins, 1); assert.equal(state.losses, 1); assert.equal(state.netLossCents, -1);
  });
  await test('the latest stable startup history replaces an inspection snapshot before the first bet', () => {
    const state = Core.create(Core.settings({ turnsWait: 3 }), 1, 'doc-1', 'session-1', ['T', 'T', 'T']);
    const bet = Core.observe(state, { phase: 'open', openKey: 'initial', resultKey: 'result-0', side: 'CT',
      controlsReady: true, initialHistory: ['T', 'T', 'CT'] }, randomUUID);
    assert.equal(bet, null);
    assert.deepEqual(state.missingRounds, { T: 1, CT: 0 });
    assert.equal(state.rounds, 0); assert.equal(state.netLossCents, 0);
  });
  await test('history seeding handles Dice and ten visible results without inventing earlier rounds', () => {
    assert.deepEqual(Core.missingFromHistory(['CT','T','Dice','CT','CT']), { T: 3, CT: 0 });
    assert.deepEqual(Core.missingFromHistory(Array(10).fill('CT')), { T: 10, CT: 0 });
    assert.throws(() => Core.missingFromHistory(['T','unknown']));
  });
  await test('repeated polls never turn one result into a streak or bet', () => {
    const state = session();
    for (let index = 0; index < 50; index++) Core.observe(state, { phase: 'open', openKey: 'open-0', resultKey: 'result-0', side: 'T', controlsReady: true }, randomUUID);
    assert.deepEqual(state.missingRounds, { T: 0, CT: 0 });
    assert.equal(state.pending, null);
    round(state, 1, 'T');
    for (let index = 0; index < 50; index++) Core.observe(state, { phase: 'open', openKey: 'open-1', resultKey: 'result-1', side: 'T', controlsReady: true }, randomUUID);
    assert.deepEqual(state.missingRounds, { T: 0, CT: 1 });
    assert.equal(state.rounds, 1);
  });
  await test('same-color rounds trigger the opposite side but do not settle it immediately', () => {
    const state = session();
    round(state, 1, 'T');
    const bet = round(state, 2, 'T');
    assert.equal(bet.side, 'CT');
    assert.equal(bet.amountCents, 1000);
    assert.equal(state.netLossCents, 0);
    assert.equal(state.losses, 0);
    assert.equal(state.pending.status, 'accepted');
  });
  await test('loss doubles the recorded stake; subsequent win resets and recovers loss', () => {
    const state = session();
    round(state, 1, 'T'); round(state, 2, 'T');
    const next = round(state, 3, 'T');
    assert.equal(state.netLossCents, 1000);
    assert.equal(next.side, 'CT'); assert.equal(next.amountCents, 2000);
    assert.equal(round(state, 4, 'CT'), null);
    assert.equal(state.netLossCents, -1000);
    assert.equal(state.nextBetCents, 1000);
    assert.equal(state.wins, 1); assert.equal(state.losses, 1);
  });
  await test('every loss including repeated Dice doubles either side until its win resets the stake', () => {
    for (const target of ['T', 'CT']) {
      const other = target === 'T' ? 'CT' : 'T';
      const state = session({ turnsWait: 4 });
      for (let id = 1; id < 4; id++) assert.equal(round(state, id, other), null);
      assert.equal(round(state, 4, other).side, target);
      for (const [index, loss] of ['Dice', 'Dice', other, 'Dice', 'Dice'].entries()) {
        const next = round(state, 5 + index, loss);
        assert.equal(next.side, target);
        assert.equal(next.amountCents, 1000 * 2 ** (index + 1));
        assert.equal(state.chaseSide, target);
        assert.equal(state.wins, 0);
        assert.equal(state.losses, index + 1);
        assert.equal(state.netLossCents, 1000 * (2 ** (index + 1) - 1));
      }
      assert.equal(round(state, 10, target), null);
      assert.equal(state.chaseSide, null);
      assert.equal(state.missingRounds[target], 0);
      assert.equal(state.nextBetCents, 1000);
      assert.equal(state.netLossCents, -1000);
      assert.equal(state.wins, 1);
      assert.equal(state.losses, 5);
    }
  });
  await test('Dice counts toward either missing coin before betting begins', () => {
    for (const target of ['T', 'CT']) {
      const other = target === 'T' ? 'CT' : 'T';
      const state = session({ turnsWait: 3 });
      assert.equal(round(state, 1, other), null);
      assert.equal(round(state, 2, 'Dice'), null);
      const bet = round(state, 3, other);
      assert.equal(bet.side, target);
      assert.equal(bet.amountCents, 1000);
      assert.equal(state.missingRounds[target], 3);
    }
  });
  await test('only the matching coin resets its independent absence counter', () => {
    const state = session({ turnsWait: 10 });
    const expected = [
      ['T', { T: 0, CT: 1 }], ['Dice', { T: 1, CT: 2 }],
      ['T', { T: 0, CT: 3 }], ['CT', { T: 1, CT: 0 }],
      ['Dice', { T: 2, CT: 1 }], ['CT', { T: 3, CT: 0 }]
    ];
    expected.forEach(([side, counts], index) => {
      assert.equal(round(state, index + 1, side), null);
      assert.deepEqual(state.missingRounds, counts);
    });
  });
  await test('Dice-only waiting ties choose T and never switch an existing losing progression', () => {
    const state = session({ turnsWait: 3 });
    round(state, 1, 'Dice'); round(state, 2, 'Dice');
    const bet = round(state, 3, 'Dice');
    assert.equal(bet.side, 'T'); assert.equal(bet.amountCents, 1000);
    const next = round(state, 4, 'Dice');
    assert.equal(next.side, 'T'); assert.equal(next.amountCents, 2000);
    assert.deepEqual(state.missingRounds, { T: 4, CT: 4 });
    const afterWin = round(state, 5, 'T');
    assert.equal(state.wins, 1); assert.equal(state.nextBetCents, 1000);
    assert.equal(afterWin.side, 'CT'); assert.equal(afterWin.amountCents, 1000);
  });
  await test('an older session keeps its pending stake and doubles after Dice during migration', () => {
    const state = session(); round(state, 1, 'T'); round(state, 2, 'T');
    delete state.missingRounds;
    state.streakSide = 'T'; state.streakCount = 2;
    const next = round(state, 3, 'Dice');
    assert.equal(next.side, 'CT'); assert.equal(next.amountCents, 2000);
    assert.deepEqual(state.missingRounds, { T: 1, CT: 3 });
  });
  await test('stop loss stops before an oversized next bet; zero disables the limit', () => {
    const state = session({ stopLoss: 25 });
    round(state, 1, 'T'); round(state, 2, 'T');
    assert.equal(round(state, 3, 'T'), null);
    assert.equal(state.active, false); assert.equal(state.netLossCents, 1000); assert.equal(state.pending, null);
    const zero = session({ stopLoss: 0 });
    round(zero, 1, 'T'); round(zero, 2, 'T');
    assert.equal(round(zero, 3, 'T').amountCents, 2000);
  });
  await test('an exact-limit loss stops; no further stake is reserved', () => {
    const state = session({ stopLoss: 10 });
    round(state, 1, 'T'); round(state, 2, 'T');
    assert.equal(round(state, 3, 'T'), null);
    assert.equal(state.netLossCents, 1000); assert.equal(state.active, false);
  });
  await test('Stop settles an accepted outstanding bet but never places another', () => {
    const state = session();
    round(state, 1, 'T'); round(state, 2, 'T'); Core.stop(state);
    assert.equal(round(state, 3, 'T'), null);
    assert.equal(state.netLossCents, 1000); assert.equal(state.pending, null); assert.equal(state.active, false);
  });
  await test('missing buttons, unconfirmed clicks and missed spins never fabricate losses', () => {
    const missing = session(); round(missing, 1, 'T');
    Core.observe(missing, { phase: 'closed' }, randomUUID);
    assert.equal(Core.observe(missing, { phase: 'open', openKey: 'open-2', resultKey: 'result-2', side: 'T', controlsReady: false }, randomUUID), null);
    assert.equal(missing.active, false); assert.equal(missing.netLossCents, 0);
    const uncertain = session({ dryRun: false }); round(uncertain, 1, 'T');
    const bet = round(uncertain, 2, 'T', false);
    Core.acknowledge(uncertain, bet.id, 'submitted'); Core.acknowledge(uncertain, bet.id, 'uncertain');
    round(uncertain, 3, 'T');
    assert.equal(uncertain.netLossCents, 0); assert.ok(uncertain.pending);
    const missed = session(); round(missed, 1, 'T'); round(missed, 2, 'T');
    Core.observe(missed, { phase: 'open', openKey: 'open-3', resultKey: 'result-3', side: 'T', controlsReady: true }, randomUUID);
    assert.equal(missed.netLossCents, 0); assert.equal(missed.active, false);
  });
  await test('stale result ID waits for the new result before settlement', () => {
    const state = session(); round(state, 1, 'T'); round(state, 2, 'T');
    Core.observe(state, { phase: 'closed' }, randomUUID);
    Core.observe(state, { phase: 'open', openKey: 'open-3', resultKey: 'result-2', side: 'T', controlsReady: true }, randomUUID);
    assert.equal(state.netLossCents, 0);
    Core.observe(state, { phase: 'open', openKey: 'open-3', resultKey: 'result-3', side: 'CT', controlsReady: true }, randomUUID);
    assert.equal(state.netLossCents, -1000);
  });
  await test('new Start uses the new base amount and fresh accounting', () => {
    const state = session({ betAmount: 7.25 });
    assert.equal(state.nextBetCents, 725); assert.equal(state.netLossCents, 0);
  });
  await test('async message channel stays open and simultaneous round events reserve one bet', async () => {
    const state = session(); round(state, 1, 'T');
    const worker = workerHarness({ config: state.config, session: state });
    const request = { action: 'observe', documentId: 'doc-1', sessionId: 'session-1', observation: { phase: 'open', openKey: 'open-2', resultKey: 'result-2', side: 'T', controlsReady: true } };
    const responses = await Promise.all(Array.from({ length: 8 }, () => worker.dispatch(request, worker.contentSender)));
    assert.equal(responses.filter(response => response.instruction).length, 1);
    assert.equal(worker.read().session.netLossCents, 0);
  });
  await test('worker restart preserves accepted stake and deduplicates its settlement', async () => {
    const state = session(); round(state, 1, 'T'); round(state, 2, 'T');
    const worker = workerHarness({ config: state.config, session: state });
    const base = { documentId: 'doc-1', sessionId: 'session-1' };
    await worker.dispatch({ ...base, action: 'observe', observation: { phase: 'closed' } }, worker.contentSender);
    worker.boot();
    const request = { ...base, action: 'observe', observation: { phase: 'open', openKey: 'open-3', resultKey: 'result-3', side: 'CT', controlsReady: true } };
    const response = await worker.dispatch(request, worker.contentSender);
    assert.equal(response.session.netLossCents, -1000);
    await worker.dispatch(request, worker.contentSender);
    assert.equal(worker.read().session.wins, 1);
  });
  await test('a fifteen-round missing counter survives worker restarts beyond the visible ten rolls', async () => {
    const state = session({ turnsWait: 15 });
    const worker = workerHarness({ config: state.config, session: state });
    const base = { action: 'observe', documentId: 'doc-1', sessionId: 'session-1' };
    let request;
    for (let id = 1; id <= 15; id++) {
      await worker.dispatch({ ...base, observation: { phase: 'closed' } }, worker.contentSender);
      if (id === 8) worker.boot();
      request = { ...base, observation: { phase: 'open', openKey: `open-${id}`, resultKey: `result-${id}`, side: id % 2 ? 'T' : 'Dice', controlsReady: true } };
      const response = await worker.dispatch(request, worker.contentSender);
      assert.equal(response.success, true);
      assert.equal(response.session.missingRounds.CT, id);
      if (id < 15) assert.equal(response.instruction, null);
      else {
        assert.equal(response.instruction.side, 'CT');
        assert.equal(response.instruction.amountCents, 1000);
      }
    }
    const duplicate = await worker.dispatch(request, worker.contentSender);
    assert.equal(duplicate.instruction, null);
    assert.equal(duplicate.session.missingRounds.CT, 15);
  });
  await test('wrong tabs, frames, and stale documents cannot run another session', async () => {
    const state = session(); const worker = workerHarness({ config: state.config, session: state });
    const request = { action: 'observe', documentId: 'doc-1', sessionId: 'session-1', observation: { phase: 'closed' } };
    for (const sender of [{ ...worker.contentSender, tab: { id: 2 } }, { ...worker.contentSender, frameId: 1 }]) {
      assert.equal((await worker.dispatch(request, sender)).success, false);
    }
    assert.equal((await worker.dispatch({ ...request, documentId: 'old-doc' }, worker.contentSender)).success, false);
  });
  await test('page reload pauses, and Start cannot discard an outstanding bet', async () => {
    const state = session(); round(state, 1, 'T'); round(state, 2, 'T');
    const worker = workerHarness({ config: state.config, session: state });
    await worker.dispatch({ action: 'hello', documentId: 'new-doc' }, worker.contentSender);
    assert.equal(worker.read().session.active, false);
    assert.ok(worker.read().session.pending);
    assert.equal((await worker.dispatch({ action: 'saveConfig', settings: state.config, tabId: 1, documentId: 'doc-1' })).success, false);
  });
  await test('top bar controls start on their own tab and can save, stop, and reset', async () => {
    const config = Core.settings({ dryRun: true });
    const worker = workerHarness({ config });
    const source = worker.contentSender;
    const start = await worker.dispatch({ action: 'saveConfig', settings: config, documentId: 'doc-1' }, source);
    assert.equal(start.success, true, start.error);
    assert.equal(start.session.tabId, source.tab.id);
    assert.equal(start.controllerTabId, source.tab.id);
    assert.equal(start.session.config.dryRun, true);
    assert.equal(start.session.pending, null);
    const stopped = await worker.dispatch({ action: 'stopBot', documentId: 'doc-1' }, source);
    assert.equal(stopped.success, true, stopped.error);
    assert.equal(stopped.session.active, false);
    const saved = await worker.dispatch({ action: 'saveSettings', documentId: 'doc-1', settings: { ...config, betAmount: 3.45 } }, source);
    assert.equal(saved.success, true, saved.error);
    assert.equal(saved.config.betAmount, 3.45);
    const reset = await worker.dispatch({ action: 'resetSession', documentId: 'new-doc' }, source);
    assert.equal(reset.success, true, reset.error);
    assert.equal(reset.session, null);
  });
  await test('top bar controls reject foreign frames, URLs, target tabs, and page identities', async () => {
    const config = Core.settings();
    const worker = workerHarness({ config });
    const start = { action: 'saveConfig', settings: config, documentId: 'doc-1' };
    for (const sender of [
      { ...worker.contentSender, frameId: 1 },
      { ...worker.contentSender, url: 'https://example.com/' }
    ]) assert.equal((await worker.dispatch(start, sender)).success, false);
    assert.equal((await worker.dispatch({ ...start, tabId: 2 }, worker.contentSender)).success, false);
    assert.equal((await worker.dispatch({ ...start, documentId: 'old-doc' }, worker.contentSender)).success, false);
    assert.equal((await worker.dispatch(start, worker.contentSender)).success, true);
    const otherTab = { ...worker.contentSender, tab: { id: 2, url: 'https://csgoempire.com/' } };
    for (const action of ['stopBot', 'resetSession']) {
      assert.equal((await worker.dispatch({ action, documentId: 'doc-2' }, otherTab)).success, false);
    }
    assert.equal(worker.read().session.active, true);
  });
  await test('page top bar shares the existing simulation state without extra clicks or restarts', async () => {
    const page = await contentHarness({ siteLayout: true });
    assert.equal(page.toolbarState().config.dryRun, true);
    assert.equal(page.toolbarState().tabId, 1);
    await page.complete(1, 't'); await page.complete(2, 't');
    const before = page.worker.read().session;
    assert.equal(page.toolbarState().session.id, before.id);
    assert.equal(page.toolbarState().session.pending.side, 'CT');
    assert.equal(page.toolbarState().session.nextBetCents, 1234);
    await page.toolbar.stop();
    assert.equal(page.toolbarState().session.active, false);
    await page.complete(3, 'bonus');
    assert.equal(page.toolbarState().session.losses, 1);
    assert.equal(page.toolbarState().session.nextBetCents, 2468);
    assert.equal(page.toolbarState().session.pending, null);
    await page.toolbar.reset();
    assert.equal(page.toolbarState().session, null);
    await page.toolbar.start(page.config);
    assert.equal(page.toolbarState().session.active, true);
    assert.equal(page.toolbarState().session.config.dryRun, true);
    assert.notEqual(page.toolbarState().session.id, before.id);
    assert.equal(page.clicked(), 0);
  });
  await test('content simulation counts real transitions but never writes or clicks', async () => {
    const page = await contentHarness();
    await page.complete(1, 't'); await page.complete(2, 't');
    assert.equal(page.worker.read().session.pending.status, 'accepted');
    assert.equal(page.worker.read().session.netLossCents, 0);
    assert.equal(page.clicked(), 0); assert.equal(page.amount.value, '99');
    await page.complete(3, 'ct');
    assert.equal(page.worker.read().session.netLossCents, -1234);
    assert.equal(page.worker.read().session.wins, 1);
  });
  await test('live content enters exact decimal stake, fires input/change, confirms acceptance and settles later', async () => {
    const page = await contentHarness({ dryRun: false });
    await page.complete(1, 't'); await page.complete(2, 't');
    assert.equal(page.amount.value, '12.34');
    assert.deepEqual(page.events.filter(type => type !== 'blur'), ['click', 'input', 'beforeinput', 'input', 'change', 'click']);
    assert.equal(page.clicked(), 1);
    assert.equal(page.worker.read().session.pending.status, 'accepted');
    assert.equal(page.worker.read().session.netLossCents, 0);
    page.worker.boot();
    await page.complete(3, 'ct');
    assert.equal(page.worker.read().session.netLossCents, -1234);
    assert.equal(page.clicked(), 1);
  });
  await test('a rejected live click pauses once without inventing a loss or retrying', async () => {
    const page = await contentHarness({ dryRun: false, accept: false });
    await page.complete(1, 't'); await page.complete(2, 't');
    assert.equal(page.clicked(), 1);
    assert.equal(page.worker.read().session.active, false);
    assert.equal(page.worker.read().session.netLossCents, 0);
    assert.equal(page.worker.read().session.losses, 0);
    await page.complete(3, 't');
    assert.equal(page.clicked(), 1); assert.equal(page.worker.read().session.losses, 0);
  });
  await test('Stop during amount entry prevents the click', async () => {
    const page = await contentHarness({ dryRun: false, stopOnInput: true });
    await page.complete(1, 't'); await page.complete(2, 't');
    assert.equal(page.clicked(), 0);
    assert.equal(page.worker.read().session.active, false);
    assert.equal(page.worker.read().session.pending, null);
  });
  await test('a delayed submitted reply cannot undo a newer Stop event', async () => {
    const page = await contentHarness({ dryRun: false, stopAfterSubmit: true });
    await page.complete(1, 't'); await page.complete(2, 't');
    assert.equal(page.clicked(), 0);
    assert.equal(page.worker.read().session.active, false);
    assert.equal(page.worker.read().session.pending, null);
  });
  await test('a framework that rejects the amount never receives a bet click', async () => {
    const page = await contentHarness({ dryRun: false, rejectAmount: true });
    await page.complete(1, 't'); await page.complete(2, 't');
    assert.equal(page.clicked(), 0); assert.equal(page.worker.read().session.active, false);
    assert.equal(page.worker.read().session.netLossCents, 0); assert.equal(page.worker.read().session.pending, null);
  });
  await test('comma-decimal own-bet amounts confirm an exact stake', async () => {
    const page = await contentHarness({ dryRun: false, commaDecimal: true });
    await page.complete(1, 't'); await page.complete(2, 't');
    assert.equal(page.worker.read().session.pending.status, 'accepted');
    assert.equal(page.clicked(), 1);
  });
  await test('page check rejects selectors that confuse T and CT controls', async () => {
    const page = await contentHarness({ dryRun: false });
    const sameButton = clone(page.config); sameButton.selectors.ctButton = sameButton.selectors.tButton;
    assert.equal((await page.inspect(sameButton)).ready, false);
    const sameOwnBet = clone(page.config); sameOwnBet.selectors.ownCT = sameOwnBet.selectors.ownT;
    assert.equal((await page.inspect(sameOwnBet)).ready, false);
  });
  await test('closed phase still records spinning when the result and amount displays are hidden', async () => {
    const page = await contentHarness({ dryRun: false });
    await page.complete(1, 't'); await page.complete(2, 't');
    page.result.isConnected = false; page.amount.isConnected = false;
    await page.closeRound();
    assert.equal(page.worker.read().session.pending.sawClosed, true);
    assert.equal(page.worker.read().session.active, true);
  });
  await test('defaults migrate old candidate selectors and preserve custom selections', () => {
    const updated = Core.settings({ selectors: {
      amount: 'input[name="betAmount"], input#betAmount, input[data-role="roulette-bet-amount"]',
      tButton: '#my-selected-button'
    } });
    assert.equal(updated.selectors.amount, Core.DEFAULTS.selectors.amount);
    assert.equal(updated.selectors.tButton, '#my-selected-button');
  });
  await test('history detects prepend, append, and identical colors, and refuses ambiguous changes', () => {
    assert.deepEqual(Core.advanceHistory(['T','CT','Dice'], ['CT','Dice','T']), { side: 'T', direction: 'last' });
    assert.deepEqual(Core.advanceHistory(['T','CT','Dice'], ['CT','T','CT']), { side: 'CT', direction: 'first' });
    assert.deepEqual(Core.advanceHistory(['T','T','T'], ['T','T','T']), { side: 'T', direction: 'either' });
    assert.equal(Core.advanceHistory(['T','CT','T','CT'], ['CT','T','CT','T']), null);
    assert.deepEqual(Core.advanceHistory(['T','CT','T','CT'], ['CT','T','CT','T'], 'last'), { side: 'T', direction: 'last' });
    assert.equal(Core.advanceHistory(['T','CT','Dice'], ['Dice','Dice','CT']), null);
  });
  await test('captured site classes and countdown work with the default selectors in simulation', async () => {
    const page = await contentHarness({ siteLayout: true });
    const check = await page.inspect(); assert.equal(check.ready, true, check.error);
    await page.complete(1, 't'); await page.complete(2, 't');
    assert.equal(page.worker.read().session.pending.side, 'CT');
    assert.equal(page.clicked(), 0);
    await page.complete(3, 'bonus');
    assert.equal(page.worker.read().session.losses, 1);
    assert.equal(page.worker.read().session.pending.side, 'CT');
  });
  await test('starting on visible CT or T history immediately uses its existing streak in simulation', async () => {
    for (const direction of ['first', 'last']) {
      for (const target of ['T', 'CT']) {
        const other = target === 'T' ? 'CT' : 'T';
        const chronological = [target, other, other];
        const page = await contentHarness({ siteLayout: true, seedHistory: true, turnsWait: 2, direction,
          initialHistory: direction === 'first' ? [...chronological].reverse() : chronological });
        const state = page.worker.read().session;
        assert.equal(state.pending.side, target);
        assert.equal(state.pending.status, 'accepted');
        assert.equal(state.missingRounds[target], 2);
        assert.equal(state.rounds, 0); assert.equal(state.wins, 0); assert.equal(state.losses, 0);
        assert.equal(page.clicked(), 0);
      }
    }
  });
  await test('idle history tracking learns newest-first order before Start seeds the current streak', async () => {
    const page = await contentHarness({ siteLayout: true, seedHistory: true, autoStart: false,
      direction: 'first', useFallbackSelector: true, initialHistory: ['CT','T','T','CT','T'] });
    await page.complete(1, 'ct');
    assert.equal(page.worker.read().session, null);
    await page.toolbar.start(page.config);
    await page.advance(1200);
    const state = page.worker.read().session;
    assert.equal(state.historyDirection, 'first');
    assert.equal(state.missingRounds.T, 2);
    assert.equal(state.pending.side, 'T'); assert.equal(state.rounds, 0);
  });
  await test('a one-cent site bet commits the input before clicking, then doubles to two cents after Dice', async () => {
    for (const target of ['T', 'CT']) {
      const other = target === 'T' ? 'CT' : 'T';
      const page = await contentHarness({ siteLayout: true, dryRun: false, seedHistory: true,
        commitOnBlur: true, betAmount: '0,01', turnsWait: 3, balance: '10.00', initialHistory: [other, other, other] });
      assert.equal(page.amount.value, '0.01');
      assert.equal(page.amount.focused, false);
      assert.deepEqual(page.clickedAmounts, [1]);
      assert.deepEqual(page.inputEvents, [
        { data: null, inputType: 'deleteContentBackward', composed: true },
        { data: '0.01', inputType: 'insertText', composed: true }
      ]);
      assert.equal(page.worker.read().session.pending.status, 'accepted');
      assert.equal(page.balance.textContent, '9.99');
      await page.complete(1, 'bonus');
      assert.equal(page.amount.value, '0.02');
      assert.deepEqual(page.clickedAmounts, [1, 2]);
      assert.equal(page.worker.read().session.pending.side, target);
      assert.equal(page.worker.read().session.pending.status, 'accepted');
      await page.complete(2, target.toLowerCase());
      assert.equal(page.worker.read().session.nextBetCents, 1);
      assert.equal(page.worker.read().session.netLossCents, -1);
      assert.equal(page.worker.read().session.wins, 1);
    }
  });
  await test('site history order is detected rather than assuming the last icon is always newest', async () => {
    const page = await contentHarness({ siteLayout: true, direction: 'first' });
    await page.complete(1, 'ct'); await page.complete(2, 'ct');
    assert.deepEqual(page.worker.read().session.missingRounds, { T: 2, CT: 0 });
    assert.equal(page.worker.read().session.pending.side, 'T');
    await page.complete(3, 't');
    assert.equal(page.worker.read().session.wins, 1);
  });
  await test('temporary extra history entries during an animation do not break the next round', async () => {
    for (const direction of ['first', 'last']) {
      const page = await contentHarness({ siteLayout: true, animatedHistory: true, direction });
      await page.complete(1, 't'); await page.complete(2, 't');
      assert.equal(page.worker.read().session.active, true);
      assert.equal(page.worker.read().session.pending.side, 'CT');
      await page.complete(3, 'ct');
      assert.equal(page.worker.read().session.wins, 1);
    }
  });
  await test('site live mode confirms the exact balance deduction and ignores a hidden duplicate balance', async () => {
    const page = await contentHarness({ siteLayout: true, dryRun: false });
    const check = await page.inspect(); assert.equal(check.confirmation, 'balance');
    await page.complete(1, 't'); await page.complete(2, 't');
    assert.equal(page.clicked(), 1); assert.equal(page.amount.value, '12.34');
    assert.equal(page.balance.textContent, '87.66');
    assert.equal(page.worker.read().session.pending.status, 'accepted');
    assert.equal(page.worker.read().session.netLossCents, 0);
    await page.complete(3, 'ct');
    assert.equal(page.balance.textContent, '112.34');
    assert.equal(page.worker.read().session.netLossCents, -1234);
  });
  await test('site adapter keeps and doubles either side after Dice across a worker restart until a win', async () => {
    for (const target of ['T', 'CT']) {
      for (const dryRun of [true, false]) {
        const other = target === 'T' ? 'ct' : 't';
        const page = await contentHarness({ siteLayout: true, dryRun, balance: '1000.00' });
        await page.complete(1, other);
        await page.complete(2, 'bonus'); // Dice also completes the initial waiting count.
        let state = page.worker.read().session;
        assert.equal(state.pending.side, target); assert.equal(state.pending.amountCents, 1234);
        await page.complete(3, 'bonus');
        state = page.worker.read().session;
        assert.equal(state.pending.side, target); assert.equal(state.pending.amountCents, 2468);
        assert.equal(state.losses, 1); assert.equal(state.pending.status, 'accepted');
        page.worker.boot();
        await page.complete(4, other);
        state = page.worker.read().session;
        assert.equal(state.pending.side, target); assert.equal(state.pending.amountCents, 4936);
        assert.equal(state.losses, 2); assert.equal(state.pending.status, 'accepted');
        if (!dryRun) assert.equal(page.amount.value, '49.36');
        await page.complete(5, target.toLowerCase());
        state = page.worker.read().session;
        assert.equal(state.active, true); assert.equal(state.pending, null);
        assert.equal(state.chaseSide, null); assert.equal(state.nextBetCents, 1234);
        assert.equal(state.wins, 1); assert.equal(state.losses, 2);
        assert.equal(state.netLossCents, -1234);
        assert.equal(page.clicked(), dryRun ? 0 : 3);
      }
    }
  });
  await test('the countdown disappearing closes betting even without native disabled buttons', async () => {
    const page = await contentHarness({ siteLayout: true, onlyCountdown: true });
    await page.complete(1, 't'); await page.complete(2, 't');
    await page.closeRound();
    assert.equal(page.t.disabled, false); assert.equal(page.t.attrs.disable, 'false');
    assert.equal(page.worker.read().session.pending.sawClosed, true);
  });
  await test('site custom disable=true closes betting even while a countdown element remains', async () => {
    const page = await contentHarness({ siteLayout: true });
    page.t.attrs.disable = 'true'; page.ct.attrs.disable = 'true';
    const check = await page.inspect();
    assert.equal(check.ready, true); assert.equal(check.phase, 'closed');
  });
  await test('an unconfirmed or excessive balance change never fabricates acceptance or loss', async () => {
    for (const options of [{ accept: false }, { extraDebit: 100 }]) {
      const page = await contentHarness({ siteLayout: true, dryRun: false, ...options });
      await page.complete(1, 't'); await page.complete(2, 't');
      assert.equal(page.clicked(), 1);
      assert.equal(page.worker.read().session.active, false);
      assert.equal(page.worker.read().session.losses, 0);
      assert.equal(page.worker.read().session.pending.status, 'submitted');
    }
  });
  await test('insufficient available balance prevents any site bet click', async () => {
    const page = await contentHarness({ siteLayout: true, dryRun: false, balance: '5.00' });
    await page.complete(1, 't'); await page.complete(2, 't');
    assert.equal(page.clicked(), 0);
    assert.equal(page.worker.read().session.active, false);
    assert.equal(page.worker.read().session.netLossCents, 0);
  });
  await test('manifest references real files and popup contains every settings field', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    assert.equal(manifest.minimum_chrome_version, '111');
    assert.deepEqual(manifest.permissions, ['storage']);
    const mainScripts = manifest.content_scripts.filter(script => script.world === 'MAIN');
    assert.equal(mainScripts.length, 1);
    assert.deepEqual(mainScripts[0].js, ['stake-probe.js']);
    assert.equal(mainScripts[0].run_at, 'document_start');
    for (const filename of [manifest.background.service_worker, manifest.action.default_popup, ...manifest.content_scripts.flatMap(item => item.js), 'popup.css', 'popup.js']) assert.ok(fs.existsSync(path.join(root, filename)), filename);
    const html = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
    for (const key of Object.keys(Core.DEFAULTS.selectors)) assert.ok(html.includes(`id="${key}Selector"`), key);
    assert.ok(!manifest.icons, 'Package has no missing icon.png dependency.');
  });
  await require('./toolbar.cjs')(test);
  console.log(`\n${passed} tests passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
