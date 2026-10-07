/* Shared, deterministic strategy and accounting. All amounts use integer cents. */
(() => {
  'use strict';
  const DEFAULTS = {
    betAmount: 10, turnsWait: 5, strategy: 'martingale', stopLoss: 1000,
    dryRun: true, betBeforeSeconds: 10, timingVarianceSeconds: 0.5,
    selectors: {
      amount: '[data-testid="roulette-bet-input"] input[inputmode="decimal"]',
      tButton: '#bet-button-t',
      ctButton: '#bet-button-ct',
      result: '[data-testid="previous-rolls-item"]:last-child > div',
      history: '[data-testid="previous-rolls-item"] > div',
      countdown: '[data-testid="countdown-time"]',
      balance: '[data-testid="balance"] [data-testid="currency-amount"]',
      closed: '', ownT: '', ownCT: ''
    }
  };
  // Replace only the previous release's candidate defaults; preserve custom selections.
  const LEGACY_SELECTORS = {
    amount: 'input[name="betAmount"], input#betAmount, input[data-role="roulette-bet-amount"]',
    tButton: 'button[data-side="t"], button[data-color="red"], button.bet-button.red',
    ctButton: 'button[data-side="ct"], button[data-color="black"], button.bet-button.black',
    result: '.roulette-result-display, .roulette__result'
  };
  function cents(value, name, allowZero = false) {
    if (value === '' || value === null || value === undefined) throw new Error(`${name} is required.`);
    const normalized = typeof value === 'string' ? value.trim().replace(',', '.') : value;
    if (!['string', 'number'].includes(typeof normalized) ||
        (typeof normalized === 'string' && !/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(normalized))) {
      throw new Error(`${name} must be ${allowZero ? 'zero or ' : ''}positive with at most two decimals.`);
    }
    const number = Number(normalized);
    const amount = Math.round(number * 100);
    if (!Number.isFinite(number) || !Number.isSafeInteger(amount) ||
        amount < (allowZero ? 0 : 1) || Math.abs(number * 100 - amount) > 0.000001) {
      throw new Error(`${name} must be ${allowZero ? 'zero or ' : ''}positive with at most two decimals.`);
    }
    return amount;
  }
  function formatAmount(amountCents) {
    if (!Number.isSafeInteger(amountCents) || amountCents < 0) throw new Error('Invalid amount in cents.');
    return `${Math.floor(amountCents / 100)}.${String(amountCents % 100).padStart(2, '0')}`;
  }
  function settings(input = {}) {
    const merged = { ...DEFAULTS, ...input };
    const result = {
      betAmount: cents(merged.betAmount, 'Base bet') / 100,
      stopLoss: cents(merged.stopLoss, 'Stop loss', true) / 100,
      turnsWait: Number(merged.turnsWait),
      strategy: merged.strategy,
      dryRun: merged.dryRun !== false,
      betBeforeSeconds: Number(String(merged.betBeforeSeconds).replace(',', '.')),
      timingVarianceSeconds: Number(String(merged.timingVarianceSeconds).replace(',', '.')),
      selectors: { ...DEFAULTS.selectors, ...(input.selectors || {}) }
    };
    for (const [key, oldSelector] of Object.entries(LEGACY_SELECTORS)) {
      if (result.selectors[key] === oldSelector) result.selectors[key] = DEFAULTS.selectors[key];
    }
    if (!Number.isInteger(result.turnsWait) || result.turnsWait < 1 || result.turnsWait > 100000) {
      throw new Error('Bet after streak must be a whole number of at least 1.');
    }
    if (result.strategy !== 'martingale') throw new Error('Unsupported strategy.');
    if (!Number.isFinite(result.betBeforeSeconds) || result.betBeforeSeconds < 6 || result.betBeforeSeconds > 60) {
      throw new Error('Bet timing must be between 6 and 60 seconds remaining.');
    }
    if (merged.timingVarianceSeconds === '' || merged.timingVarianceSeconds === null ||
        !Number.isFinite(result.timingVarianceSeconds) || result.timingVarianceSeconds < 0 ||
        result.timingVarianceSeconds > 2 || result.betBeforeSeconds - result.timingVarianceSeconds < 5) {
      throw new Error('Timing variation must be between 0 and 2 seconds and leave at least 5 seconds for placement.');
    }
    for (const key of Object.keys(DEFAULTS.selectors)) {
      if (typeof result.selectors[key] !== 'string' || result.selectors[key].length > 1500) {
        throw new Error(`Invalid ${key} selector.`);
      }
      result.selectors[key] = result.selectors[key].trim();
    }
    return result;
  }
  function missingFromHistory(history) {
    if (!Array.isArray(history) || history.length > 1000) throw new Error('Invalid result history.');
    const counts = { T: 0, CT: 0 };
    for (const result of history) {
      if (!['T', 'CT', 'Dice'].includes(result)) throw new Error('Unknown result in history.');
      for (const side of ['T', 'CT']) counts[side] = result === side ? 0 : counts[side] + 1;
    }
    return counts;
  }
  function placementWindow(seconds, targetSeconds) {
    if (!Number.isFinite(seconds) || !Number.isFinite(targetSeconds) || seconds <= 0) return 'unavailable';
    if (seconds < 5) return 'late';
    return seconds > targetSeconds ? 'waiting' : 'ready';
  }
  function create(config, tabId, documentId, sessionId, initialHistory = [], historyDirection = null, now = Date.now()) {
    const counts = missingFromHistory(initialHistory);
    return {
      id: sessionId, tabId, documentId, config, active: true,
      startedAt: now, stoppedAt: null,
      status: config.dryRun ? 'Simulation running — waiting for completed rounds.' : 'Running — waiting for completed rounds.',
      netLossCents: 0, nextBetCents: cents(config.betAmount, 'Base bet'),
      missingRounds: counts, chaseSide: null,
      historyInitialized: initialHistory.length > 0, historyDirection,
      lastOpenKey: null, lastResultKey: null, lastResultSide: null, pending: null, waitingRoundKey: null,
      rounds: 0, wins: 0, losses: 0
    };
  }
  function pause(session, reason, now = Date.now()) {
    if (!Number.isFinite(session.stoppedAt)) session.stoppedAt = now;
    session.active = false;
    session.waitingRoundKey = null;
    session.status = reason;
  }
  function stop(session, now = Date.now()) {
    session.userStopped = true;
    pause(session, 'Stopped', now);
    if (session.pending?.status === 'reserved') session.pending = null;
    session.status = session.pending ? 'Stopped — still waiting for the outstanding bet.' : 'Stopped';
  }
  function runtime(session, now = Date.now()) {
    if (!Number.isFinite(session?.startedAt)) return '00:00:00';
    const end = Number.isFinite(session.stoppedAt) ? session.stoppedAt : session.active ? now : session.startedAt;
    const seconds = Number.isFinite(end) ? Math.max(0, Math.floor((end - session.startedAt) / 1000)) : 0;
    return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
      .map(value => String(value).padStart(2, '0')).join(':');
  }
  function displayStatus(session, detail = session?.status || 'Idle') {
    return session?.active && (session.chaseSide || session.pending) && !detail.startsWith('Betting — ')
      ? `Betting — ${detail}` : detail;
  }
  function normalizeSide(value) {
    const tokens = String(value || '').toLowerCase().replace(/counter[-_ ]terrorists?/g, 'counterterrorist').split(/[^a-z]+/).filter(Boolean);
    const sides = new Set();
    for (const token of tokens) {
      if (['t', 'red', 'terrorist', 'terrorists'].includes(token)) sides.add('T');
      if (['ct', 'black', 'counterterrorist', 'counterterrorists'].includes(token)) sides.add('CT');
      if (['dice', 'green', 'bonus'].includes(token)) sides.add('Dice');
    }
    return sides.size === 1 ? [...sides][0] : null;
  }
  function advanceHistory(before, after, direction = null) {
    if (!Array.isArray(before) || !Array.isArray(after) || !before.length || !after.length) return null;
    const equal = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
    let prepend = false;
    let append = false;
    if (after.length === before.length) {
      prepend = equal(after.slice(1), before.slice(0, -1));
      append = equal(after.slice(0, -1), before.slice(1));
    } else if (after.length === before.length + 1) {
      prepend = equal(after.slice(1), before);
      append = equal(after.slice(0, -1), before);
    }
    if (direction === 'first') return prepend ? { side: after[0], direction } : null;
    if (direction === 'last') return append ? { side: after.at(-1), direction } : null;
    if (prepend && append && after[0] !== after.at(-1)) return null;
    if (!prepend && !append) return null;
    return { side: prepend ? after[0] : after.at(-1), direction: prepend && append ? 'either' : prepend ? 'first' : 'last' };
  }
  function checkpoint(session, page, now = Date.now()) {
    if (!page || !['open', 'closed'].includes(page.phase)) return;
    const previous = session.checkpoint || {};
    if (page.phase === 'closed') {
      session.checkpoint = { ...previous, phase: 'closed', observedAt: now };
      if (typeof page.hasWheel === 'boolean') session.checkpoint.hasWheel = page.hasWheel;
      return;
    }
    if (!Array.isArray(page.history) || !page.history.length || page.history.length > 100 ||
        page.history.some(side => !['T', 'CT', 'Dice'].includes(side))) return;
    session.checkpoint = {
      phase: 'open', history: [...page.history], historyDirection: page.historyDirection || previous.historyDirection || 'last',
      seconds: Number.isFinite(page.seconds) ? page.seconds : null,
      identity: page.identity || null, hasWheel: !!page.hasWheel,
      observedAt: now, historyAt: now,
      openKey: session.lastOpenKey, resultKey: session.lastResultKey
    };
  }
  function loading(session, reason, now = Date.now()) {
    if (!session.active) return;
    if (!session.recovery) session.recovery = { since: now, reloads: 0 };
    if (session.pending?.status === 'reserved') session.pending = null;
    session.recovery.reason = String(reason || 'Roulette controls temporarily unavailable.').slice(0, 500);
    session.status = 'Loading — preserving the session and waiting for roulette controls.';
  }
  // Return every overlapping chronological path, rather than guessing how many
  // identical rolls occurred while the page was absent. A full replaced window
  // with no overlap cannot establish which spin belongs to an outstanding bet.
  function recoveryPaths(before, after) {
    if (!Array.isArray(before) || !Array.isArray(after) || !before.length || !after.length) return [];
    const paths = [];
    if (before.length === after.length && before.every((side, index) => side === after[index])) paths.push([]);
    for (let count = 1; count < after.length; count++) {
      const overlap = Math.min(before.length, after.length - count);
      if (overlap > 0 && before.slice(-overlap).every((side, index) => side === after[after.length - count - overlap + index])) {
        paths.push(after.slice(-count));
      }
    }
    return paths;
  }
  function settle(session, pending, side) {
    const win = side === pending.side;
    session.netLossCents += win ? -pending.amountCents : pending.amountCents;
    if (win) {
      session.wins++;
      session.chaseSide = null;
      session.nextBetCents = cents(session.config.betAmount, 'Base bet');
    } else {
      session.losses++;
      session.chaseSide = pending.side;
      session.nextBetCents = pending.amountCents * 2;
    }
    session.pending = null;
    return win;
  }
  function recover(session, page, now = Date.now()) {
    if (session.needsReview || (!session.active && session.pending?.status !== 'accepted') || !session.recovery || page.phase !== 'open') return false;
    const halt = reason => {
      session.needsReview = !!session.pending;
      session.recovery = null;
      pause(session, reason, now);
      return false;
    };
    const previous = session.checkpoint;
    // An armed startup has placed no bet and established no betting window.
    // After a reload, seed it from the first readable completed history rather
    // than inventing results for the spin during which Start was pressed.
    if (session.lastOpenKey === null && !session.pending && !session.chaseSide &&
        Array.isArray(page.history) && page.history.length > 0 && page.history.length <= 100 &&
        page.history.every(side => ['T', 'CT', 'Dice'].includes(side)) && page.openKey && page.resultKey) {
      session.missingRounds = missingFromHistory(page.history);
      session.historyInitialized = true;
      session.historyDirection = page.historyDirection || session.historyDirection;
      session.lastOpenKey = page.openKey;
      session.lastResultKey = page.resultKey;
      session.lastResultSide = page.history.at(-1);
      session.waitingRoundKey = page.openKey;
      session.recovery = null;
      checkpoint(session, page, now);
      session.status = 'Running — current history scanned; waiting for the next betting window.';
      return true;
    }
    if (!previous?.history?.length || !Array.isArray(page.history) || !page.history.length || page.history.length > 100 ||
        page.history.some(side => !['T', 'CT', 'Dice'].includes(side)) || !page.openKey || !page.resultKey) {
      return halt('Recovery needs a readable saved result history. Check the outstanding bet before resetting.');
    }
    if (session.pending && session.pending.status !== 'accepted') {
      return halt('Recovery stopped: the outstanding bet was not confirmed. Check it before resetting.');
    }
    const elapsed = now - previous.historyAt;
    const same = previous.history.length === page.history.length && previous.history.every((side, index) => side === page.history[index]);
    // The old countdown still covers the entire interruption: no roll could
    // have completed yet. Outside that window, equal icons alone are not proof.
    const sameWindow = same && previous.phase === 'open' && elapsed >= 0 &&
      Number.isFinite(previous.seconds) && elapsed < Math.max(0, previous.seconds - 1) * 1000 &&
      Number.isFinite(page.seconds) && page.seconds <= previous.seconds + 1 &&
      (!previous.identity || previous.identity === page.identity);
    let paths = sameWindow ? [[]] : recoveryPaths(previous.history, page.history);
    const resetCountdown = previous.phase === 'closed' || (Number.isFinite(previous.seconds) && Number.isFinite(page.seconds) &&
      page.seconds > Math.max(0, previous.seconds - elapsed / 1000) + 2) ||
      (previous.identity && page.identity && previous.identity !== page.identity);
    if (resetCountdown && !sameWindow) paths = paths.filter(path => path.length > 0);
    if (!paths.length) {
      return halt('Recovery stopped: recent history cannot be matched to the saved round. No further bet placed.');
    }
    const pending = session.pending;
    if (pending) {
      const outcomes = new Set(paths.map(path => path.length ? (path[0] === pending.side ? 'win' : 'loss') : 'waiting'));
      if (outcomes.size !== 1) {
        return halt('Recovery stopped: the outstanding bet result is ambiguous. Check it before resetting.');
      }
    }
    const chase = session.chaseSide || pending?.side;
    const missedWin = chase && paths.some(path => {
      if (pending && path.length && path[0] === pending.side) return false; // Its accepted win was not missed.
      return path.slice(pending ? 1 : 0).includes(chase);
    });
    if (pending && paths[0].length) settle(session, pending, paths[0][0]);
    const counts = paths.map(path => {
      const result = { ...session.missingRounds };
      const lower = { ...(session.countsLowerBound || {}) };
      for (const side of path) for (const coin of ['T', 'CT']) {
        result[coin] = side === coin ? 0 : result[coin] + 1;
        if (side === coin) lower[coin] = false;
      }
      return { result, lower };
    });
    session.countsLowerBound = {};
    for (const side of ['T', 'CT']) {
      session.missingRounds[side] = Math.min(...counts.map(value => value.result[side]));
      session.countsLowerBound[side] = counts.some(value => value.lower[side]) ||
        new Set(counts.map(value => value.result[side])).size > 1;
    }
    session.rounds += Math.min(...paths.map(path => path.length));
    session.lastOpenKey = page.openKey;
    session.lastResultKey = page.resultKey;
    session.lastResultSide = page.history.at(-1);
    session.historyDirection = page.historyDirection || session.historyDirection;
    session.waitingRoundKey = page.openKey;
    if (session.pending) {
      session.pending.roundKey = page.openKey;
      session.pending.baselineResultKey = page.resultKey;
    }
    session.recovery = null;
    checkpoint(session, page, now);
    if (missedWin) {
      pause(session, `Stopped: a ${chase} winning round was missed while the page was unavailable. No further bet placed.`, now);
      return false;
    }
    session.status = session.active ? (session.pending ? `Waiting for the ${session.pending.side} bet result.` : 'Recovered — checking the next betting window.')
      : session.pending ? 'Stopped — still waiting for the outstanding bet.' : 'Stopped';
    return true;
  }
  function observe(session, observation, newId) {
    if (session.recovery || session.needsReview) return null;
    if (observation.phase === 'closed') {
      if (session.chaseSide && !session.pending && session.waitingRoundKey) session.skippedChaseRoundKey = session.waitingRoundKey;
      session.waitingRoundKey = null;
      if (session.pending) session.pending.sawClosed = true;
      return null;
    }
    if (observation.phase !== 'open' || !observation.openKey || !observation.resultKey ||
        !['T', 'CT', 'Dice'].includes(observation.side)) return null;

    // Seed visible results once. They describe the current streak, not past bot bets.
    if (session.lastOpenKey === null) {
      session.lastOpenKey = observation.openKey;
      session.lastResultKey = observation.resultKey;
      session.lastResultSide = observation.side;
      if (observation.initialHistory?.length) {
        session.missingRounds = missingFromHistory(observation.initialHistory);
        session.historyInitialized = true;
      }
      if (observation.historyDirection) session.historyDirection = observation.historyDirection;
      return session.historyInitialized ? reserveBet(session, observation, newId) : null;
    }
    if (session.lastOpenKey === observation.openKey) {
      if (session.lastResultKey !== observation.resultKey || session.lastResultSide !== observation.side) {
        pause(session, 'A result changed without an observed spin. Check the page and reset the session.');
        return null;
      }
      return session.waitingRoundKey === observation.openKey && !session.pending
        ? reserveBet(session, observation, newId) : null;
    }
    // If the site provides IDs, wait until the completed result actually changes.
    if (session.lastResultKey === observation.resultKey) return null;

    const missedChaseWin = !session.pending && session.chaseSide && session.skippedChaseRoundKey &&
      observation.side === session.chaseSide;

    if (session.pending) {
      const pending = session.pending;
      if (pending.status === 'reserved') {
        session.pending = null;
        pause(session, 'The round ended before the bet was placed. No bet or loss was recorded.');
        return null;
      }
      if (pending.status !== 'accepted') {
        if (session.active) pause(session, 'Bet was submitted but acceptance was not confirmed. Check the page before resetting.');
        return null; // Keep the original placement/acceptance error visible on later rounds.
      }
      if (!pending.sawClosed) {
        pause(session, 'Bet accepted, but its spin was not observed. Check the result before resetting.');
        return null;
      }
      // Every other result, including Dice, loses this bet. Only a win ends the chase.
      settle(session, pending, observation.side);
    }
    session.lastOpenKey = observation.openKey;
    session.waitingRoundKey = null;
    session.lastResultKey = observation.resultKey;
    session.lastResultSide = observation.side;
    if (observation.historyDirection) session.historyDirection = observation.historyDirection;
    session.rounds++;
    session.skippedChaseRoundKey = null;
    if (!session.missingRounds) {
      // Retain the counter known by older sessions without changing a pending stake.
      const count = Number.isSafeInteger(session.streakCount) ? session.streakCount : 0;
      session.missingRounds = {
        T: session.streakSide === 'CT' ? count : 0,
        CT: session.streakSide === 'T' ? count : 0
      };
    }
    for (const side of ['T', 'CT']) {
      session.missingRounds[side] = observation.side === side ? 0 : session.missingRounds[side] + 1;
      if (observation.side === side && session.countsLowerBound) session.countsLowerBound[side] = false;
    }
    if (missedChaseWin) {
      pause(session, `Stopped: a ${session.chaseSide} winning round was missed when its bet could not be placed. No further bet placed.`);
      return null;
    }
    return reserveBet(session, observation, newId);
  }
  function reserveBet(session, observation, newId) {
    if (!session.active) {
      session.status = 'Stopped';
      return null;
    }
    const limit = cents(session.config.stopLoss, 'Stop loss', true);
    if (limit > 0 && session.netLossCents >= limit) {
      pause(session, 'Stop loss reached.');
      return null;
    }
    let side = session.chaseSide;
    if (!side && Math.max(session.missingRounds.T, session.missingRounds.CT) >= session.config.turnsWait) {
      // Choose the longer absence; use T for a tie. An existing chase always takes priority.
      side = session.missingRounds.T >= session.missingRounds.CT ? 'T' : 'CT';
    }
    if (!side) {
      session.waitingRoundKey = null;
      session.status = `Waiting — without T: ${session.missingRounds.T}/${session.config.turnsWait}; without CT: ${session.missingRounds.CT}/${session.config.turnsWait}.`;
      return null;
    }
    if (observation.placementWindow === 'unavailable') {
      pause(session, 'Betting countdown could not be read; no bet placed. Use Check page.');
      return null;
    }
    if (observation.placementWindow === 'late') {
      if (session.chaseSide && !session.pending) session.skippedChaseRoundKey = observation.openKey;
      session.waitingRoundKey = null;
      session.status = `Skipped ${side} bet: fewer than 5 seconds remain. Waiting for the next round.`;
      return null;
    }
    if (observation.placementWindow === 'waiting' ||
        (observation.placementWindow === 'ready' && !observation.controlsReady)) {
      session.waitingRoundKey = observation.openKey;
      session.status = observation.placementWindow === 'waiting'
        ? `Waiting to place ${side} bet with ${observation.betAtSeconds.toFixed(1)} seconds remaining.`
        : `Waiting for the ${side} betting controls to become ready.`;
      return null;
    }
    if (!observation.controlsReady) {
      pause(session, 'The configured page controls are not ready. Use Check page.');
      return null;
    }
    const amountCents = session.nextBetCents;
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0 ||
        !Number.isSafeInteger(session.netLossCents + amountCents)) {
      pause(session, 'Next bet exceeds the supported numeric range.');
      return null;
    }
    if (limit > 0 && session.netLossCents + amountCents > limit) {
      pause(session, `Stopped: the next ${amountCents / 100} coin bet could exceed the stop loss.`);
      return null;
    }
    session.pending = {
      id: newId(), side, amountCents, roundKey: observation.openKey,
      baselineResultKey: observation.resultKey, status: 'reserved', sawClosed: false
    };
    session.skippedChaseRoundKey = null;
    session.waitingRoundKey = null;
    session.chaseSide = side;
    session.status = `Preparing ${session.config.dryRun ? 'simulated ' : ''}${side} bet: ${amountCents / 100} coins.`;
    return { ...session.pending, dryRun: session.config.dryRun };
  }
  function acknowledge(session, id, outcome, reason = '') {
    const pending = session.pending;
    if (!pending || pending.id !== id) throw new Error('Bet reservation is no longer current.');
    if (outcome === 'submitted') {
      if (!session.active || pending.status !== 'reserved') throw new Error('Betting has stopped.');
      pending.status = 'submitted';
      session.status = 'Bet submitted — waiting for acceptance.';
    } else if (outcome === 'accepted') {
      if (pending.status !== 'submitted' && !(session.config.dryRun && pending.status === 'reserved')) {
        throw new Error('Bet was not submitted.');
      }
      pending.status = 'accepted';
      session.status = `${session.active ? 'Waiting' : 'Stopped — waiting'} for the ${pending.side} bet result (${pending.amountCents / 100} coins).`;
    } else if (outcome === 'deferred') {
      session.pending = null;
      loading(session, reason);
    } else if (outcome === 'cancelled') {
      session.pending = null;
      pause(session, reason || 'Bet cancelled before clicking; no loss recorded.');
    } else if (outcome === 'uncertain') {
      pause(session, reason || 'Bet acceptance could not be confirmed. Check the page, then reset the session.');
    } else throw new Error('Invalid bet acknowledgement.');
  }
  const api = { DEFAULTS, cents, formatAmount, settings, missingFromHistory, placementWindow, create, pause, stop, runtime, displayStatus, normalizeSide, advanceHistory, checkpoint, loading, recoveryPaths, recover, observe, acknowledge };
  globalThis.RouletteCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
