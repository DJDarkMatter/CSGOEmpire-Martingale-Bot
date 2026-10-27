(() => {
  'use strict';
  // Read-only access to the site's stake and roulette connection/phase state.
  // This script cannot access extension storage, commit state, or place bets.
  let watchedStore = null;
  let unsubscribe = null;
  let animationMs = null;
  const phaseMutations = new Set(['roulette/SOCKET_ROULETTE_disconnect', 'roulette/SOCKET_ROULETTE_init',
    'roulette/SOCKET_ROULETTE_roll', 'roulette/SOCKET_ROULETTE_spin', 'roulette/SOCKET_ROULETTE_end', 'roulette/rolling']);
  function siteStore() {
    const stores = new Set([...document.querySelectorAll('[data-v-app]')]
      .map(root => root.__vue_app__?.config?.globalProperties?.$store)
      .filter(store => store?.state?.roulette));
    if (stores.size !== 1) throw new Error('The site stake store is unavailable.');
    return [...stores][0];
  }
  document.addEventListener('roulette-bot:read-own-bet', event => {
    if (event.target !== document.documentElement || typeof event.detail !== 'string') return;
    let request;
    try { request = JSON.parse(event.detail); } catch { return; }
    if (typeof request.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(request.id) || !['T', 'CT'].includes(request.side)) return;
    let response = { supported: false };
    try {
      const store = siteStore();
      const roulette = store.state.roulette;
      const uid = store.state.user?.model?.id;
      const roundId = request.roundId ?? roulette.round;
      if (!['string', 'number'].includes(typeof uid) || !['string', 'number'].includes(typeof roundId) ||
          !roulette.bets || typeof roulette.bets !== 'object' || Array.isArray(roulette.bets)) throw new Error('Unsupported own-bet store.');
      const round = String(roundId);
      const rows = roulette.bets[round];
      if (!rows && String(roulette.round) !== round) throw new Error('That round is no longer available.');
      if (rows !== undefined && !Array.isArray(rows)) throw new Error('Unsupported own-bet list.');
      const integer = value => {
        if (!(typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)))) throw new Error('Unsupported stake.');
        const number = Number(value);
        if (!Number.isSafeInteger(number) || number < 0) throw new Error('Invalid stake.');
        return number;
      };
      const coin = request.side === 'T' ? 't' : 'ct';
      let confirmedCents = 0;
      let unconfirmedCents = 0;
      for (const bet of rows || []) {
        if (String(bet.uid) !== String(uid) || bet.coin !== coin) continue;
        if (String(bet.round) !== round || !Array.isArray(bet.unconfirmedAmounts)) throw new Error('Unsupported own bet.');
        const amount = integer(bet.amount);
        const unconfirmed = bet.unconfirmedAmounts.reduce((sum, value) => sum + integer(value), 0);
        if (!Number.isSafeInteger(unconfirmed) || unconfirmed > amount) throw new Error('Invalid unconfirmed amount.');
        // The captured site adds optimistic amounts before an own_bet receipt.
        // Only a server ID plus the amount minus those pending additions counts.
        const hasId = (typeof bet.id === 'string' && bet.id.length > 0) || (typeof bet.id === 'number' && bet.id > 0);
        confirmedCents += hasId ? amount - unconfirmed : 0;
        unconfirmedCents += unconfirmed;
      }
      if (!Number.isSafeInteger(confirmedCents) || !Number.isSafeInteger(unconfirmedCents)) throw new Error('Stake total overflow.');
      response = { supported: true, roundId: round, confirmedCents, unconfirmedCents };
    } catch { /* An unsupported layout falls back to the existing display check. */ }
    document.documentElement.dispatchEvent(new CustomEvent('roulette-bot:own-bet-read', {
      detail: JSON.stringify({ id: request.id, ...response })
    }));
  }, true);
  document.addEventListener('roulette-bot:read-page-health', event => {
    if (event.target !== document.documentElement || typeof event.detail !== 'string') return;
    let request;
    try { request = JSON.parse(event.detail); } catch { return; }
    if (typeof request.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(request.id)) return;
    let response;
    try {
      const store = siteStore();
      if (store !== watchedStore) {
        try { unsubscribe?.(); } catch { /* Polling still works without a subscription. */ }
        watchedStore = store;
        animationMs = null;
        unsubscribe = null;
        try { unsubscribe = typeof store.subscribe === 'function' ? store.subscribe(mutation => {
          const duration = mutation.payload?.animationTimer;
          if (phaseMutations.has(mutation.type) && Number.isFinite(duration) && duration > 0 && duration <= 60000) animationMs = duration;
          if (phaseMutations.has(mutation.type)) {
            document.documentElement.dispatchEvent(new CustomEvent('roulette-bot:page-health-changed', { bubbles: true }));
          }
        }) : null; } catch { /* Read connection/phase state even if subscribing fails. */ }
      }
      const roulette = store.state.roulette;
      response = {
        initialized: typeof roulette.isInitialized === 'boolean' ? roulette.isInitialized : null,
        roundState: ['rolling', 'spin', 'roll', 'end'].includes(roulette.roundState) ? roulette.roundState : null,
        roundId: ['string', 'number'].includes(typeof roulette.round) ? String(roulette.round) : null,
        animationMs
      };
    } catch { response = { initialized: null, roundState: null, roundId: null }; }
    document.documentElement.dispatchEvent(new CustomEvent('roulette-bot:page-health-read', {
      detail: JSON.stringify({ id: request.id, ...response })
    }));
  }, true);
  document.addEventListener('roulette-bot:read-stake', event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.isConnected || typeof event.detail !== 'string') return;
    let request;
    try { request = JSON.parse(event.detail); } catch { return; }
    if (typeof request.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(request.id)) return;
    let response;
    try {
      const raw = siteStore().state.roulette.betAmountRaw;
      // Vue's reactive store unwraps the amount input's ref. Empty values are
      // zero in the site's own rounding/validation code.
      if (raw !== null && raw !== undefined && typeof raw !== 'number' && typeof raw !== 'string') {
        throw new Error('The site stake has an unsupported format.');
      }
      const amount = Number(raw ?? 0);
      if (!Number.isFinite(amount) || amount < 0) throw new Error('The site stake is not a valid amount.');
      response = { success: true, amount, field: String(input.value) };
    } catch (error) {
      response = { success: false, error: error.message };
    }
    input.dispatchEvent(new CustomEvent('roulette-bot:stake-read', {
      detail: JSON.stringify({ id: request.id, ...response })
    }));
  }, true);
})();
