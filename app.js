/* Pyramid — gestion de bankroll par paliers.
 * Règle du jeu : on mise un montant ; à chaque palier gagné on rejoue
 * l'intégralité du gain sur le palier suivant, jusqu'à atteindre l'objectif.
 */
(() => {
  'use strict';

  const STORAGE_KEY = 'pyramid:v1';

  const fmtMoney = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
  const fmtOdds = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = (n) => fmtMoney.format(n);
  const odds = (n) => fmtOdds.format(n);
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

  /** Accepte "12", "12,5", "12.50", " 1 234,5 " → nombre ou NaN. */
  const parseNum = (raw) => {
    if (raw == null) return NaN;
    const cleaned = String(raw).trim().replace(/\s/g, '').replace(',', '.');
    if (!/^\d*\.?\d+$/.test(cleaned) && !/^\d+\.?$/.test(cleaned)) return NaN;
    return Number(cleaned);
  };

  // ---------- État ----------
  const defaultState = () => ({
    settings: { stake: null, target: null },
    run: { status: 'idle', bankroll: 0, steps: [], attempt: 0, lostAt: null, pending: null },
    attempts: { total: 0, won: 0, lost: 0 },
    history: [],
  });

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      const base = defaultState();
      return {
        settings: { ...base.settings, ...(parsed.settings || {}) },
        run: { ...base.run, ...(parsed.run || {}) },
        attempts: { ...base.attempts, ...(parsed.attempts || {}) },
        history: Array.isArray(parsed.history) ? parsed.history : [],
      };
    } catch {
      return defaultState();
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* stockage indisponible (navigation privée) : on continue en mémoire */
    }
  }

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const el = {
    screens: {
      setup: $('screen-setup'),
      play: $('screen-play'),
      end: $('screen-end'),
    },
    // setup
    setupForm: $('setup-form'),
    inputStake: $('input-stake'),
    inputTarget: $('input-target'),
    setupError: $('setup-error'),
    setupHint: $('setup-hint'),
    setupMult: $('setup-mult'),
    setupStats: $('setup-stats'),
    statAttempts: $('stat-attempts'),
    statWon: $('stat-won'),
    statLost: $('stat-lost'),
    btnReset: $('btn-reset'),
    setupAttempts: $('setup-attempts'),
    setupAttemptsList: $('setup-attempts-list'),
    // play
    btnQuit: $('btn-quit'),
    playStep: $('play-step'),
    playAttempt: $('play-attempt'),
    playCard: $('play-card'),
    playBankroll: $('play-bankroll'),
    playProgress: $('play-progress'),
    playProgressBar: $('play-progress-bar'),
    playStart: $('play-start'),
    playTarget: $('play-target'),
    inputOdds: $('input-odds'),
    oddsQuick: $('odds-quick'),
    playPayout: $('play-payout'),
    playError: $('play-error'),
    playHistory: $('play-history'),
    playHistoryList: $('play-history-list'),
    btnUndo: $('btn-undo'),
    pendingCard: $('pending-card'),
    pendingStake: $('pending-stake'),
    pendingOdds: $('pending-odds'),
    pendingPayout: $('pending-payout'),
    btnEditOdds: $('btn-edit-odds'),
    oddsCard: document.querySelector('.odds-card'),
    actionsPlace: $('actions-place'),
    actionsResult: $('actions-result'),
    btnPlace: $('btn-place'),
    btnWin: $('btn-win'),
    btnLose: $('btn-lose'),
    // end
    endHero: $('end-hero'),
    endBadge: $('end-badge'),
    endTitle: $('end-title'),
    endSub: $('end-sub'),
    endFinal: $('end-final'),
    endStake: $('end-stake'),
    endTarget: $('end-target'),
    endSteps: $('end-steps'),
    endMult: $('end-mult'),
    endHistory: $('end-history'),
    endHistoryList: $('end-history-list'),
    endAttempts: $('end-attempts'),
    endWon: $('end-won'),
    endLost: $('end-lost'),
    endAttempts2: $('end-attempts-history'),
    endAttemptsList: $('end-attempts-history-list'),
    btnEdit: $('btn-edit'),
    btnReplay: $('btn-replay'),
  };

  /** Progression en échelle logarithmique : chaque multiplication compte autant,
   *  quelle que soit la taille de l'objectif (1 → 10 € vaut autant que 10 → 100 €). */
  function progressPercent(bankroll, stake, target) {
    if (!(stake > 0) || !(target > stake) || !(bankroll > 0)) return 0;
    const pct = (Math.log(bankroll / stake) / Math.log(target / stake)) * 100;
    return Math.max(0, Math.min(100, pct));
  }

  // ---------- Rendu ----------
  function showScreen(name) {
    document.querySelectorAll('.confetti').forEach((n) => n.remove());
    Object.entries(el.screens).forEach(([key, node]) => {
      node.hidden = key !== name;
    });
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  function render() {
    const { run } = state;
    if (run.status === 'playing') {
      renderPlay();
      showScreen('play');
    } else if (run.status === 'won' || run.status === 'lost') {
      renderEnd();
      showScreen('end');
    } else {
      renderSetup();
      showScreen('setup');
    }
  }

  function renderSetup() {
    const { settings, attempts } = state;
    if (settings.stake != null && !el.inputStake.value) el.inputStake.value = String(settings.stake).replace('.', ',');
    if (settings.target != null && !el.inputTarget.value) el.inputTarget.value = String(settings.target).replace('.', ',');
    updateSetupHint();

    const hasHistory = attempts.total > 0;
    el.setupStats.hidden = !hasHistory;
    el.btnReset.hidden = !hasHistory && settings.stake == null;
    el.statAttempts.textContent = attempts.total;
    el.statWon.textContent = attempts.won;
    el.statLost.textContent = attempts.lost;
    renderAttempts(el.setupAttemptsList, el.setupAttempts, state.history);
  }

  function updateSetupHint() {
    const stake = parseNum(el.inputStake.value);
    const target = parseNum(el.inputTarget.value);
    if (stake > 0 && target > stake) {
      el.setupMult.textContent = `×${fmtOdds.format(target / stake)}`;
      el.setupHint.hidden = false;
    } else {
      el.setupHint.hidden = true;
    }
  }

  function renderHistory(listNode, wrapperNode, steps, { lostAt = null, pending = null, pendingStake = 0 } = {}) {
    const items = steps.map((s) => (
      `<li><span class="step-n">${s.n}</span>` +
      `<span class="step-desc"><b>${money(s.stake)}</b> × ${odds(s.odds)}</span>` +
      `<span class="step-payout">${money(s.payout)}</span></li>`
    ));
    if (pending) {
      items.push(
        `<li class="pending"><span class="step-n">${steps.length + 1}</span>` +
        `<span class="step-desc"><b>${money(pendingStake)}</b> × ${odds(pending.odds)}</span>` +
        `<span class="step-payout">en attente</span></li>`
      );
    }
    if (lostAt) {
      const withOdds = lostAt.odds ? ` × ${odds(lostAt.odds)}` : '';
      items.push(
        `<li class="lost"><span class="step-n">${lostAt.n}</span>` +
        `<span class="step-desc"><b>${money(lostAt.stake)}</b>${withOdds} perdu</span>` +
        `<span class="step-payout">−${money(lostAt.stake)}</span></li>`
      );
    }
    listNode.innerHTML = items.join('');
    wrapperNode.hidden = items.length === 0;
  }

  function renderPlay() {
    const { run, settings } = state;
    const stepNumber = run.steps.length + 1;
    el.playStep.textContent = stepNumber;
    el.playAttempt.textContent = `Tentative ${run.attempt}`;
    el.playBankroll.textContent = money(run.bankroll);
    el.playStart.textContent = money(settings.stake);
    el.playTarget.textContent = money(settings.target);

    const pct = progressPercent(run.bankroll, settings.stake, settings.target);
    el.playProgressBar.style.width = `${pct}%`;
    el.playProgress.setAttribute('aria-valuenow', String(Math.round(pct)));

    const pending = run.pending;
    el.screens.play.classList.toggle('has-pending', !!pending);
    el.oddsCard.hidden = !!pending;
    el.pendingCard.hidden = !pending;
    el.actionsPlace.hidden = !!pending;
    el.actionsResult.hidden = !pending;
    if (pending) {
      el.pendingStake.textContent = money(run.bankroll);
      el.pendingOdds.textContent = odds(pending.odds);
      el.pendingPayout.textContent = money(round2(run.bankroll * pending.odds));
    }

    renderHistory(el.playHistoryList, el.playHistory, run.steps, { pending, pendingStake: run.bankroll });
    // L'historique doit rester visible s'il n'y a que le bouton d'annulation à montrer.
    el.btnUndo.hidden = !!pending || run.steps.length === 0;
    el.playHistory.hidden = run.steps.length === 0 && !pending;
    updatePayout();
  }

  function currentOdds() {
    const value = parseNum(el.inputOdds.value);
    return value >= 1.01 ? value : NaN;
  }

  function updatePayout() {
    const o = currentOdds();
    const valid = !Number.isNaN(o);
    el.playPayout.textContent = valid ? money(round2(state.run.bankroll * o)) : '—';
    el.btnPlace.disabled = !valid;
    el.playError.hidden = true;
    // Surligne le bouton rapide correspondant
    el.oddsQuick.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', valid && Number(b.dataset.odds) === o);
    });
  }

  const MAX_HISTORY = 100;

  /** Archive la tentative qui vient de se terminer (gagnée ou perdue), la plus récente en tête. */
  function archiveRun() {
    const { run, settings } = state;
    const lost = run.status === 'lost';
    state.history.unshift({
      attempt: run.attempt,
      status: run.status,
      stake: settings.stake,
      target: settings.target,
      steps: run.steps.map((s) => ({ ...s })),
      lostAt: run.lostAt ? { ...run.lostAt } : null,
      finalBankroll: lost && run.lostAt ? run.lostAt.stake : run.bankroll,
      endedAt: Date.now(),
    });
    if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;
  }

  const CHEVRON = '<svg class="attempt-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

  /** Liste dépliable des tentatives terminées, chacune avec le détail de ses paliers. */
  function renderAttempts(listNode, wrapperNode, history) {
    wrapperNode.hidden = history.length === 0;
    if (history.length === 0) { listNode.innerHTML = ''; return; }
    listNode.innerHTML = '';
    history.forEach((h) => {
      const won = h.status === 'won';
      const passed = h.steps.length;
      const lostStep = h.lostAt ? h.lostAt.n : passed + 1;
      const title = won ? 'Objectif atteint' : `Perdu au palier ${lostStep}`;
      const sub = `Tentative ${h.attempt} · ${passed} palier${passed > 1 ? 's' : ''} passé${passed > 1 ? 's' : ''} · départ ${money(h.stake)}`;
      const amount = won ? money(h.finalBankroll) : `${money(h.finalBankroll)} max`;

      const details = document.createElement('details');
      details.className = `attempt ${won ? 'won' : 'lost'}`;
      details.innerHTML =
        `<summary><span class="attempt-dot" aria-hidden="true"></span>` +
        `<span class="attempt-main"><span class="attempt-title">${title}</span><span class="attempt-sub">${sub}</span></span>` +
        `<span class="attempt-amount">${amount}</span>${CHEVRON}</summary>` +
        `<div class="attempt-body"><ol class="history-list"></ol></div>`;
      const ol = details.querySelector('ol');
      renderHistory(ol, details.querySelector('.attempt-body'), h.steps, { lostAt: won ? null : h.lostAt });
      listNode.appendChild(details);
    });
  }

  function renderEnd() {
    const { run, settings, attempts } = state;
    const won = run.status === 'won';
    el.screens.end.classList.toggle('screen-won', won);
    el.screens.end.classList.toggle('screen-lost', !won);
    el.endBadge.textContent = won ? '🏆' : '💥';
    el.endTitle.textContent = won ? 'Objectif atteint' : `Perdu au palier ${run.lostAt ? run.lostAt.n : run.steps.length + 1}`;
    el.endSub.textContent = won
      ? `Tu es passé de ${money(settings.stake)} à ${money(run.bankroll)} en ${run.steps.length} palier${run.steps.length > 1 ? 's' : ''}.`
      : `Tu avais ${money(run.lostAt ? run.lostAt.stake : run.bankroll)} en jeu. La mise perdue reste ta mise de départ : ${money(settings.stake)}.`;

    el.endFinal.textContent = won ? money(run.bankroll) : `−${money(settings.stake)}`;
    el.endStake.textContent = money(settings.stake);
    el.endTarget.textContent = money(settings.target);
    el.endSteps.textContent = run.steps.length;
    el.endMult.textContent = won ? `×${fmtOdds.format(run.bankroll / settings.stake)}` : '×0,00';

    renderHistory(el.endHistoryList, el.endHistory, run.steps, { lostAt: won ? null : run.lostAt });

    el.endAttempts.textContent = attempts.total;
    el.endWon.textContent = attempts.won;
    el.endLost.textContent = attempts.lost;
    renderAttempts(el.endAttemptsList, el.endAttempts2, state.history);

    if (won) confetti();
  }

  // ---------- Actions ----------
  function startRun() {
    const { stake, target } = state.settings;
    state.attempts.total += 1;
    state.run = {
      status: 'playing',
      bankroll: stake,
      steps: [],
      attempt: state.attempts.total,
      lostAt: null,
      pending: null,
    };
    el.inputOdds.value = '';
    save();
    render();
    // Focus pratique sur mobile
    setTimeout(() => el.inputOdds.focus({ preventScroll: true }), 50);
  }

  function onSetupSubmit(event) {
    event.preventDefault();
    const stake = parseNum(el.inputStake.value);
    const target = parseNum(el.inputTarget.value);
    let error = '';
    if (!(stake > 0)) error = 'Indique une mise de départ valide (supérieure à 0).';
    else if (!(target > 0)) error = 'Indique un objectif valide.';
    else if (target <= stake) error = "L'objectif doit être supérieur à la mise de départ.";
    if (error) {
      el.setupError.textContent = error;
      el.setupError.hidden = false;
      return;
    }
    el.setupError.hidden = true;
    state.settings = { stake: round2(stake), target: round2(target) };
    startRun();
  }

  /** Enregistre la cote du pari placé ; le résultat viendra plus tard. */
  function onPlace() {
    const o = currentOdds();
    if (Number.isNaN(o)) {
      el.playError.textContent = 'Entre la cote du pari (au moins 1,01) avant de le placer.';
      el.playError.hidden = false;
      el.inputOdds.focus();
      return;
    }
    state.run.pending = { odds: o };
    el.inputOdds.value = '';
    save();
    renderPlay();
    if (navigator.vibrate) navigator.vibrate(10);
  }

  /** Repasse en saisie, champ pré-rempli avec la cote du pari en cours. */
  function onEditOdds() {
    const { run } = state;
    if (!run.pending) return;
    el.inputOdds.value = odds(run.pending.odds);
    run.pending = null;
    save();
    renderPlay();
    setTimeout(() => el.inputOdds.focus({ preventScroll: true }), 50);
  }

  /** Annule le dernier palier validé : il redevient un pari en attente. */
  function onUndo() {
    const { run } = state;
    if (run.pending || run.steps.length === 0) return;
    if (!window.confirm('Annuler le dernier palier ? Il redeviendra un pari en attente.')) return;
    const last = run.steps.pop();
    run.bankroll = last.stake;
    run.pending = { odds: last.odds };
    save();
    renderPlay();
  }

  function onWin() {
    const { run, settings } = state;
    if (!run.pending) return;
    const o = run.pending.odds;
    const stake = run.bankroll;
    const payout = round2(stake * o);
    run.steps.push({ n: run.steps.length + 1, stake, odds: o, payout });
    run.bankroll = payout;
    run.pending = null;

    if (payout >= settings.target) {
      run.status = 'won';
      state.attempts.won += 1;
      archiveRun();
      save();
      render();
      return;
    }
    save();
    renderPlay();
    el.playCard.classList.remove('bump');
    // relance l'animation
    void el.playCard.offsetWidth;
    el.playCard.classList.add('bump');
    if (navigator.vibrate) navigator.vibrate(15);
  }

  function onLose() {
    const { run } = state;
    if (!run.pending) return;
    run.lostAt = { n: run.steps.length + 1, stake: run.bankroll, odds: run.pending.odds };
    run.pending = null;
    run.status = 'lost';
    state.attempts.lost += 1;
    archiveRun();
    save();
    render();
    if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
  }

  function onReplay() {
    startRun();
  }

  function onEdit() {
    state.run = defaultState().run;
    el.inputStake.value = '';
    el.inputTarget.value = '';
    save();
    render();
  }

  function onQuit() {
    // Abandonner la partie en cours : elle ne compte ni gagnée ni perdue.
    const started = state.run.steps.length > 0 || !!state.run.pending;
    if (started && !window.confirm('Quitter la partie en cours ? Elle ne sera pas comptée.')) return;
    state.attempts.total = Math.max(0, state.attempts.total - 1);
    onEdit();
  }

  function onReset() {
    if (!window.confirm('Effacer les paramètres et toutes les statistiques ?')) return;
    state = defaultState();
    el.inputStake.value = '';
    el.inputTarget.value = '';
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    render();
  }

  function confetti() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const wrap = document.createElement('div');
    wrap.className = 'confetti';
    const colors = ['#8b5cf6', '#a78bfa', '#f5b53f', '#22c55e', '#ffffff', '#f472b6'];
    for (let i = 0; i < 70; i += 1) {
      const piece = document.createElement('i');
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.background = colors[i % colors.length];
      piece.style.animationDuration = `${2 + Math.random() * 1.8}s`;
      piece.style.animationDelay = `${Math.random() * 0.6}s`;
      piece.style.transform = `rotate(${Math.random() * 360}deg)`;
      wrap.appendChild(piece);
    }
    document.body.appendChild(wrap);
    setTimeout(() => wrap.remove(), 4500);
  }

  // ---------- Événements ----------
  el.setupForm.addEventListener('submit', onSetupSubmit);
  el.inputStake.addEventListener('input', updateSetupHint);
  el.inputTarget.addEventListener('input', updateSetupHint);
  el.btnReset.addEventListener('click', onReset);

  el.inputOdds.addEventListener('input', updatePayout);
  el.inputOdds.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); onPlace(); }
  });
  el.oddsQuick.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-odds]');
    if (!btn) return;
    el.inputOdds.value = odds(Number(btn.dataset.odds));
    updatePayout();
  });
  el.btnPlace.addEventListener('click', onPlace);
  el.btnEditOdds.addEventListener('click', onEditOdds);
  el.btnUndo.addEventListener('click', onUndo);
  el.btnWin.addEventListener('click', onWin);
  el.btnLose.addEventListener('click', onLose);
  el.btnQuit.addEventListener('click', onQuit);
  el.btnReplay.addEventListener('click', onReplay);
  el.btnEdit.addEventListener('click', onEdit);

  // ---------- Démarrage ----------
  render();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* hors ligne ou non supporté */ });
    });
  }
})();
