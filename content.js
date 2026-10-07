(() => {
  'use strict';
  const Core = RouletteCore;
  const documentId = crypto.randomUUID();
  let stored = { config: Core.settings(), session: null, revision: -1 };
  let busy = false;
  let placingBet = null;
  let recordingClose = false;
  let tracker = null;
  let lastSent = '';
  let pickerCleanup = null;
  let interval;
  let observer;
  let toolbar;
  let knownHistoryDirection = null;
  let passiveHistory = null;
  let missingSince = null;
  let reloadAsked = false;
  let recoverySignature = '';
  let recoveryStableSince = 0;
  let lastHeartbeat = 0;
  let visibilityChanged = false;
  let watchdogInterval;
  let watchingPage = false;
  let interruptedSession = null;
  let liveness = null;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  class PageUnavailable extends Error {}

  function readPageHealth() {
    const target = document.documentElement;
    const id = crypto.randomUUID();
    let health = null;
    const reply = event => {
      if (event.target !== target || typeof event.detail !== 'string') return;
      try {
        const value = JSON.parse(event.detail);
        if (value.id === id) health = value;
      } catch { /* Keep DOM checks available if the page checker is absent. */ }
    };
    target.addEventListener('roulette-bot:page-health-read', reply);
    try {
      target.dispatchEvent(new CustomEvent('roulette-bot:read-page-health', {
        bubbles: true, composed: true, detail: JSON.stringify({ id })
      }));
    } finally { target.removeEventListener('roulette-bot:page-health-read', reply); }
    return health;
  }

  function visible(element) {
    if (!element?.isConnected || (!document.hidden && element.getClientRects().length === 0)) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hidden || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    }
    return true;
  }
  function elementFor(selector, name, optional = false) {
    if (!selector) {
      if (optional) return null;
      throw new Error(`Set the ${name} selector in Page setup.`);
    }
    let matches;
    try { matches = [...document.querySelectorAll(selector)].filter(visible); }
    catch { throw new Error(`The ${name} selector is invalid CSS.`); }
    if (!matches.length && optional) return null;
    if (!matches.length) throw new PageUnavailable(`${name}: found no visible elements while reading roulette.`);
    if (matches.length !== 1) throw new Error(`${name}: found ${matches.length} visible elements; the selector must match exactly one.`);
    return matches[0];
  }
  function disabled(element) {
    return !!element.disabled || element.getAttribute('disable') === 'true' || element.getAttribute('aria-disabled') === 'true' ||
      element.classList.contains('disabled') || !!element.closest('[inert]');
  }
  function resultFrom(element) {
    const uniqueSide = values => {
      const sides = new Set(values.map(value => Core.normalizeSide(value)).filter(Boolean));
      return sides.size === 1 ? [...sides][0] : null;
    };
    const groups = [
      ['data-side', 'data-color', 'data-result'].map(name => element.getAttribute(name)),
      ['aria-label', 'title', 'alt'].map(name => element.getAttribute(name)),
      [...element.querySelectorAll('img, svg use')].flatMap(node => [node.getAttribute('alt'), node.getAttribute('src'), node.getAttribute('href'), node.getAttribute('xlink:href')]),
      [element.getAttribute('src')],
      [element.textContent],
      [...element.classList].filter(token => /^(red|black|green|t|ct|dice|bonus|(?:result|coin|roulette)[_-](?:red|black|green|t|ct|dice|bonus))$/i.test(token))
    ];
    for (const group of groups) {
      const side = uniqueSide(group);
      if (side) return side;
    }
    throw new PageUnavailable('Latest result has no unambiguous T/red, CT/black, or Dice/green marker. Pick the result icon or its wrapper.');
  }
  function moneyFrom(element) {
    const raw = String(element.value ?? element.getAttribute('data-amount') ?? element.textContent)
      .trim().replace(/\u00a0/g, ' ');
    const match = raw.match(/^[^\d-]*(-?\d[\d\s.,]*)[^\d]*$/);
    if (!match) throw new Error('Own bet amount must contain exactly one number. Pick the amount itself.');
    let number = match[1].replace(/\s/g, '');
    if (number.includes(',') && number.includes('.')) {
      number = number.lastIndexOf(',') > number.lastIndexOf('.')
        ? number.replace(/\./g, '').replace(',', '.') : number.replace(/,/g, '');
    } else if (/^\d{1,3}(,\d{3})+$/.test(number)) number = number.replace(/,/g, '');
    else if (/^\d{1,3}(\.\d{3})+$/.test(number)) number = number.replace(/\./g, '');
    else number = number.replace(',', '.');
    return Core.cents(number, 'Own bet amount', true);
  }
  function confirmation(config) {
    const selectors = config.selectors;
    if (selectors.ownT || selectors.ownCT) {
      if (!selectors.ownT || !selectors.ownCT) throw new Error('Set both own-bet selectors, or leave both blank to use balance confirmation.');
      const ownTElement = elementFor(selectors.ownT, 'your T bet amount');
      const ownCTElement = elementFor(selectors.ownCT, 'your CT bet amount');
      if (ownTElement.contains(ownCTElement) || ownCTElement.contains(ownTElement)) throw new Error('Your T and CT bet amounts must be separate elements.');
      return { confirmation: 'own', ownT: moneyFrom(ownTElement), ownCT: moneyFrom(ownCTElement) };
    }
    return { confirmation: 'balance', balanceCents: moneyFrom(elementFor(selectors.balance, 'account balance')) };
  }
  function rouletteControls(config) {
    const health = readPageHealth();
    if (health?.initialized === false) throw new PageUnavailable('Roulette is disconnected/loading, even if its old controls remain visible.');
    const selectors = config.selectors;
    const tButton = elementFor(selectors.tButton, 'T/red button');
    const ctButton = elementFor(selectors.ctButton, 'CT/black button');
    if (tButton === ctButton) throw new Error('T and CT must point to two different betting buttons.');
    for (const button of [tButton, ctButton]) {
      if (!button.matches('button, [role="button"], input[type="button"], input[type="submit"]')) {
        throw new Error('A betting-button selector must match the actual button.');
      }
    }
    const marker = elementFor(selectors.closed, 'spinning/closed marker', true);
    const countdown = elementFor(selectors.countdown, 'betting countdown', true);
    const countdownText = countdown?.textContent.trim() || '';
    const seconds = /^\d+(?:[.,]\d+)?$/.test(countdownText) ? Number(countdownText.replace(',', '.')) : null;
    const hasWheel = [...document.querySelectorAll('[data-testid="wheel-container"]')].some(visible);
    if (ownSession()?.checkpoint?.hasWheel && !hasWheel) throw new PageUnavailable('Roulette wheel is temporarily missing.');
    const countdownClosed = hasWheel && !(Number.isFinite(seconds) && seconds > 0);
    const siteSpin = ['spin', 'roll', 'end'].includes(health?.roundState);
    // A zero clock while the site still reports betting open is not spin
    // evidence. The watchdog allows a brief transition, then reloads a stall.
    const phase = health?.roundState === 'rolling' && countdownClosed ? 'waiting'
      : siteSpin || marker || countdownClosed || (disabled(tButton) && disabled(ctButton)) ? 'closed' : 'open';
    return { phase, controlsReady: phase === 'open' && !disabled(tButton) && !disabled(ctButton), tButton, ctButton, hasWheel, seconds, health };
  }
  function snapshot(config, historyDirection = null, includeStake = false) {
    const controls = rouletteControls(config);
    const { phase, tButton, ctButton, hasWheel, seconds, health } = controls;
    if (phase !== 'open') return controls;
    const selectors = config.selectors;
    let result = elementFor(selectors.result, 'latest completed result');
    let history = null;
    let newestEnd = null;
    if (selectors.history) {
      const nodes = [...document.querySelectorAll(selectors.history)].filter(visible);
      if (nodes.length) {
        history = nodes.map(resultFrom);
        const selected = nodes.findIndex(node => node === result || node.contains(result) || result.contains(node));
        newestEnd = historyDirection || knownHistoryDirection ||
          (stored.config.selectors.history === selectors.history ? stored.session?.historyDirection : null) ||
          (selected === 0 && nodes.length > 1 ? 'first' : 'last');
        result = newestEnd === 'first' ? nodes[0] : nodes.at(-1);
      }
    }
    let amount = null;
    let accepted = {};
    if (!config.dryRun && includeStake) {
      amount = elementFor(selectors.amount, 'bet amount input');
      if (!(amount instanceof HTMLInputElement) || !['number', 'text', 'tel'].includes(amount.type)) {
        throw new Error('Bet amount must point to the editable input.');
      }
      if (amount.readOnly) throw new Error('The bet amount input is read-only.');
      accepted = confirmation(config);
    }
    const idNode = result.closest('[data-round-id], [data-result-id]');
    const identity = (idNode && (idNode.getAttribute('data-round-id') || idNode.getAttribute('data-result-id'))) || result.getAttribute('data-id');
    return {
      phase, side: resultFrom(result), identity: identity || null, history, newestEnd, seconds, hasWheel, health,
      controlsReady: !disabled(tButton) && !disabled(ctButton) && (!amount || !disabled(amount)),
      tButton, ctButton, amount, ...accepted
    };
  }
  function pageState(sample) {
    const direction = tracker?.historyDirection || knownHistoryDirection || sample.newestEnd || 'last';
    const history = sample.history && (direction === 'first' ? [...sample.history].reverse() : [...sample.history]).slice(-10);
    return { phase: sample.phase, history, historyDirection: direction, identity: sample.identity || null,
      seconds: sample.seconds, hasWheel: sample.hasWheel };
  }
  function inspect(config, historyDirection = null) {
    try {
      config = Core.settings(config);
      const sample = snapshot(config, historyDirection, true);
      if (sample.phase !== 'open') {
        // Controls can be temporarily hidden during a valid spin. Validate the
        // selector syntax now; baseline history and live entry are checked on
        // the first readable betting window, before any wager is reserved.
        const deferredSelectors = [['result', 'latest result'], ['history', 'history']];
        if (!config.dryRun) deferredSelectors.push(['amount', 'bet amount']);
        for (const [key, name] of deferredSelectors) {
          const selector = config.selectors?.[key];
          if (!selector && key !== 'history') throw new Error(`Set the ${name} selector in Page setup.`);
          if (selector) {
            try { document.querySelectorAll(selector); }
            catch { throw new Error(`The ${name} selector is invalid CSS.`); }
          }
        }
        return { success: true, ready: true, documentId, phase: sample.phase, initialHistory: [],
          historyDirection: knownHistoryDirection || historyDirection || null,
          confirmation: config.dryRun ? 'simulation' : config.selectors.ownT ? 'own' : 'balance',
          detail: 'Roulette recognized. Start will wait for the current roll to finish and betting to reopen.',
          checkpoint: { ...pageState(sample), phase: 'closed' } };
      }
      return {
        success: true, ready: true, documentId, phase: sample.phase,
        result: sample.side, hasResultId: !!sample.identity,
        detail: sample.history ? 'History direction will be detected from the next completed round.' : sample.identity ? 'Result IDs detected.' : 'Round tracking will use closed → open transitions.',
        confirmation: sample.confirmation || 'simulation',
        initialHistory: sample.history ? (sample.newestEnd === 'first' ? [...sample.history].reverse() : [...sample.history]) : [sample.side],
        historyDirection: knownHistoryDirection || historyDirection || null,
        checkpoint: pageState(sample)
      };
    } catch (error) {
      return { success: true, ready: false, documentId, error: error.message };
    }
  }
  async function send(request) {
    const response = await chrome.runtime.sendMessage(request);
    if (!response?.success) throw new Error(response?.error || 'No response from the extension.');
    if (response.revision >= stored.revision) {
      stored = { config: response.config, session: response.session, revision: response.revision,
        tabId: response.controllerTabId ?? stored.tabId };
      toolbar?.update(stored, documentId);
    }
    return response;
  }
  function ownSession() {
    return stored.session?.documentId === documentId ? stored.session : null;
  }
  async function sessionMessage(session, action, extra = {}) {
    return send({ action, documentId, sessionId: session.id, ...extra });
  }
  async function acknowledge(session, bet, outcome, reason) {
    return sessionMessage(session, 'betAck', { betId: bet.id, outcome, reason });
  }
  function canClick(session, bet) {
    const current = ownSession();
    return current?.id === session.id && interruptedSession !== session.id && current.active && !current.recovery && current.pending?.id === bet.id;
  }
  async function missingPage(session, error) {
    const current = ownSession();
    if (!current?.active || current.id !== session?.id) return;
    interruptedSession = session.id;
    if (missingSince === null) missingSince = Date.now();
    recoverySignature = '';
    if (current.recovery?.reloads >= 1) {
      if (Date.now() - missingSince >= 15000) {
        await sessionMessage(current, 'pageError', { error: 'Roulette controls are still unavailable after reloading. Check the outstanding bet before resetting.' });
      }
    } else if (!reloadAsked) {
      reloadAsked = true;
      const notClickedBetId = placingBet?.sessionId === current.id && !placingBet.clicked ? placingBet.betId : null;
      // One worker message saves the session and requests reload; detection does
      // not wait for the strategy or its amount/confirmation delays to finish.
      await sessionMessage(current, 'pageUnavailable', { error: error.message, reload: true, notClickedBetId });
    }
  }
  async function watchPage() {
    if (watchingPage || pickerCleanup) return;
    const session = ownSession();
    if (!session?.active || session.needsReview) { liveness = null; return; }
    watchingPage = true;
    try {
      const sample = rouletteControls(session.config);
      const now = Date.now();
      if (liveness?.sessionId !== session.id || liveness.roundId !== (sample.health?.roundId || null)) {
        liveness = { sessionId: session.id, roundId: sample.health?.roundId || null, zeroSince: null, closedSince: null, clockMissingSince: null };
      }
      const genuineSpin = ['spin', 'roll', 'end'].includes(sample.health?.roundState);
      if (sample.seconds === 0 && !genuineSpin) {
        liveness.zeroSince ??= now;
        const grace = sample.health?.roundState === 'rolling' ? 1500 : 8000;
        if (now - liveness.zeroSince >= grace) throw new PageUnavailable('Roulette countdown is stuck at zero; reloading the saved session.');
      } else liveness.zeroSince = null;
      if (sample.phase === 'waiting' && sample.seconds === null) {
        liveness.clockMissingSince ??= now;
        if (now - liveness.clockMissingSince >= 500) throw new PageUnavailable('Betting is open internally but the countdown disappeared; reloading roulette.');
      } else liveness.clockMissingSince = null;
      if (sample.phase === 'closed') {
        liveness.closedSince ??= now;
        // The default wheel animation takes six seconds plus its end period.
        // Honor a longer duration announced by the site before calling it stuck.
        const spinLimit = Math.max(10000, (sample.health?.animationMs || 0) + 2000);
        if (now - liveness.closedSince >= spinLimit) throw new PageUnavailable('Roulette spin/countdown has stopped progressing; reloading the saved session.');
      } else liveness.closedSince = null;
    } catch (error) {
      if (error instanceof PageUnavailable) {
        try { await missingPage(session, error); }
        catch (recoveryError) { console.warn('[Roulette Bot]', recoveryError.message); }
      }
    } finally { watchingPage = false; }
  }
  async function reloadUnconfirmed(session, bet, error) {
    const current = ownSession();
    if (current?.pending?.id !== bet.id || current.pending.status !== 'submitted') return;
    const wasActive = current.active;
    await acknowledge(session, bet, 'uncertain', 'Roulette controls disappeared after clicking; bet acceptance is unknown.');
    if (wasActive) await sessionMessage(session, 'reloadPage', { review: true });
  }
  function readSiteStake(input) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      let timer;
      let finished = false;
      const finish = (error, response) => {
        if (finished) return;
        finished = true;
        input.removeEventListener('roulette-bot:stake-read', onReply);
        if (timer !== undefined) clearTimeout(timer);
        if (error) reject(error); else resolve(response);
      };
      const onReply = event => {
        if (event.target !== input || typeof event.detail !== 'string') return;
        let response;
        try { response = JSON.parse(event.detail); } catch { return; }
        if (response.id !== id) return;
        if (!response.success) finish(new Error((response.error || 'Cannot read the site stake.') + ' No bet clicked.'));
        else if (typeof response.amount !== 'number' || !Number.isFinite(response.amount) || typeof response.field !== 'string') {
          finish(new Error('The site stake check returned an invalid value; no bet clicked.'));
        } else finish(null, response);
      };
      input.addEventListener('roulette-bot:stake-read', onReply);
      input.dispatchEvent(new CustomEvent('roulette-bot:read-stake', { bubbles: true, composed: true, detail: JSON.stringify({ id }) }));
      if (!finished) timer = setTimeout(() => finish(new Error('The site stake checker did not respond; reload the extension and refresh roulette. No bet clicked.')), 800);
    });
  }
  async function performBet(session, bet) {
    let clicked = false;
    let verifiedSiteStake = null;
    placingBet = { sessionId: session.id, betId: bet.id };
    try {
      if (!canClick(session, bet)) return;
      if (bet.dryRun) {
        await acknowledge(session, bet, 'accepted');
        return;
      }
      let sample = snapshot(session.config, null, true);
      if (sample.phase !== 'open' || !sample.controlsReady) throw new Error('Betting closed before the amount could be entered.');
      if (!Number.isFinite(sample.seconds) || sample.seconds < 5) throw new Error('Fewer than 5 seconds remain or the countdown is unavailable; no click sent.');
      const roundSignature = JSON.stringify([sample.identity, sample.history || sample.side]);
      const before = sample.confirmation === 'balance' ? sample.balanceCents : bet.side === 'T' ? sample.ownT : sample.ownCT;
      const expected = sample.confirmation === 'balance' ? before - bet.amountCents : before + bet.amountCents;
      if (expected < 0) throw new Error('The next stake exceeds the available balance; no click sent.');
      const verifyEntry = (current, checkAmount = true) => {
        if (current.phase !== 'open' || !current.controlsReady) throw new Error('Betting closed before clicking.');
        if (checkAmount) {
          const raw = String(current.amount.value);
          const plainDecimal = /^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(raw);
          if (!plainDecimal || Core.cents(raw, 'Entered amount', true) !== bet.amountCents) {
            console.warn('[Roulette Bot] Website amount after formatting', {
              requested: Core.formatAmount(bet.amountCents), field: raw,
              characters: Array.from(raw, char => 'U+' + char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'))
            });
            throw new Error(plainDecimal
              ? 'The page changed or rejected the requested amount; no click sent.'
              : 'The website amount still contains non-decimal characters after formatting; no click sent.');
          }
        }
        if (!Number.isFinite(current.seconds) || current.seconds < 5 ||
            JSON.stringify([current.identity, current.history || current.side]) !== roundSignature) {
          throw new Error('The betting window ended or the round changed during amount entry; no click sent.');
        }
      };
      const verifySiteStake = async input => {
        const site = await readSiteStake(input);
        if (site.field !== amountText || Math.abs(site.amount * 100 - bet.amountCents) > 0.000001) {
          console.warn('[Roulette Bot] Site stake mismatch', { requested: amountText, field: site.field, siteStake: site.amount });
          throw new Error(`The field shows ${site.field}, but the site's stored stake is ${site.amount}; no bet clicked. Check the amount control and selected currency.`);
        }
        verifiedSiteStake = site.amount;
      };
      // Run the widget's click/focus formatting BEFORE replacing the value.
      // Clearing then inserting also updates a stale model when text is unchanged.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      const amountText = Core.formatAmount(bet.amountCents);
      sample.amount.focus({ preventScroll: true });
      sample.amount.click();
      await delay(150);
      if (!canClick(session, bet)) return;
      sample = snapshot(session.config, null, true);
      verifyEntry(sample, false);
      sample.amount.focus({ preventScroll: true });
      const writtenInput = sample.amount;
      setter.call(sample.amount, '');
      sample.amount.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true,
        inputType: 'deleteContentBackward', data: null }));
      // Let Vue propagate the cleared CurrencyInput model before the next edit.
      await delay(100);
      if (!canClick(session, bet)) return;
      sample = snapshot(session.config, null, true);
      verifyEntry(sample, false);
      if (sample.amount !== writtenInput) throw new PageUnavailable('The site replaced the amount input while clearing the stake.');
      const beforeInput = new InputEvent('beforeinput', { bubbles: true, composed: true, cancelable: true,
        inputType: 'insertText', data: amountText });
      if (!sample.amount.dispatchEvent(beforeInput)) throw new Error('The website blocked amount entry; no click sent.');
      setter.call(sample.amount, amountText);
      sample.amount.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true,
        inputType: 'insertText', data: amountText }));
      sample.amount.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      // The site's roulette Input commits its currency model on blur, not change.
      // Wait BEFORE blur so that handler receives the new model. Explicitly
      // notify it as well: focus/blur methods may do nothing in a hidden tab.
      await delay(650);
      if (!canClick(session, bet)) return;
      sample = snapshot(session.config, null, true);
      verifyEntry(sample, false);
      if (sample.amount !== writtenInput) throw new PageUnavailable('The site replaced the amount input while updating the stake; preparing again after recovery.');
      sample.amount.blur();
      sample.amount.dispatchEvent(new FocusEvent('blur', { composed: true }));
      // A field click can run the site's formatter or synchronize its stake model.
      // Run that interaction before validating the final text, then leave the field.
      sample.amount.focus({ preventScroll: true });
      sample.amount.click();
      await delay(150);
      if (!canClick(session, bet)) return;
      sample = snapshot(session.config, null, true);
      verifyEntry(sample);
      const preparedInput = sample.amount;
      (bet.side === 'T' ? sample.tButton : sample.ctButton).focus({ preventScroll: true });
      await delay(250);
      if (!canClick(session, bet)) return;
      sample = snapshot(session.config, null, true);
      verifyEntry(sample);
      if (sample.amount !== preparedInput) throw new PageUnavailable('The site replaced the amount input during entry; preparing again after recovery.');
      await verifySiteStake(preparedInput);
      if (!canClick(session, bet)) return;

      // The worker must persist the submitted marker before any possible money action.
      await acknowledge(session, bet, 'submitted');
      if (!canClick(session, bet)) {
        await acknowledge(session, bet, 'cancelled', 'Stopped before clicking; no loss recorded.');
        return;
      }
      // Persisting the submitted marker is asynchronous. Recheck the actual
      // store afterwards in case the site reset it while that reply was pending.
      await verifySiteStake(preparedInput);
      if (!canClick(session, bet)) {
        await acknowledge(session, bet, 'cancelled', 'Stopped before clicking; no loss recorded.');
        return;
      }
      sample = snapshot(session.config, null, true);
      verifyEntry(sample);
      if (sample.amount !== preparedInput) throw new PageUnavailable('The site replaced the amount input before clicking; no click sent.');
      const currentAmount = sample.confirmation === 'balance' ? sample.balanceCents : bet.side === 'T' ? sample.ownT : sample.ownCT;
      if (currentAmount !== before) throw new Error('The displayed amount changed before clicking; no click sent.');
      clicked = true; // Treat a throwing click as uncertain; never retry it blindly.
      placingBet.clicked = true;
      (bet.side === 'T' ? sample.tButton : sample.ctButton).click();

      const deadline = Date.now() + 4500;
      while (Date.now() < deadline) {
        await delay(150);
        sample = confirmation(session.config);
        const value = sample.confirmation === 'balance' ? sample.balanceCents : bet.side === 'T' ? sample.ownT : sample.ownCT;
        if (value === expected) {
          // Avoid acknowledging a single transient value during a balance animation.
          await delay(150);
          const stable = confirmation(session.config);
          const stableValue = stable.confirmation === 'balance' ? stable.balanceCents : bet.side === 'T' ? stable.ownT : stable.ownCT;
          if (stableValue === expected) {
            await acknowledge(session, bet, 'accepted');
            return;
          }
        }
        if ((sample.confirmation === 'own' && value > expected) || (sample.confirmation === 'balance' && value < expected)) {
          throw new Error('The displayed amount changed by more than this stake; acceptance is ambiguous.');
        }
      }
      console.warn('[Roulette Bot] Unconfirmed bet amount', {
        requested: amountText, field: preparedInput.value, siteStake: verifiedSiteStake,
        characters: Array.from(String(preparedInput.value), char => 'U+' + char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'))
      });
      throw new Error(`Bet click was not confirmed by the displayed amount (site stake verified: ${amountText}). Check the page before resetting.`);
    } catch (error) {
      if (ownSession()?.pending?.id !== bet.id) return; // Stop may already have cancelled this reservation.
      try {
        if (error instanceof PageUnavailable) {
          if (clicked) await reloadUnconfirmed(session, bet, error);
          else {
            await acknowledge(session, bet, 'deferred', error.message);
            await missingPage(ownSession(), error);
          }
        } else await acknowledge(session, bet, clicked ? 'uncertain' : 'cancelled', error.message);
      }
      catch (ackError) { console.warn('[Roulette Bot]', error.message, ackError.message); }
    } finally {
      placingBet = null;
    }
  }
  async function tick() {
    toolbar?.refreshLayout();
    void watchPage();
    if (pickerCleanup) return;
    if (busy) {
      // Confirmation can span the start of a spin. Keep that phase evidence even
      // while the amount-entry/acceptance task is waiting for the page.
      const session = ownSession();
      if (!placingBet || recordingClose || session?.id !== placingBet.sessionId ||
          session.pending?.id !== placingBet.betId || !tracker || tracker.phase === 'closed') return;
      try { if (snapshot(session.config).phase !== 'closed') return; }
      catch (error) {
        if (error instanceof PageUnavailable) {
          recordingClose = true;
          try {
            if (session.pending.status === 'submitted') {
              if (placingBet.clicked) await reloadUnconfirmed(session, session.pending, error);
              else {
                await acknowledge(session, session.pending, 'deferred', error.message);
                await missingPage(ownSession(), error);
              }
            } else await missingPage(session, error);
          } catch (recoveryError) { console.warn('[Roulette Bot]', recoveryError.message); }
          finally { recordingClose = false; }
        }
        return;
      }
      recordingClose = true;
      tracker.phase = 'closed';
      try {
        await sessionMessage(session, 'observe', { observation: { phase: 'closed', checkpoint: { phase: 'closed' } } });
        lastSent = JSON.stringify({ phase: 'closed', checkpoint: { phase: 'closed' } });
      } catch (error) { console.warn('[Roulette Bot] Could not record the spin during confirmation:', error.message); }
      finally { recordingClose = false; }
      return;
    }
    // Learn list direction while idle too, before a Start needs to seed the visible streak.
    try {
      const nodes = [...document.querySelectorAll(stored.config.selectors.history)].filter(visible);
      const history = nodes.map(resultFrom);
      if (history.length) {
        if (passiveHistory && JSON.stringify(history) !== JSON.stringify(passiveHistory)) {
          const advance = Core.advanceHistory(passiveHistory, history, knownHistoryDirection);
          if (advance && advance.direction !== 'either') knownHistoryDirection = advance.direction;
        }
        passiveHistory = history;
      }
    } catch { /* An idle/non-roulette page has no readable history yet. */ }
    const session = ownSession();
    if (!session || session.needsReview || (!session.active && !session.pending)) return;
    busy = true;
    try {
      const sample = snapshot(session.config);
      const now = Date.now();
      const timing = Core.settings(session.config);
      const chooseTarget = () => timing.betBeforeSeconds + (Math.random() * 2 - 1) * timing.timingVarianceSeconds;
      if (sample.phase === 'waiting') return;
      if (visibilityChanged && !session.recovery && session.checkpoint?.history?.length) {
        visibilityChanged = false;
        await sessionMessage(session, 'pageUnavailable', { error: 'Tab visibility changed — checking saved round state.' });
        return;
      }
      if (session.recovery) {
        const signature = JSON.stringify([sample.phase, sample.identity, sample.history]);
        if (signature !== recoverySignature) { recoverySignature = signature; recoveryStableSince = now; }
        if (sample.phase !== 'open' || now - recoveryStableSince < 900) return;
        const cycle = (tracker?.sessionId === session.id ? tracker.cycle : 0) + 1;
        const page = { ...pageState(sample), openKey: `${session.id}:${documentId}:${cycle}`,
          resultKey: sample.identity ? `result:${sample.identity}` : `cycle:${documentId}:${cycle}` };
        const response = await sessionMessage(session, 'recoverPage', { page });
        if (response.session.recovery || response.session.needsReview || response.session.lastOpenKey !== page.openKey) return;
        tracker = { sessionId: session.id, phase: sample.phase, cycle, openedAt: now - 1000,
          signature: JSON.stringify([sample.identity, sample.history || sample.side]), stableSince: now - 1000,
          committedCycle: cycle, history: sample.history, historySide: page.history.at(-1),
          historyDirection: page.historyDirection, historyLimit: Math.max(10, sample.history?.length || 0), betAtSeconds: chooseTarget() };
        missingSince = null; reloadAsked = false; recoverySignature = ''; visibilityChanged = false; lastSent = '';
        interruptedSession = null; liveness = null;
        return;
      }
      missingSince = null; reloadAsked = false; recoverySignature = '';
      if (!tracker || tracker.sessionId !== session.id) {
        tracker = { sessionId: session.id, phase: sample.phase, cycle: 0, openedAt: now, signature: '', stableSince: now,
          committedCycle: -1, history: sample.history, historySide: sample.side,
          historyDirection: knownHistoryDirection || session.historyDirection || null,
          historyLimit: Math.max(10, sample.history?.length || 0), betAtSeconds: chooseTarget() };
        lastSent = '';
      }
      if (tracker.phase === 'closed' && sample.phase === 'open') {
        tracker.cycle++;
        tracker.openedAt = now;
        tracker.stableSince = now;
        tracker.betAtSeconds = chooseTarget();
      }
      tracker.phase = sample.phase;
      let observation;
      if (sample.phase === 'closed') {
        observation = { phase: 'closed', checkpoint: { phase: 'closed' } };
      } else {
        const signature = JSON.stringify([sample.identity, sample.history || sample.side]);
        if (signature !== tracker.signature) {
          tracker.signature = signature;
          tracker.stableSince = now;
        }
        // Let result/history paint finish after betting reopens.
        if (now - tracker.openedAt < 900 || now - tracker.stableSince < 350) return;
        if (tracker.committedCycle === tracker.cycle && sample.history && tracker.history &&
            JSON.stringify(pageState(sample).history) !== JSON.stringify(pageState({ ...sample, history: tracker.history }).history)) {
          await sessionMessage(session, 'pageUnavailable', { error: 'Results advanced while the page or tab was unobserved — checking the saved betting sequence.' });
          return;
        }
        let side = sample.side;
        if (sample.history && tracker.history) {
          if (tracker.cycle > tracker.committedCycle && tracker.committedCycle >= 0) {
            const advance = Core.advanceHistory(tracker.history, sample.history, tracker.historyDirection);
            if (!advance) {
              if (now - tracker.openedAt > 1500 && now - tracker.stableSince >= 900) {
                await sessionMessage(session, 'pageUnavailable', { error: 'History advanced by more than one result — reconciling missed rounds.' });
              }
              return;
            }
            side = advance.side;
            if (advance.direction !== 'either') {
              tracker.historyDirection = advance.direction;
              knownHistoryDirection = advance.direction;
            }
          } else side = tracker.historySide;
        }
        observation = {
          phase: 'open', side, controlsReady: sample.controlsReady,
          placementWindow: Core.placementWindow(sample.seconds, tracker.betAtSeconds),
          betAtSeconds: tracker.betAtSeconds,
          historyDirection: tracker.historyDirection,
          checkpoint: pageState(sample),
          ...(session.lastOpenKey === null ? {
            initialHistory: sample.history ? (sample.newestEnd === 'first' ? [...sample.history].reverse() : [...sample.history]) : [side]
          } : {}),
          openKey: `${session.id}:${documentId}:${tracker.cycle}`,
          resultKey: sample.identity ? `result:${sample.identity}` : `cycle:${documentId}:${tracker.cycle}`
        };
      }
      const signature = JSON.stringify(observation);
      if (signature === lastSent) {
        if (observation.phase === 'open' && now - lastHeartbeat >= 2000) {
          lastHeartbeat = now;
          await sessionMessage(session, 'checkpoint', { openKey: observation.openKey, checkpoint: pageState(sample) });
        }
        return;
      }
      const response = await sessionMessage(session, 'observe', { observation });
      lastSent = signature;
      lastHeartbeat = now;
      if (observation.phase === 'open' && response.session?.lastOpenKey === observation.openKey) {
        tracker.committedCycle = tracker.cycle;
        tracker.history = sample.history && (tracker.historyDirection === 'first'
          ? sample.history.slice(0, tracker.historyLimit) : sample.history.slice(-tracker.historyLimit));
        tracker.historySide = observation.side;
      }
      if (response.instruction) await performBet(response.session, response.instruction);
    } catch (error) {
      if (/Extension context invalidated/i.test(error.message)) {
        clearInterval(interval);
        clearInterval(watchdogInterval);
        observer?.disconnect();
        toolbar?.invalidate('Extension updated. Refresh this tab to reconnect the controls.');
        console.warn('[Roulette Bot] Extension reloaded. Refresh this tab.');
      } else if (error instanceof PageUnavailable) {
        try { await missingPage(session, error); }
        catch (recoveryError) { console.warn('[Roulette Bot]', recoveryError.message); }
      } else {
        try { await sessionMessage(session, 'pageError', { error: error.message }); }
        catch { console.warn('[Roulette Bot]', error.message); }
      }
    } finally { busy = false; }
  }

  function selectorPath(element, key) {
    const positional = key === 'result';
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1) {
      const id = node.id;
      if (id && (!positional || (node !== element && !/\d/.test(id)))) {
        const candidate = `#${CSS.escape(id)}${parts.length ? ' > ' + parts.join(' > ') : ''}`;
        if (document.querySelectorAll(candidate).length === 1) return candidate;
      }
      const tag = node.localName;
      const siblings = node.parentElement ? [...node.parentElement.children].filter(sibling => sibling.localName === tag) : [node];
      parts.unshift(`${tag}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : ''}`);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }
  function beginPicker(key) {
    if (!Object.hasOwn(Core.DEFAULTS.selectors, key)) throw new Error('Unknown selector field.');
    if (stored.session?.active || stored.session?.pending) throw new Error('Stop and resolve the session before using the picker.');
    pickerCleanup?.();
    const banner = document.createElement('div');
    banner.textContent = `Roulette Bot: click ${key}. Escape cancels. This click only selects the element.`;
    banner.style.cssText = 'position:fixed;top:12px;left:12px;right:12px;padding:14px;background:#242424;color:#fff;border:2px solid #ff9c3a;border-radius:8px;font:14px system-ui;z-index:2147483647;pointer-events:none';
    banner.style.top = `${Math.ceil(toolbar?.height || 0) + 8}px`;
    document.documentElement.appendChild(banner);
    let highlighted = null;
    let oldOutline = '';
    const highlight = event => {
      if (toolbar?.contains(event.target)) return;
      if (highlighted) highlighted.style.outline = oldOutline;
      highlighted = event.target;
      oldOutline = highlighted.style?.outline || '';
      if (highlighted.style) highlighted.style.outline = '3px solid #ff9c3a';
    };
    const cleanup = () => {
      if (highlighted?.style) highlighted.style.outline = oldOutline;
      banner.remove();
      window.removeEventListener('click', select, true);
      window.removeEventListener('pointerdown', block, true);
      window.removeEventListener('pointerup', block, true);
      window.removeEventListener('mousedown', block, true);
      window.removeEventListener('mouseup', block, true);
      window.removeEventListener('pointerover', highlight, true);
      window.removeEventListener('keydown', keydown, true);
      pickerCleanup = null;
    };
    const block = event => { event.preventDefault(); event.stopImmediatePropagation(); };
    const keydown = event => {
      if (event.key === 'Escape') { block(event); cleanup(); }
    };
    const select = event => {
      block(event);
      if (toolbar?.contains(event.target)) return;
      let element = event.target;
      if (['tButton', 'ctButton'].includes(key)) element = element.closest('button, [role="button"], input[type="button"], input[type="submit"]');
      if (key === 'amount') element = element.closest('input');
      if (!element) { banner.textContent = 'Select the actual button or input. Escape cancels.'; return; }
      const selector = selectorPath(element, key);
      cleanup();
      send({ action: 'saveSelector', key, selector }).then(() => {
        console.info(`[Roulette Bot] Saved ${key}: ${selector}`);
      }).catch(error => console.error('[Roulette Bot]', error.message));
    };
    pickerCleanup = cleanup;
    window.addEventListener('click', select, true);
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup']) window.addEventListener(type, block, true);
    window.addEventListener('pointerover', highlight, true);
    window.addEventListener('keydown', keydown, true);
  }
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request?.action === 'inspect') {
      sendResponse(inspect(request.config || stored.config, request.historyDirection));
    } else if (request?.action === 'pickElement') {
      try { beginPicker(request.key); sendResponse({ success: true }); }
      catch (error) { sendResponse({ success: false, error: error.message }); }
    } else return false;
    return false;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const revision = changes.revision?.newValue ?? stored.revision;
    if (revision < stored.revision) return;
    stored.revision = revision;
    if (changes.config) stored.config = changes.config.newValue;
    if (changes.session) stored.session = changes.session.newValue || null;
    toolbar?.update(stored, documentId);
    void tick();
  });
  toolbar = RouletteToolbar.mount({
    async start(config) {
      const page = inspect(config);
      if (!page.ready) throw new Error(page.error);
      await send({ action: 'saveConfig', settings: config, documentId });
      void tick();
    },
    stop: () => send({ action: 'stopBot', documentId }),
    reset: () => send({ action: 'resetSession', documentId }),
    save: config => send({ action: 'saveSettings', settings: config, documentId }),
    check(config) {
      const page = inspect(config);
      if (!page.ready) throw new Error(page.error);
      return `Page controls found. ${page.detail}`;
    },
    async pick(key, config) {
      await send({ action: 'saveSettings', settings: config, documentId });
      beginPicker(key);
    }
  });
  toolbar.update(stored, documentId);
  interval = setInterval(() => void tick(), 250);
  watchdogInterval = setInterval(() => void watchPage(), 250);
  document.addEventListener('roulette-bot:page-health-changed', () => {
    // Vuex subscribers run during a mutation. Inspect after its render jobs
    // have been queued, without depending on a strategy message finishing.
    queueMicrotask(() => { void watchPage(); void tick(); });
  });
  document.addEventListener?.('visibilitychange', () => { visibilityChanged = true; void tick(); });
  observer = new MutationObserver(() => void tick());
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  send({ action: 'hello', documentId }).then(() => tick()).catch(error => {
    toolbar.invalidate('Cannot connect to the extension. Refresh this tab after reloading the extension.');
    console.warn('[Roulette Bot]', error.message);
  });
})();
