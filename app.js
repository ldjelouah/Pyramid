/* Pyramid — gestion de bankroll par paliers.
 * Règle du jeu : on mise un montant ; à chaque palier gagné on rejoue
 * l'intégralité du gain sur le palier suivant, jusqu'à atteindre l'objectif.
 */
(() => {
  'use strict';

  const STORAGE_KEY = 'pyramid:v2';
  const LEGACY_KEY = 'pyramid:v1';

  const fmtMoney = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
  const fmtOdds = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = (n) => fmtMoney.format(n);
  const odds = (n) => fmtOdds.format(n);
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

  /** Type d'une entrée de l'historique des paliers ('win' par défaut pour les anciens états). */
  const kindOf = (step) => step.kind || 'win';
  /** Nombre de paliers joués : les récupérations de mise ne sont pas des paliers. */
  const tierCount = (steps) => steps.filter((s) => kindOf(s) !== 'secure').length;
  /** Part du bénéfice de chaque palier gagné mise de côté automatiquement. */
  const WITHHOLD_RATE = 0.05;
  const withheldFor = (stake, payout) => (payout > stake ? round2((payout - stake) * WITHHOLD_RATE) : 0);
  /** La mise de départ a-t-elle déjà été récupérée pendant cette tentative ? */
  const stakeRecovered = (steps) => steps.some((s) => kindOf(s) === 'secure');
  /** Total de la tentative : montant en jeu + montant mis de côté. */
  const totalOf = (run) => round2(run.bankroll + (run.secured || 0));
  const LOCK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

  /** Accepte "12", "12,5", "12.50", " 1 234,5 " → nombre ou NaN. */
  const parseNum = (raw) => {
    if (raw == null) return NaN;
    const cleaned = String(raw).trim().replace(/\s/g, '').replace(',', '.');
    if (!/^\d*\.?\d+$/.test(cleaned) && !/^\d+\.?$/.test(cleaned)) return NaN;
    return Number(cleaned);
  };

  // ---------- État ----------
  const newId = () => `l_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

  /** Une montante : paramètres, partie en cours, compteurs, historique, garde-fou. */
  const defaultLadder = (name) => ({
    id: newId(),
    name,
    createdAt: Date.now(),
    settings: { stake: null, target: null, lossCap: null },
    run: { status: 'idle', bankroll: 0, steps: [], attempt: 0, lostAt: null, pending: null, secured: 0 },
    attempts: { total: 0, won: 0, lost: 0, cashed: 0 },
    history: [],
    // Garde-fou : pertes mesurées depuis `since`, pause active jusqu'à `pausedUntil`.
    guard: { since: 0, pausedUntil: null },
    // 'home' : l'utilisateur a quitté l'écran de partie avec la flèche, la partie reste en cours.
    view: 'auto',
    // Dernière partie abandonnée, restaurable jusqu'au démarrage de la suivante.
    abandoned: null,
  });

  const PAUSE_MS = 24 * 60 * 60 * 1000;

  /** Fusionne une montante stockée avec les valeurs par défaut (anciens champs absents). */
  function normalizeLadder(parsed, fallbackName) {
    const base = defaultLadder(fallbackName);
    return {
      id: typeof parsed.id === 'string' && parsed.id ? parsed.id : base.id,
      name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim().slice(0, 24) : fallbackName,
      createdAt: parsed.createdAt || base.createdAt,
      settings: { ...base.settings, ...(parsed.settings || {}) },
      run: { ...base.run, ...(parsed.run || {}) },
      attempts: { ...base.attempts, ...(parsed.attempts || {}) },
      history: Array.isArray(parsed.history) ? parsed.history : [],
      guard: { ...base.guard, ...(parsed.guard || {}) },
      view: parsed.view === 'home' ? 'home' : 'auto',
      abandoned: parsed.abandoned && parsed.abandoned.run ? parsed.abandoned : null,
    };
  }

  /** Racine : toutes les montantes et celle qui est affichée. */
  let root = load();
  /** La montante active. Tout le reste du code lit et écrit `state`. */
  let state = activeLadder();
  // Persiste tout de suite le format courant (utile juste après une migration depuis v1).
  save();

  function activeLadder() {
    let found = root.ladders.find((l) => l.id === root.activeId);
    if (!found) { found = root.ladders[0]; root.activeId = found.id; }
    return found;
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const ladders = (Array.isArray(parsed.ladders) ? parsed.ladders : [])
          .map((l, i) => normalizeLadder(l, `Montante ${i + 1}`));
        if (ladders.length > 0) return { activeId: parsed.activeId, ladders };
      }
      // Migration depuis l'ancien format à une seule montante. La clé v1 est laissée en place.
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        const ladder = normalizeLadder(JSON.parse(legacy), 'Bet365');
        return { activeId: ladder.id, ladders: [ladder] };
      }
    } catch {
      /* état illisible : on repart de zéro */
    }
    const ladder = defaultLadder('Montante 1');
    return { activeId: ladder.id, ladders: [ladder] };
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(root));
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
    inputLossCap: $('input-losscap'),
    pauseCard: $('pause-card'),
    pauseSub: $('pause-sub'),
    pauseRemaining: $('pause-remaining'),
    btnResume: $('btn-resume'),
    balanceCard: $('balance-card'),
    balanceNet: $('balance-net'),
    balanceCount: $('balance-count'),
    balanceCountLabel: $('balance-count-label'),
    balanceStaked: $('balance-staked'),
    balanceLost: $('balance-lost'),
    balanceGained: $('balance-gained'),
    balanceSecured: $('balance-secured'),
    capBlock: $('cap-block'),
    capProgress: $('cap-progress'),
    capProgressBar: $('cap-progress-bar'),
    capProgressText: $('cap-progress-text'),
    endCapBanner: $('end-cap-banner'),
    btnSeeBalance: $('btn-see-balance'),
    statAttempts: $('stat-attempts'),
    statWon: $('stat-won'),
    statLost: $('stat-lost'),
    btnReset: $('btn-reset'),
    ladderTabs: $('ladder-tabs'),
    ladderActions: $('ladder-actions'),
    btnRename: $('btn-rename'),
    btnDelete: $('btn-delete'),
    ladderForm: $('ladder-form'),
    ladderFormTitle: $('ladder-form-title'),
    ladderSuggest: $('ladder-suggest'),
    inputLadderName: $('input-ladder-name'),
    ladderError: $('ladder-error'),
    btnLadderCancel: $('btn-ladder-cancel'),
    btnLadderSubmit: $('btn-ladder-submit'),
    playLadder: $('play-ladder'),
    setupAttempts: $('setup-attempts'),
    setupAttemptsList: $('setup-attempts-list'),
    // play
    btnQuit: $('btn-quit'),
    resumeCard: $('resume-card'),
    resumeKicker: $('resume-kicker'),
    resumeAmount: $('resume-amount'),
    resumeDetail: $('resume-detail'),
    btnContinue: $('btn-continue'),
    btnAbandon: $('btn-abandon'),
    btnRestore: $('btn-restore'),
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
    playSecured: $('play-secured'),
    playSecuredAmount: $('play-secured-amount'),
    sideActions: $('side-actions'),
    btnSecure: $('btn-secure'),
    btnCashin: $('btn-cashin'),
    btnCashout: $('btn-cashout'),
    cashoutForm: $('cashout-form'),
    inputCashout: $('input-cashout'),
    cashoutError: $('cashout-error'),
    btnCashoutCancel: $('btn-cashout-cancel'),
    pendingHint: $('pending-hint'),
    pendingWithheld: $('pending-withheld'),
    statCashed: $('stat-cashed'),
    endCashed: $('end-cashed'),
    endTotal: $('end-total'),
    endSecured: $('end-secured'),
    endSecuredRow: $('end-secured-row'),
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

  // ---------- Bilan global et garde-fou ----------
  /** Résultat net d'une tentative archivée : ce qu'on a en plus ou en moins par rapport à la mise. */
  function netOf(entry) {
    const secured = entry.secured || 0;
    if (entry.status === 'lost') return round2(secured - entry.stake);
    return round2(entry.finalBankroll + secured - entry.stake);
  }

  function summarize(entries) {
    const sum = { count: entries.length, staked: 0, lost: 0, gained: 0, secured: 0, net: 0 };
    entries.forEach((e) => {
      const net = netOf(e);
      sum.staked += e.stake;
      sum.secured += e.secured || 0;
      sum.net += net;
      if (net < 0) sum.lost += -net; else sum.gained += net;
    });
    Object.keys(sum).forEach((k) => { if (k !== 'count') sum[k] = round2(sum[k]); });
    return sum;
  }

  /** Perte nette cumulée depuis une date (0 si le solde est positif). */
  function lossSince(ts) {
    const net = state.history.filter((e) => (e.endedAt || 0) >= ts).reduce((acc, e) => acc + netOf(e), 0);
    return net < 0 ? round2(-net) : 0;
  }

  const isPaused = () => state.guard.pausedUntil != null && state.guard.pausedUntil > Date.now();

  /** Lève une pause expirée et réarme le compteur de pertes. */
  function expirePause() {
    const { guard } = state;
    if (guard.pausedUntil != null && guard.pausedUntil <= Date.now()) {
      guard.pausedUntil = null;
      guard.since = Date.now();
      save();
    }
  }

  /** Déclenche la pause si le plafond de perte vient d'être atteint. Renvoie true si c'est le cas. */
  function checkLossCap() {
    const cap = state.settings.lossCap;
    if (!(cap > 0) || isPaused()) return false;
    if (lossSince(state.guard.since) >= cap) {
      state.guard.pausedUntil = Date.now() + PAUSE_MS;
      return true;
    }
    return false;
  }

  function formatRemaining(ms) {
    const totalMin = Math.max(1, Math.ceil(ms / 60000));
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h === 0) return `${m} min`;
    return `${h} h ${String(m).padStart(2, '0')} min`;
  }

  const fmtDate = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long' });

  function signedMoney(n) {
    if (n > 0) return `+${money(n)}`;
    if (n < 0) return `−${money(-n)}`;
    return money(0);
  }

  function setSignClass(node, n) {
    node.classList.toggle('pos', n > 0);
    node.classList.toggle('neg', n < 0);
    node.classList.toggle('zero', n === 0);
  }

  function renderBalance() {
    const { history, settings, guard, attempts } = state;
    el.balanceCard.hidden = history.length === 0;
    if (history.length === 0) return;
    const sum = summarize(history);
    el.balanceNet.textContent = signedMoney(sum.net);
    setSignClass(el.balanceNet, sum.net);
    el.balanceCount.textContent = sum.count;
    el.balanceCountLabel.textContent = attempts.total > sum.count ? 'Tentatives (avec montants connus)' : 'Tentatives';
    el.balanceStaked.textContent = money(sum.staked);
    el.balanceLost.textContent = sum.lost > 0 ? `−${money(sum.lost)}` : money(0);
    el.balanceGained.textContent = sum.gained > 0 ? `+${money(sum.gained)}` : money(0);
    el.balanceSecured.textContent = money(sum.secured);

    const cap = settings.lossCap;
    el.capBlock.hidden = !(cap > 0);
    if (cap > 0) {
      const loss = lossSince(guard.since);
      const pct = Math.max(0, Math.min(100, (loss / cap) * 100));
      el.capProgressText.textContent = `${money(loss)} / ${money(cap)}`;
      el.capProgressBar.style.width = `${pct}%`;
      el.capProgress.classList.toggle('progress-danger', pct >= 80);
    }
  }

  let pauseTimer = null;
  function renderPause() {
    const paused = isPaused();
    el.pauseCard.hidden = !paused;
    el.setupForm.hidden = paused || state.run.status === 'playing';
    if (pauseTimer) { clearInterval(pauseTimer); pauseTimer = null; }
    if (!paused) return;
    const { guard, settings } = state;
    const since = state.history.filter((e) => (e.endedAt || 0) >= guard.since);
    const sum = summarize(since);
    const from = since.length ? fmtDate.format(new Date(Math.min(...since.map((e) => e.endedAt)))) : '';
    el.pauseSub.textContent = `Tu as perdu ${money(sum.lost - sum.gained)} sur ${sum.count} tentative${sum.count > 1 ? 's' : ''}` +
      (from ? ` depuis le ${from}` : '') + `, pour un plafond de ${money(settings.lossCap)}.`;
    const tick = () => {
      if (!isPaused()) { expirePause(); render(); return; }
      el.pauseRemaining.textContent = formatRemaining(guard.pausedUntil - Date.now());
    };
    tick();
    pauseTimer = setInterval(tick, 30000);
  }

  // ---------- Confirmation en deux temps (abandon, suppression) ----------
  /** Premier appui : bouton rouge inactif 2 s, puis actif 8 s. Second appui : onConfirm(). */
  function twoStep(btn, idleLabel, confirmLabel, onConfirm) {
    let timers = [];
    const reset = () => {
      timers.forEach(clearTimeout);
      timers = [];
      btn.classList.remove('btn-danger-confirm');
      btn.disabled = false;
      btn.textContent = idleLabel;
      btn.dataset.armed = '';
    };
    const click = () => {
      if (btn.dataset.armed === 'ready') { reset(); onConfirm(); return; }
      if (btn.dataset.armed === 'arming') return;
      btn.dataset.armed = 'arming';
      btn.classList.add('btn-danger-confirm');
      btn.disabled = true;
      let left = 2;
      btn.textContent = `${confirmLabel} (${left})`;
      const tick = () => {
        left -= 1;
        if (left > 0) {
          btn.textContent = `${confirmLabel} (${left})`;
          timers.push(setTimeout(tick, 1000));
        } else {
          btn.textContent = confirmLabel;
          btn.disabled = false;
          btn.dataset.armed = 'ready';
          timers.push(setTimeout(reset, 8000));
        }
      };
      timers.push(setTimeout(tick, 1000));
    };
    return { click, reset };
  }

  // ---------- Montantes (sélecteur) ----------
  const LADDER_NAME_MAX = 24;
  let ladderFormMode = null; // null | 'create' | 'rename'

  function ladderStatus(l) {
    if (l.guard.pausedUntil != null && l.guard.pausedUntil > Date.now()) return 'paused';
    if (l.run.status === 'playing') return l.run.pending ? 'pending' : 'playing';
    return 'idle';
  }

  function renderLadderTabs() {
    el.ladderTabs.innerHTML = '';
    root.ladders.forEach((l) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `ladder-tab${l.id === root.activeId ? ' active' : ''}`;
      b.dataset.id = l.id;
      b.innerHTML = `<span class="ladder-dot ${ladderStatus(l)}" aria-hidden="true"></span>${escapeHtml(l.name)}`;
      b.setAttribute('aria-pressed', String(l.id === root.activeId));
      el.ladderTabs.appendChild(b);
    });
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'ladder-tab add';
    add.dataset.action = 'add';
    add.textContent = '+';
    add.setAttribute('aria-label', 'Nouvelle montante');
    el.ladderTabs.appendChild(add);

    el.btnDelete.hidden = root.ladders.length <= 1;
    el.ladderActions.hidden = ladderFormMode !== null;
    el.ladderForm.hidden = ladderFormMode === null;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function selectLadder(id) {
    if (!root.ladders.some((l) => l.id === id)) return;
    root.activeId = id;
    state = activeLadder();
    ladderFormMode = null;
    el.inputStake.value = '';
    el.inputTarget.value = '';
    el.inputLossCap.value = '';
    el.inputOdds.value = '';
    save();
    render();
  }

  function openLadderForm(mode) {
    ladderFormMode = mode;
    el.ladderFormTitle.textContent = mode === 'rename' ? 'Renommer la montante' : 'Nouvelle montante';
    el.btnLadderSubmit.textContent = mode === 'rename' ? 'Renommer' : 'Créer';
    el.inputLadderName.value = mode === 'rename' ? state.name : '';
    el.ladderError.hidden = true;
    el.ladderSuggest.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.name === el.inputLadderName.value));
    renderLadderTabs();
    setTimeout(() => el.inputLadderName.focus({ preventScroll: true }), 50);
  }

  function closeLadderForm() {
    ladderFormMode = null;
    renderLadderTabs();
  }

  function validLadderName(raw, excludeId) {
    const name = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, LADDER_NAME_MAX);
    if (!name) return { error: 'Indique un nom pour cette montante.' };
    const dup = root.ladders.some((l) => l.id !== excludeId && l.name.toLowerCase() === name.toLowerCase());
    if (dup) return { error: `Une montante « ${name} » existe déjà.` };
    return { name };
  }

  function onLadderSubmit(event) {
    event.preventDefault();
    const check = validLadderName(el.inputLadderName.value, ladderFormMode === 'rename' ? state.id : null);
    if (check.error) {
      el.ladderError.textContent = check.error;
      el.ladderError.hidden = false;
      return;
    }
    if (ladderFormMode === 'rename') {
      state.name = check.name;
      ladderFormMode = null;
      save();
      render();
      return;
    }
    const ladder = defaultLadder(check.name);
    root.ladders.push(ladder);
    ladderFormMode = null;
    selectLadder(ladder.id);
  }

  function onDeleteConfirmed() {
    if (root.ladders.length <= 1) return;
    const idx = root.ladders.findIndex((l) => l.id === state.id);
    root.ladders.splice(idx, 1);
    selectLadder(root.ladders[Math.max(0, idx - 1)].id);
  }

  // ---------- Partie en cours vue depuis l'accueil ----------
  const abandonCtl = twoStep(el.btnAbandon, 'Abandonner cette partie', "Confirmer l'abandon", onAbandonConfirmed);
  const deleteCtl = twoStep(el.btnDelete, 'Supprimer', 'Confirmer la suppression', onDeleteConfirmed);
  function resetAbandon() {
    abandonCtl.reset();
    deleteCtl.reset();
  }

  function renderResume() {
    const { run, abandoned } = state;
    const playing = run.status === 'playing';
    el.resumeCard.hidden = !playing;
    resetAbandon();
    if (playing) {
      const tiers = tierCount(run.steps);
      el.resumeKicker.textContent = `Partie en cours · Palier ${tiers + 1} · Tentative ${run.attempt}`;
      el.resumeAmount.textContent = money(run.bankroll);
      const bits = [];
      if (run.pending) bits.push(`Pari en cours à la cote ${odds(run.pending.odds)}`);
      if (run.secured > 0) bits.push(`${money(run.secured)} sécurisés`);
      el.resumeDetail.textContent = bits.join(' · ');
    }
    el.btnRestore.hidden = !abandoned || playing;
    if (abandoned && !playing) {
      const r = abandoned.run;
      el.btnRestore.textContent = `Restaurer la partie abandonnée (palier ${tierCount(r.steps) + 1}, ${money(r.bankroll)} en jeu)`;
    }
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
    expirePause();
    const { run } = state;
    if (run.status === 'playing' && state.view !== 'home') {
      renderPlay();
      showScreen('play');
    } else if (run.status === 'won' || run.status === 'lost' || run.status === 'cashed') {
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
    if (settings.lossCap != null && !el.inputLossCap.value) el.inputLossCap.value = String(settings.lossCap).replace('.', ',');
    updateSetupHint();
    renderLadderTabs();
    renderPause();
    renderResume();
    renderBalance();

    const hasHistory = attempts.total > 0;
    el.setupStats.hidden = !hasHistory;
    el.btnReset.hidden = !hasHistory && settings.stake == null;
    el.statAttempts.textContent = attempts.total;
    el.statWon.textContent = attempts.won;
    el.statLost.textContent = attempts.lost;
    el.statCashed.textContent = attempts.cashed;
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

  function stepRow(s) {
    const kind = kindOf(s);
    if (kind === 'secure') {
      return `<li class="secure"><span class="step-n">${LOCK}</span>` +
        `<span class="step-desc">Mise de départ récupérée</span>` +
        `<span class="step-payout">+${money(s.amount)}</span></li>`;
    }
    if (kind === 'cashout') {
      const dir = s.payout >= s.stake ? 'up' : 'down';
      return `<li class="cashout"><span class="step-n">${s.n}</span>` +
        `<span class="step-desc"><b>${money(s.stake)}</b> <span class="step-tag">cashout</span>${withheldTag(s)}</span>` +
        `<span class="step-payout ${dir}">${money(s.payout)}</span></li>`;
    }
    return `<li><span class="step-n">${s.n}</span>` +
      `<span class="step-desc"><b>${money(s.stake)}</b> × ${odds(s.odds)}${withheldTag(s)}</span>` +
      `<span class="step-payout">${money(s.payout)}</span></li>`;
  }

  function withheldTag(s) {
    return s.withheld > 0 ? `<span class="step-withheld">${money(s.withheld)} mis de côté</span>` : '';
  }

  function renderHistory(listNode, wrapperNode, steps, { lostAt = null, pending = null, pendingStake = 0 } = {}) {
    const items = steps.map(stepRow);
    if (pending) {
      items.push(
        `<li class="pending"><span class="step-n">${tierCount(steps) + 1}</span>` +
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
    const tiers = tierCount(run.steps);
    el.playStep.textContent = tiers + 1;
    el.playAttempt.textContent = `Tentative ${run.attempt}`;
    el.playLadder.textContent = root.ladders.length > 1 ? `${state.name} · ` : '';
    el.playBankroll.textContent = money(run.bankroll);
    el.playStart.textContent = money(settings.stake);
    el.playTarget.textContent = money(settings.target);

    const total = totalOf(run);
    const pct = progressPercent(total, settings.stake, settings.target);
    el.playSecured.hidden = !(run.secured > 0);
    if (run.secured > 0) el.playSecuredAmount.textContent = money(run.secured);
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
      const gross = round2(run.bankroll * pending.odds);
      const kept = withheldFor(run.bankroll, gross);
      el.pendingPayout.textContent = money(gross);
      el.pendingWithheld.textContent = kept > 0
        ? `${money(kept)} mis de côté, ${money(round2(gross - kept))} rejoués au palier suivant.`
        : '';
    }

    // Le formulaire de cashout repart toujours fermé.
    el.cashoutForm.hidden = true;
    el.pendingHint.hidden = false;

    // Actions secondaires : récupérer la mise, encaisser la série.
    const canSecure = !pending && !stakeRecovered(run.steps) && run.bankroll > settings.stake;
    const canCashIn = !pending && run.steps.length > 0;
    el.btnSecure.hidden = !canSecure;
    el.btnSecure.textContent = `Récupérer ma mise · ${money(settings.stake)}`;
    el.btnCashin.hidden = !canCashIn;
    el.btnCashin.textContent = `Encaisser · ${money(total)}`;
    el.sideActions.hidden = !canSecure && !canCashIn;

    renderHistory(el.playHistoryList, el.playHistory, run.steps, { pending, pendingStake: run.bankroll });
    // L'historique doit rester visible s'il n'y a que le bouton d'annulation à montrer.
    el.btnUndo.hidden = !!pending || run.steps.length === 0;
    const last = run.steps[run.steps.length - 1];
    el.btnUndo.textContent = last && kindOf(last) === 'secure'
      ? 'Annuler la récupération de la mise'
      : 'Annuler le dernier palier';
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
    if (valid) {
      const stake = state.run.bankroll;
      const gross = round2(stake * o);
      el.playPayout.textContent = money(round2(gross - withheldFor(stake, gross)));
    } else {
      el.playPayout.textContent = '—';
    }
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
      secured: run.secured || 0,
      endedAt: Date.now(),
    });
    if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;
    checkLossCap();
  }

  const CHEVRON = '<svg class="attempt-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

  /** Liste dépliable des tentatives terminées, chacune avec le détail de ses paliers. */
  function renderAttempts(listNode, wrapperNode, history) {
    wrapperNode.hidden = history.length === 0;
    if (history.length === 0) { listNode.innerHTML = ''; return; }
    listNode.innerHTML = '';
    history.forEach((h) => {
      const status = h.status;
      const lost = status === 'lost';
      const secured = h.secured || 0;
      const passed = tierCount(h.steps);
      const lostStep = h.lostAt ? h.lostAt.n : passed + 1;
      const titles = { won: 'Objectif atteint', cashed: 'Série encaissée', lost: `Perdu au palier ${lostStep}` };
      const title = titles[status] || titles.lost;
      const sub = `Tentative ${h.attempt} · ${passed} palier${passed > 1 ? 's' : ''} passé${passed > 1 ? 's' : ''} · départ ${money(h.stake)}` +
        (stakeRecovered(h.steps) ? ' · mise récupérée' : '') +
        (lost && secured > 0 ? ` · ${money(secured)} gardés` : '');
      const amount = lost ? `${money(h.finalBankroll)} max` : money(round2(h.finalBankroll + secured));

      const details = document.createElement('details');
      details.className = `attempt ${status}`;
      details.innerHTML =
        `<summary><span class="attempt-dot" aria-hidden="true"></span>` +
        `<span class="attempt-main"><span class="attempt-title">${title}</span><span class="attempt-sub">${sub}</span></span>` +
        `<span class="attempt-amount">${amount}</span>${CHEVRON}</summary>` +
        `<div class="attempt-body"><ol class="history-list"></ol></div>`;
      const ol = details.querySelector('ol');
      renderHistory(ol, details.querySelector('.attempt-body'), h.steps, { lostAt: lost ? h.lostAt : null });
      listNode.appendChild(details);
    });
  }

  function renderEnd() {
    const { run, settings, attempts } = state;
    const status = run.status;
    const won = status === 'won';
    const cashed = status === 'cashed';
    const lost = status === 'lost';
    const secured = run.secured || 0;
    const tiers = tierCount(run.steps);
    const plural = tiers > 1 ? 's' : '';
    // En cas de perte, il ne reste que ce qui a été mis de côté.
    const total = lost ? secured : totalOf(run);
    const net = round2(total - settings.stake);

    el.screens.end.classList.toggle('screen-won', won);
    el.screens.end.classList.toggle('screen-cashed', cashed);
    el.screens.end.classList.toggle('screen-lost', lost);
    el.endBadge.textContent = won ? '🏆' : cashed ? '💰' : '💥';
    el.endTitle.textContent = won
      ? 'Objectif atteint'
      : cashed ? 'Série encaissée' : `Perdu au palier ${run.lostAt ? run.lostAt.n : tiers + 1}`;
    const lostStake = run.lostAt ? run.lostAt.stake : run.bankroll;
    const prefix = root.ladders.length > 1 ? `${state.name} : ` : '';
    el.endSub.textContent = prefix + (won
      ? `Tu es passé de ${money(settings.stake)} à ${money(total)} en ${tiers} palier${plural}.`
      : cashed
        ? `Tu as encaissé ${money(total)} après ${tiers} palier${plural}.`
        : stakeRecovered(run.steps)
          ? `Tu avais ${money(lostStake)} en jeu. Ta mise de départ était déjà récupérée : tu gardes ${money(secured)}.`
          : secured > 0
            ? `Tu avais ${money(lostStake)} en jeu. Il te reste ${money(secured)} mis de côté.`
          : `Tu avais ${money(lostStake)} en jeu. La mise perdue reste ta mise de départ : ${money(settings.stake)}.`);

    el.endFinal.textContent = net > 0 ? `+${money(net)}` : net < 0 ? `−${money(-net)}` : money(0);
    el.endFinal.classList.toggle('pos', net > 0);
    el.endFinal.classList.toggle('neg', net < 0);
    el.endFinal.classList.toggle('zero', net === 0);
    el.endTotal.textContent = money(total);
    el.endSecuredRow.hidden = !(secured > 0);
    el.endSecured.textContent = money(secured);
    el.endStake.textContent = money(settings.stake);
    el.endTarget.textContent = money(settings.target);
    el.endSteps.textContent = tiers;
    el.endMult.textContent = `×${fmtOdds.format(total / settings.stake)}`;

    renderHistory(el.endHistoryList, el.endHistory, run.steps, { lostAt: lost ? run.lostAt : null });

    el.endAttempts.textContent = attempts.total;
    el.endWon.textContent = attempts.won;
    el.endLost.textContent = attempts.lost;
    el.endCashed.textContent = attempts.cashed;
    const paused = isPaused();
    el.endCapBanner.hidden = !paused;
    el.btnReplay.hidden = paused;
    el.btnSeeBalance.hidden = !paused;
    if (paused) {
      const loss = lossSince(state.guard.since);
      el.endCapBanner.textContent = `Plafond de perte atteint : −${money(loss)} depuis la dernière pause. Pause de 24 h proposée.`;
    }
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
      secured: 0,
    };
    state.view = 'auto';
    state.abandoned = null;
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
    const capRaw = el.inputLossCap.value.trim();
    const cap = capRaw === '' ? null : parseNum(capRaw);
    let error = '';
    if (!(stake > 0)) error = 'Indique une mise de départ valide (supérieure à 0).';
    else if (!(target > 0)) error = 'Indique un objectif valide.';
    else if (target <= stake) error = "L'objectif doit être supérieur à la mise de départ.";
    else if (cap !== null && !(cap > 0)) error = 'Le plafond de perte doit être supérieur à 0, ou laissé vide.';
    if (error) {
      el.setupError.textContent = error;
      el.setupError.hidden = false;
      return;
    }
    el.setupError.hidden = true;
    state.settings = { stake: round2(stake), target: round2(target), lossCap: cap === null ? null : round2(cap) };
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

  /** Annule la dernière entrée : un palier (gagné ou soldé) redevient un pari en attente,
   *  une récupération de mise est remise en jeu. */
  function onUndo() {
    const { run } = state;
    if (run.pending || run.steps.length === 0) return;
    const last = run.steps[run.steps.length - 1];
    const kind = kindOf(last);
    const message = kind === 'secure'
      ? 'Annuler la récupération de la mise ? Elle sera remise en jeu.'
      : 'Annuler le dernier palier ? Il redeviendra un pari en attente.';
    if (!window.confirm(message)) return;
    run.steps.pop();
    if (kind === 'secure') {
      run.bankroll = round2(run.bankroll + last.amount);
      run.secured = round2((run.secured || 0) - last.amount);
    } else {
      run.bankroll = last.stake;
      run.secured = round2((run.secured || 0) - (last.withheld || 0));
      run.pending = { odds: last.odds };
    }
    save();
    renderPlay();
  }

  function bumpCard() {
    el.playCard.classList.remove('bump');
    void el.playCard.offsetWidth; // relance l'animation
    el.playCard.classList.add('bump');
    if (navigator.vibrate) navigator.vibrate(15);
  }

  /** Après un gain ou un cashout : victoire si le total atteint l'objectif, sinon palier suivant. */
  function afterTierSettled() {
    if (totalOf(state.run) >= state.settings.target) {
      state.run.status = 'won';
      state.attempts.won += 1;
      archiveRun();
      save();
      render();
      return;
    }
    save();
    renderPlay();
    bumpCard();
  }

  function onWin() {
    const { run } = state;
    if (!run.pending) return;
    const o = run.pending.odds;
    const stake = run.bankroll;
    const payout = round2(stake * o);
    const withheld = withheldFor(stake, payout);
    run.steps.push({ kind: 'win', n: tierCount(run.steps) + 1, stake, odds: o, payout, withheld });
    run.bankroll = round2(payout - withheld);
    run.secured = round2((run.secured || 0) + withheld);
    run.pending = null;
    afterTierSettled();
  }

  /** Cashout du bookmaker : le pari est soldé au montant proposé, qui devient la nouvelle mise. */
  function onCashoutOpen() {
    if (!state.run.pending) return;
    el.cashoutForm.hidden = false;
    el.pendingHint.hidden = true;
    el.cashoutError.hidden = true;
    el.inputCashout.value = '';
    setTimeout(() => el.inputCashout.focus({ preventScroll: true }), 50);
  }

  function onCashoutCancel() {
    el.cashoutForm.hidden = true;
    el.pendingHint.hidden = false;
  }

  function onCashoutSubmit(event) {
    event.preventDefault();
    const { run } = state;
    if (!run.pending) return;
    const amount = parseNum(el.inputCashout.value);
    if (!(amount > 0)) {
      el.cashoutError.textContent = 'Indique le montant proposé par le bookmaker.';
      el.cashoutError.hidden = false;
      el.inputCashout.focus();
      return;
    }
    const stake = run.bankroll;
    const payout = round2(amount);
    const withheld = withheldFor(stake, payout);
    run.steps.push({ kind: 'cashout', n: tierCount(run.steps) + 1, stake, odds: run.pending.odds, payout, withheld });
    run.bankroll = round2(payout - withheld);
    run.secured = round2((run.secured || 0) + withheld);
    run.pending = null;
    afterTierSettled();
  }

  /** Met de côté la mise de départ, une fois par tentative, dès que le montant en jeu la dépasse. */
  function onSecure() {
    const { run, settings } = state;
    if (run.pending || stakeRecovered(run.steps) || !(run.bankroll > settings.stake)) return;
    const amount = settings.stake;
    run.bankroll = round2(run.bankroll - amount);
    run.secured = round2((run.secured || 0) + amount);
    run.steps.push({ kind: 'secure', amount });
    save();
    renderPlay();
    if (navigator.vibrate) navigator.vibrate(10);
  }

  /** Arrête la série avant l'objectif et encaisse le total. */
  function onCashIn() {
    const { run } = state;
    if (run.pending || run.steps.length === 0) return;
    const total = totalOf(run);
    if (!window.confirm(`Encaisser ${money(total)} et arrêter la série ?`)) return;
    run.status = 'cashed';
    state.attempts.cashed += 1;
    archiveRun();
    save();
    render();
  }

  function onLose() {
    const { run } = state;
    if (!run.pending) return;
    run.lostAt = { n: tierCount(run.steps) + 1, stake: run.bankroll, odds: run.pending.odds };
    run.pending = null;
    run.status = 'lost';
    state.attempts.lost += 1;
    archiveRun();
    save();
    render();
    if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
  }

  function onReplay() {
    if (isPaused()) { onEdit(); return; }
    startRun();
  }

  /** Lève la pause avant son terme, après confirmation, et réarme le compteur de pertes. */
  function onResume() {
    const loss = lossSince(state.guard.since);
    if (!window.confirm(`Tu as perdu ${money(loss)} depuis la dernière pause. Relancer quand même ?`)) return;
    state.guard.pausedUntil = null;
    state.guard.since = Date.now();
    save();
    render();
  }

  function onEdit() {
    state.run = defaultLadder(state.name).run;
    state.view = 'auto';
    el.inputStake.value = '';
    el.inputTarget.value = '';
    el.inputLossCap.value = '';
    save();
    render();
  }

  /** Flèche retour : on revient à l'accueil, la partie reste en cours. */
  function onBack() {
    state.view = 'home';
    save();
    render();
  }

  function onContinue() {
    state.view = 'auto';
    save();
    render();
  }

  /** Abandon confirmé : la partie ne compte ni gagnée ni perdue, mais reste restaurable. */
  function onAbandonConfirmed() {
    const { run } = state;
    state.abandoned = { run: JSON.parse(JSON.stringify(run)), attemptsTotalBefore: state.attempts.total, at: Date.now() };
    state.attempts.total = Math.max(0, state.attempts.total - 1);
    state.run = defaultLadder(state.name).run;
    state.view = 'auto';
    save();
    render();
  }

  function onRestore() {
    const { abandoned } = state;
    if (!abandoned || state.run.status === 'playing') return;
    state.run = abandoned.run;
    state.attempts.total = abandoned.attemptsTotalBefore;
    state.abandoned = null;
    state.view = 'home';
    save();
    render();
  }

  function onReset() {
    if (!window.confirm(`Effacer les paramètres et toutes les statistiques de « ${state.name} » ?`)) return;
    const fresh = defaultLadder(state.name);
    fresh.id = state.id;
    fresh.createdAt = state.createdAt;
    Object.keys(state).forEach((k) => { delete state[k]; });
    Object.assign(state, fresh);
    el.inputStake.value = '';
    el.inputTarget.value = '';
    el.inputLossCap.value = '';
    save();
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
  el.btnResume.addEventListener('click', onResume);
  el.ladderTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.action === 'add') { openLadderForm('create'); return; }
    if (btn.dataset.id && btn.dataset.id !== root.activeId) selectLadder(btn.dataset.id);
  });
  el.btnRename.addEventListener('click', () => openLadderForm('rename'));
  el.btnDelete.addEventListener('click', deleteCtl.click);
  el.btnLadderCancel.addEventListener('click', closeLadderForm);
  el.ladderForm.addEventListener('submit', onLadderSubmit);
  el.ladderSuggest.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-name]');
    if (!b) return;
    el.inputLadderName.value = b.dataset.name;
    el.ladderError.hidden = true;
    el.ladderSuggest.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
  });
  el.inputLadderName.addEventListener('input', () => {
    el.ladderSuggest.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x.dataset.name === el.inputLadderName.value));
  });
  el.btnSeeBalance.addEventListener('click', onEdit);

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
  el.btnSecure.addEventListener('click', onSecure);
  el.btnCashin.addEventListener('click', onCashIn);
  el.btnCashout.addEventListener('click', onCashoutOpen);
  el.btnCashoutCancel.addEventListener('click', onCashoutCancel);
  el.cashoutForm.addEventListener('submit', onCashoutSubmit);
  el.btnWin.addEventListener('click', onWin);
  el.btnLose.addEventListener('click', onLose);
  el.btnQuit.addEventListener('click', onBack);
  el.btnContinue.addEventListener('click', onContinue);
  el.btnAbandon.addEventListener('click', abandonCtl.click);
  el.btnRestore.addEventListener('click', onRestore);
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
