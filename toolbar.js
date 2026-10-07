/* Persistent page controls; a closed shadow root keeps website styles and selectors separate. */
(() => {
  'use strict';
  const Core = RouletteCore;
  const HEIGHT_VAR = '--csgo-roulette-bot-height';
  const FIELDS = [
    ['history', 'Result history icons', false],
    ['result', 'Latest / newest history result', true],
    ['tButton', 'T bet button', true],
    ['ctButton', 'CT bet button', true],
    ['amount', 'Bet amount input', true],
    ['countdown', 'Betting countdown', true],
    ['balance', 'Account balance', true],
    ['ownT', 'Accepted T amount (optional)', true],
    ['ownCT', 'Accepted CT amount (optional)', true],
    ['closed', 'Spinning marker (optional)', true]
  ];
  const CSS_TEXT = [
    ':host { color-scheme: dark; }',
    '* { box-sizing: border-box; }',
    '[hidden] { display: none !important; }',
    '.shell { padding: 8px 16px; background: #171d27; color: #eef1f7; border-bottom: 2px solid #e59b38; box-shadow: 0 3px 16px #0005; font: 13px/1.35 "Segoe UI", Arial, sans-serif; }',
    '.summary, .controls, .metrics, .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; }',
    '.summary { margin-bottom: 7px; }',
    '.brand { font-size: 14px; font-weight: 700; white-space: nowrap; }',
    '.badge { border: 1px solid #496581; border-radius: 5px; padding: 2px 7px; color: #a8d9ff; font-size: 11px; font-weight: 600; }',
    '.badge.live { border-color: #97632d; color: #ffd190; }',
    '.phase { flex: 1 1 220px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #bfc8d9; }',
    '.phase.active { color: #9fe0b0; }',
    '.phase.error { color: #ffb1ac; }',
    '.metrics { gap: 12px; font-size: 12px; color: #9eabc0; }',
    '.metrics b { color: #eef1f7; font-weight: 600; font-variant-numeric: tabular-nums; }',
    'label { display: flex; align-items: center; gap: 6px; white-space: nowrap; color: #bcc7d8; font-size: 12px; }',
    'input, select, button { font: inherit; border-radius: 5px; min-height: 32px; }',
    'input, select { padding: 5px 7px; border: 1px solid #45516a; background: #232d3f; color: #fff; }',
    'input { width: 87px; }',
    '#turnsWait { width: 73px; }',
    '#stopLoss { width: 104px; }',
    '#mode { width: 133px; }',
    'button { padding: 5px 12px; border: 1px solid transparent; cursor: pointer; background: #d89234; color: #161b23; font-weight: 600; white-space: nowrap; }',
    'button:hover:enabled { filter: brightness(1.12); }',
    'button:disabled, input:disabled, select:disabled { opacity: .5; cursor: default; }',
    'button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid #a8d9ff; outline-offset: 2px; }',
    '.stop { background: #b8403f; color: #fff; }',
    '.secondary { background: #303d53; color: #e1e9f7; border-color: #495978; }',
    '.quiet { background: transparent; color: #b8c7df; border-color: #45516a; }',
    '.actions { gap: 7px; }',
    '.setup { border-top: 1px solid #364257; margin-top: 9px; padding-top: 9px; max-height: 55vh; overflow: auto; }',
    '.selectors { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 9px 14px; }',
    '.selector { display: grid; grid-template-columns: 1fr auto; gap: 4px 6px; }',
    '.selector label { grid-column: 1 / -1; }',
    '.selector input { width: 100%; min-width: 0; font: 11px/1.3 Consolas, monospace; }',
    '.selector input.wide { grid-column: 1 / -1; }',
    '.selector button { font-size: 11px; padding: 4px 9px; }',
    '.setup-actions { margin-top: 10px; }',
    '.hint { margin: 8px 0 0; color: #a6b3c9; font-size: 11px; }',
    '@media (max-width: 700px) { .shell { padding: 7px 9px; } .controls { gap: 7px 10px; } .metrics { gap: 8px; } .phase { flex-basis: 100%; order: 3; } }'
  ].join('\n');

  function mount(callbacks) {
    const host = document.createElement('div');
    host.id = 'csgo-roulette-bot-toolbar';
    host.style.cssText = 'all:initial!important;display:block!important;position:fixed!important;top:0!important;left:0!important;right:0!important;width:100%!important;z-index:2147483646!important;isolation:isolate!important;color-scheme:dark!important';
    const shadow = host.attachShadow({ mode: 'closed' });
    const selectors = FIELDS.map(([key, label, pick]) =>
      '<div class="selector"><label for="' + key + 'Selector">' + label + '</label>' +
      '<input id="' + key + 'Selector" type="text" spellcheck="false"' + (pick ? '' : ' class="wide"') + '>' +
      (pick ? '<button type="button" class="secondary" data-pick="' + key + '">Pick</button>' : '') + '</div>'
    ).join('');
    shadow.innerHTML = '<style>' + CSS_TEXT + '</style>' + [
      '<section class="shell" aria-label="Roulette bot controls">',
      '<div class="summary"><span class="brand">Roulette Bot</span><span id="modeTag" class="badge">Simulation</span>',
      '<span id="phase" class="phase" role="status">Connecting…</span>',
      '<div class="metrics"><span title="Positive means profit; negative means loss">Net profit <b id="netProfit">0.00</b></span>',
      '<span>Next bet <b id="nextBet">10.00</b></span><span>Wins <b id="wins">0</b> · Losses <b id="losses">0</b></span>',
      '<span>Without T <b id="withoutT">0</b> · CT <b id="withoutCT">0</b></span>',
      '<span title="Elapsed time since Start; stops when the session stops">Runtime <b id="runtime">00:00:00</b></span></div></div>',
      '<form id="settingsForm" class="controls">',
      '<label for="betAmount">Base bet <input id="betAmount" type="text" inputmode="decimal" title="Minimum 0.01; comma or point accepted" required></label>',
      '<label for="turnsWait">Bet after streak <input id="turnsWait" type="number" min="1" max="100000" step="1" required></label>',
      '<label for="stopLoss">Stop loss <input id="stopLoss" type="text" inputmode="decimal" title="Net coins lost; 0 disables the limit" required></label>',
      '<label for="mode">Mode <select id="mode"><option value="simulation">Simulation</option><option value="live">Live betting</option></select></label>',
      '<div class="actions"><button id="start" type="submit">Save &amp; Start</button><button id="stop" class="stop" type="button">Stop</button>',
      '<button id="setupToggle" type="button" class="secondary" aria-expanded="false" aria-controls="setup">Page setup</button>',
      '<button id="reset" type="button" class="quiet">Reset session</button></div></form>',
      '<div id="setup" class="setup" hidden><div class="controls">',
      '<label for="betBeforeSeconds">Bet with seconds left <input id="betBeforeSeconds" type="number" min="6" max="60" step="0.1" required></label>',
      '<label for="timingVarianceSeconds">Timing variation ± seconds <input id="timingVarianceSeconds" type="number" min="0" max="2" step="0.1" title="0 gives a fixed placement time" required></label></div>',
      '<p class="hint">Default placement is near 10 seconds remaining. Counting continues while waiting. Set variation to 0 for fixed timing.</p>',
      '<div class="selectors">' + selectors + '</div>',
      '<div class="actions setup-actions"><button id="check" type="button" class="secondary">Check page</button>',
      '<button id="save" type="button" class="secondary">Save without starting</button></div>',
      '<p class="hint">Dice counts toward missing coins. Every loss doubles the next stake on the same coin; only a win resets it. Stop loss still applies.</p>',
      '<p class="hint">Reset clears local session tracking. It does not cancel a bet on the website.</p></div></section>'
    ].join('');
    document.body.appendChild(host);
    const byId = id => shadow.getElementById(id);
    const fields = [...shadow.querySelectorAll('input, select')];
    const pickButtons = [...shadow.querySelectorAll('[data-pick]')];
    let state = { config: Core.settings(), session: null, revision: -1 };
    let lastConfig = '';
    let working = false;
    let stopping = false;
    let unavailable = false;
    let destroyed = false;
    let height = -1;
    let feedback = null;
    for (const id of ['betAmount', 'stopLoss']) {
      const input = byId(id);
      input.addEventListener('input', () => { input.value = input.value.replace(/,/g, '.'); });
      input.addEventListener('blur', () => {
        try { input.value = Core.formatAmount(Core.cents(input.value, id === 'betAmount' ? 'Base bet' : 'Stop loss', id === 'stopLoss')); }
        catch { /* Keep invalid edits visible; submission displays the validation error. */ }
      });
    }

    // Reserve actual measured space for the bar and move the captured fixed balance header down.
    const layoutSheet = document.createElement('style');
    const originalHeight = document.documentElement.style.getPropertyValue(HEIGHT_VAR);
    const originalPriority = document.documentElement.style.getPropertyPriority(HEIGHT_VAR);
    const bodyPadding = parseFloat(getComputedStyle(document.body).paddingTop) || 0;
    const bodyRule = 'body { padding-top: calc(' + bodyPadding + 'px + var(' + HEIGHT_VAR + ', 0px)) !important; }';
    layoutSheet.textContent = bodyRule;
    document.head.appendChild(layoutSheet);
    let shiftedHeader = null;
    let shiftedPosition = '';

    function refreshLayout() {
      if (destroyed) return;
      text('runtime', Core.runtime(state.session, Date.now()));
      if (!host.isConnected) document.body.appendChild(host);
      if (!layoutSheet.isConnected) document.head.appendChild(layoutSheet);
      const header = document.getElementById('empire-header');
      const position = header ? getComputedStyle(header).position : '';
      if (header !== shiftedHeader || position !== shiftedPosition) {
        layoutSheet.textContent = bodyRule;
        shiftedHeader = header;
        shiftedPosition = position;
        if (header && ['fixed', 'sticky'].includes(position)) {
          const top = parseFloat(getComputedStyle(header).top) || 0;
          layoutSheet.textContent = bodyRule + '\n#empire-header { top: calc(' + top +
            'px + var(' + HEIGHT_VAR + ', 0px)) !important; }';
        }
      }
    }
    function measure() {
      if (destroyed) return;
      const measured = Math.ceil(host.getBoundingClientRect().height);
      if (height !== measured) {
        height = measured;
        document.documentElement.style.setProperty(HEIGHT_VAR, height + 'px');
      }
      refreshLayout();
    }
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(host);
    window.addEventListener('resize', measure);

    function text(id, value) {
      const element = byId(id);
      const next = String(value);
      if (element.textContent !== next) element.textContent = next;
    }
    function fill(config) {
      byId('betAmount').value = Core.formatAmount(Core.cents(config.betAmount, 'Base bet'));
      byId('turnsWait').value = config.turnsWait;
      byId('stopLoss').value = Core.formatAmount(Core.cents(config.stopLoss, 'Stop loss', true));
      byId('mode').value = config.dryRun ? 'simulation' : 'live';
      byId('betBeforeSeconds').value = config.betBeforeSeconds;
      byId('timingVarianceSeconds').value = config.timingVarianceSeconds;
      for (const [key] of FIELDS) byId(key + 'Selector').value = config.selectors[key];
    }
    function configuration() {
      const selectors = {};
      for (const [key] of FIELDS) selectors[key] = byId(key + 'Selector').value;
      const config = Core.settings({
        ...state.config, betAmount: byId('betAmount').value, turnsWait: byId('turnsWait').value,
        stopLoss: byId('stopLoss').value, dryRun: byId('mode').value !== 'live', selectors,
        betBeforeSeconds: byId('betBeforeSeconds').value, timingVarianceSeconds: byId('timingVarianceSeconds').value
      });
      byId('betAmount').value = Core.formatAmount(Core.cents(config.betAmount, 'Base bet'));
      byId('stopLoss').value = Core.formatAmount(Core.cents(config.stopLoss, 'Stop loss', true));
      return config;
    }
    function render() {
      const session = state.session;
      const foreign = !!session && state.tabId !== undefined && session.tabId !== state.tabId;
      const locked = unavailable || working || !!session?.active || !!session?.pending;
      const config = session?.config || state.config;
      text('modeTag', config.dryRun ? 'Simulation' : 'Live');
      byId('modeTag').className = config.dryRun ? 'badge' : 'badge live';
      const detail = feedback?.message || session?.status || 'Idle — ready to start.';
      text('phase', (foreign && !feedback ? 'Another tab: ' : '') + (unavailable ? detail : Core.displayStatus(session, detail)));
      byId('phase').title = byId('phase').textContent;
      byId('phase').className = feedback?.error ? 'phase error' : session?.active && !foreign && !unavailable ? 'phase active' : 'phase';
      text('netProfit', (-(session?.netLossCents || 0) / 100).toFixed(2));
      text('nextBet', (session ? session.nextBetCents / 100 : state.config.betAmount).toFixed(2));
      text('wins', session?.wins || 0);
      text('losses', session?.losses || 0);
      text('withoutT', (session?.countsLowerBound?.T ? '≥' : '') + (session?.missingRounds?.T || 0));
      text('withoutCT', (session?.countsLowerBound?.CT ? '≥' : '') + (session?.missingRounds?.CT || 0));
      for (const field of fields) field.disabled = locked;
      for (const button of pickButtons) button.disabled = locked;
      byId('start').disabled = locked;
      // Stop stays usable while a different control awaits a worker reply.
      byId('stop').disabled = unavailable || stopping || !session?.active || foreign;
      byId('reset').disabled = unavailable || working || !!session?.active || foreign || !session;
      byId('save').disabled = locked;
      byId('check').disabled = unavailable || working;
      byId('setupToggle').disabled = unavailable;
      measure();
    }
    function notice(message = '', error = false) {
      feedback = message ? { message, error } : null;
      render();
    }
    async function run(action) {
      if (working || unavailable) return;
      working = true;
      notice();
      render();
      try { await action(); }
      catch (error) {
        if (/Extension context invalidated/i.test(error.message)) invalidate('Extension updated. Refresh this tab.');
        else notice(error.message, true);
      } finally { working = false; render(); }
    }
    function setup(open) {
      byId('setup').hidden = !open;
      byId('setupToggle').setAttribute('aria-expanded', String(open));
      measure();
    }
    byId('settingsForm').addEventListener('submit', event => {
      event.preventDefault();
      void run(async () => {
        const config = configuration();
        await callbacks.start(config);
      });
    });
    byId('stop').addEventListener('click', async () => {
      if (stopping || unavailable) return;
      stopping = true;
      render();
      try {
        await callbacks.stop();
      } catch (error) { notice(error.message, true); }
      finally { stopping = false; render(); }
    });
    byId('reset').addEventListener('click', () => void run(async () => {
      await callbacks.reset();
    }));
    byId('check').addEventListener('click', () => void run(async () => notice(await callbacks.check(configuration()))));
    byId('save').addEventListener('click', () => void run(async () => {
      await callbacks.save(configuration());
    }));
    byId('setupToggle').addEventListener('click', () => setup(byId('setup').hidden));
    for (const button of pickButtons) {
      button.addEventListener('click', () => void run(async () => {
        const config = configuration();
        setup(false);
        await callbacks.pick(button.dataset.pick, config);
      }));
    }
    function update(next) {
      if (destroyed || next.revision < state.revision) return;
      if (next.revision > state.revision && !unavailable) feedback = null;
      state = next;
      const signature = JSON.stringify(state.config);
      if (signature !== lastConfig) {
        fill(state.config);
        lastConfig = signature;
      }
      render();
    }
    function invalidate(message) {
      unavailable = true;
      notice(message, true);
    }
    function destroy() {
      destroyed = true;
      resizeObserver.disconnect();
      window.removeEventListener('resize', measure);
      host.remove();
      layoutSheet.remove();
      if (originalHeight) document.documentElement.style.setProperty(HEIGHT_VAR, originalHeight, originalPriority);
      else document.documentElement.style.removeProperty(HEIGHT_VAR);
    }
    update(state);
    return { update, invalidate, refreshLayout, destroy,
      contains: element => element === host || host.contains(element),
      get height() { return Math.max(0, height); } };
  }
  globalThis.RouletteToolbar = { mount };
})();
