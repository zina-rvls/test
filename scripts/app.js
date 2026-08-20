/**
 * Rohy — application de suivi des dépenses entre amis.
 * Port fidèle de l'UI et des interactions du prototype de design
 * (design_handoff_expense_tracker/Depenses App.dc.html) en HTML/CSS/JS
 * vanilla. Le moteur de calcul est isolé dans scripts/calc.js (testé
 * séparément, cf. tests/calc.test.js).
 *
 * Backend : Supabase (auth réelle, Postgres, invitations par e-mail — cf.
 * supabase/). `scripts/supabase-client.js` expose `window.supabaseClient`.
 */
(function () {
  'use strict';

  var calc = window.RohyCalc;
  var seed = window.RohyData;
  var sb = window.supabaseClient;
  // URL publique fixe plutôt que window.location.origin/pathname : dans le
  // shell natif Capacitor, l'origine de la webview est capacitor://localhost
  // (iOS) ou https://localhost (Android), inutilisable comme cible d'un
  // lien envoyé par e-mail (magic link, réinitialisation de mot de passe)
  // ou partagé (lien d'invitation à un groupe) — équivalent à
  // window.location.origin + window.location.pathname sur le web déployé.
  var APP_URL = 'https://rohy-app.com/';
  var THEME_KEY = 'rohy-theme';
  var UPGRADE_NUDGE_DISMISSED_KEY = 'rohy-upgrade-nudge-dismissed';
  var FEEDBACK_LAST_SHOWN_KEY = 'rohy-feedback-last-shown';
  var FEEDBACK_PROMPT_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
  var REMINDERS_DISMISSED_KEY = 'rohy-reminders-dismissed';

  function fmtDate(iso) {
    var d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function loadTheme() {
    try { return localStorage.getItem(THEME_KEY) || 'light'; } catch (err) { return 'light'; }
  }
  function saveTheme(theme) {
    try { localStorage.setItem(THEME_KEY, theme); } catch (err) { /* mode privé / quota */ }
  }

  var LANDING_LANG_KEY = 'rohy-landing-lang';
  function loadLandingLang() {
    try { return localStorage.getItem(LANDING_LANG_KEY) || 'fr'; } catch (err) { return 'fr'; }
  }
  function saveLandingLang(lang) {
    try { localStorage.setItem(LANDING_LANG_KEY, lang); } catch (err) { /* mode privé / quota */ }
  }

  // Consentement à la mesure d'audience (Cloudflare Web Analytics, cf.
  // loadCloudflareAnalytics) — null tant qu'aucun choix n'a été fait
  // (bandeau affiché), 'granted'/'denied' une fois décidé. Le script n'est
  // jamais chargé sans un 'granted' explicite, cf. index.html qui ne le
  // référence plus du tout statiquement.
  var ANALYTICS_CONSENT_KEY = 'rohy-analytics-consent';
  function loadAnalyticsConsent() {
    try { return localStorage.getItem(ANALYTICS_CONSENT_KEY); } catch (err) { return null; }
  }
  function saveAnalyticsConsent(value) {
    try { localStorage.setItem(ANALYTICS_CONSENT_KEY, value); } catch (err) { /* mode privé / quota */ }
  }

  // Position dans l'app (écran courant, groupe/personne sélectionnés) —
  // sessionStorage, pas localStorage : survit à un rechargement du même
  // onglet (corrige "je recharge sur Groupes et je retombe sur la landing"),
  // mais reste vide dans un tout nouvel onglet, ce qui préserve le choix
  // délibéré d'afficher la landing en premier sur une toute nouvelle visite
  // (cf. enteredApp dans defaultState). Effacée explicitement à la
  // déconnexion (cf. onAuthStateChange) pour ne jamais faire réapparaître
  // l'écran d'un compte après connexion à un autre dans le même onglet.
  var NAV_STATE_KEY = 'rohy-nav-state';
  function saveNavState(s) {
    try {
      sessionStorage.setItem(NAV_STATE_KEY, JSON.stringify({
        enteredApp: s.enteredApp, screen: s.screen, navStack: s.navStack,
        selectedGroupId: s.selectedGroupId, selectedPersonId: s.selectedPersonId,
      }));
    } catch (err) { /* mode privé / quota */ }
  }
  // Ne renvoie que si enteredApp est vrai : un lien d'invitation ou un
  // rechargement pendant l'écran de connexion n'ont pas de position d'app à
  // reprendre, autant laisser defaultState() décider normalement.
  function resumedNavPatch() {
    try {
      var raw = sessionStorage.getItem(NAV_STATE_KEY);
      var saved = raw ? JSON.parse(raw) : null;
      return (saved && saved.enteredApp) ? saved : {};
    } catch (err) { return {}; }
  }
  function clearNavState() {
    try { sessionStorage.removeItem(NAV_STATE_KEY); } catch (err) { /* mode privé / quota */ }
  }
  function loadCloudflareAnalytics() {
    if (document.querySelector('script[data-cf-beacon]')) return;
    var s = document.createElement('script');
    s.type = 'module';
    s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
    s.setAttribute('data-cf-beacon', '{"token": "1c8def4bafea4996849e0e7d5d0ea9f1"}');
    document.head.appendChild(s);
  }

  // Relance "Créer un compte" (cf. tryWithoutAccount) : une fois refermée,
  // ne doit plus jamais réapparaître sur cet appareil — persistée en local
  // plutôt qu'en mémoire, pour survivre à un rechargement de page.
  function loadUpgradeNudgeDismissed() {
    try { return localStorage.getItem(UPGRADE_NUDGE_DISMISSED_KEY) === '1'; } catch (err) { return false; }
  }
  function saveUpgradeNudgeDismissed() {
    try { localStorage.setItem(UPGRADE_NUDGE_DISMISSED_KEY, '1'); } catch (err) { /* mode privé / quota */ }
  }

  // Sollicitation d'avis post-règlement (cf. maybeShowFeedbackPrompt) : ne
  // doit pas revenir à chaque règlement, seulement de loin en loin — marqué
  // dès l'affichage (pas seulement à la réponse), pour ne pas relancer en
  // boucle quelqu'un qui ferme systématiquement la modale sans répondre.
  function loadFeedbackLastShown() {
    try { return parseInt(localStorage.getItem(FEEDBACK_LAST_SHOWN_KEY), 10) || 0; } catch (err) { return 0; }
  }
  function saveFeedbackLastShown() {
    try { localStorage.setItem(FEEDBACK_LAST_SHOWN_KEY, String(Date.now())); } catch (err) { /* mode privé / quota */ }
  }

  // Bannière "rappel reçu" sur l'accueil (cf. renderHome) : un rappel
  // ignoré ne doit plus jamais réapparaître, mais un NOUVEAU rappel (autre
  // id) doit bien s'afficher malgré un ignoré précédent — d'où une liste
  // d'ids plutôt qu'un simple booléen comme pour la relance de compte.
  function loadDismissedReminderIds() {
    try { return JSON.parse(localStorage.getItem(REMINDERS_DISMISSED_KEY) || '[]'); } catch (err) { return []; }
  }
  function saveDismissedReminderId(id) {
    try {
      var ids = loadDismissedReminderIds();
      if (ids.indexOf(id) === -1) ids.push(id);
      localStorage.setItem(REMINDERS_DISMISSED_KEY, JSON.stringify(ids.slice(-50)));
    } catch (err) { /* mode privé / quota */ }
  }

  // Lien d'invitation par groupe (?join=<token>, cf. "Partager le lien
  // d'invitation" dans le détail d'un groupe) : détecté dès le premier
  // rendu pour prendre le pas sur la landing/le formulaire de connexion,
  // quel que soit l'état de connexion (cf. renderJoinScreen).
  function getJoinTokenFromUrl() {
    try {
      return new URLSearchParams(window.location.search).get('join') || null;
    } catch (err) { return null; }
  }

  function defaultState() {
    return {
      // L'écran de lancement ne sert qu'à la transition vers l'appli (cf.
      // enterApp/tryWithoutAccount) ou vers la page de connexion/inscription
      // (cf. openLoginForm/ctaSignupFromAbout) — jamais à l'arrivée sur la
      // landing, qui doit s'afficher immédiatement, même si une session est
      // déjà persistée (la racine du site affiche toujours la landing en
      // premier, cf. enteredApp).
      showSplash: false,
      // Lien d'invitation ouvert (cf. renderJoinScreen) : joinPreview est
      // rempli par fetchJoinPreview() une fois le nom/la devise du groupe
      // connus ; joinToken repasse à null une fois la personne bien ajoutée
      // au groupe (cf. performJoin), pour ne jamais réafficher cet écran.
      joinToken: getJoinTokenFromUrl(),
      joinPreview: null,
      joinNameInput: '',
      joinSubmitting: false,
      joinError: null,
      isAnonymous: false,
      showUpgradeNudge: false,
      showShareLink: false,
      shareLinkGroupId: null,
      showUpgradeAccount: false,
      upgradeForm: { name: '', email: '', password: '' },
      upgradeError: null,
      upgradeSubmitting: false,
      showFeedback: false,
      feedbackContext: null,
      feedbackRating: 0,
      feedbackComment: '',
      feedbackError: null,
      feedbackSubmitting: false,
      // La racine du site (rohy-app.com) doit toujours montrer la landing en
      // premier, même pour un compte déjà connecté (nouvel onglet,
      // rechargement) — jamais directement l'app. `enterApp` (déclenché par
      // le CTA "Ouvrir l'app") est ce qui fait passer de la landing à
      // l'écran d'accueil réel une fois dans la session.
      enteredApp: false,
      screen: 'home',
      navStack: [],
      theme: loadTheme(),
      landingLang: loadLandingLang(),
      showLandingMobileMenu: false,
      analyticsConsent: loadAnalyticsConsent(),
      loggedIn: false,
      dataLoading: false,
      loginMode: 'password',
      loginForm: { email: '', password: '', name: '' },
      loginError: null,
      magicSent: false,
      resetSent: false,
      // false = page d'accueil (landing) avant connexion, true = formulaire de
      // connexion/inscription. La landing est la racine par défaut (comme
      // Notion) plutôt que le formulaire, atteint via le bouton "Connexion".
      showLoginForm: false,
      passwordRecovery: false,
      newPasswordForm: { password: '' },
      currentUserId: null,
      showAccount: false,
      showGroupMenu: false,
      showManageMembers: false,
      manageMembersGroupId: null,
      manageMembersSearchQuery: '',
      showConfirmDeleteGroup: false,
      confirmDeleteGroupId: null,
      showConfirmRemoveMember: false,
      confirmRemoveMemberGroupId: null,
      confirmRemoveMemberId: null,
      showConfirmLeaveGroup: false,
      confirmLeaveGroupId: null,
      showConfirmMergeGuest: false,
      confirmMergeGuestId: null,
      confirmMergeGuestEmail: '',
      mergingGuest: false,
      showConfirmDeleteAccount: false,
      deletingAccount: false,
      accountJustDeleted: false,
      showConfirmSwitchAccount: false,
      showEditProfile: false,
      editProfileName: '',
      editProfileError: null,
      editProfileSubmitting: false,
      selectedGroupId: null,
      selectedPersonId: null,
      groupUnitMode: 'foyer',
      homeGroupFilter: null,
      expensesGroupFilter: null,
      personGroupFilter: null,
      settleGroupId: null,
      people: [],
      groups: [],
      expenses: [],
      payments: [],
      reminders: [],
      toast: null,
      showAddExpense: false,
      showAddGroup: false,
      showSettle: false,
      showReminderConfirm: false,
      reminderPersonId: null,
      reminderGroupId: null,
      reminderEmailDraft: '',
      showAddMemberForm: false,
      addingMember: false,
      households: [],
      currencyRates: {},
      newHouseholdName: '',
      addMemberForm: { name: '', email: '', shareWeight: '1', guardianId: null, linkExistingId: null },
      form: { label: '', amount: '', groupId: null, paidBy: null, participantIds: [], overrides: {}, category: 'autre', splitMode: 'default', splitValues: {} },
      expensesSearchQuery: '',
      expensesPersonFilter: null,
      expensesCategoryFilter: null,
      expensesDatePreset: 'all',
      expensesDateFrom: '',
      expensesDateTo: '',
      expensesStatusFilter: null,
      expensesAmountMin: '',
      expensesAmountMax: '',
      showExpenseFilters: false,
      expensesFilterGroupSearch: '',
      expensesFilterPersonSearch: '',
      expensesSort: 'date_desc',
      lastActiveGroupId: null,
      groupForm: { name: '', currency: seed.CURRENCIES[0].code, invitees: [{ name: '', email: '', shareWeight: '1', linkExistingId: null }] },
      submittingGroup: false,
      settleForm: { from: null, to: null, amount: '', paymentMethod: '', paymentReference: '' },
      formError: null,
    };
  }

  // Reprend l'écran où on était avant un rechargement (cf. resumedNavPatch) —
  // no-op tant que rien n'a encore été enregistré (nouvel onglet, ou jamais
  // entré dans l'app), auquel cas la landing s'affiche normalement.
  var state = Object.assign({}, defaultState(), resumedNavPatch());
  var toastTimer = null;
  var inviteeNameDebounceTimer = null;
  var addMemberNameDebounceTimer = null;

  function setState(patch) {
    var partial = typeof patch === 'function' ? patch(state) : patch;
    state = Object.assign({}, state, partial);
    saveNavState(state);
    render();
  }

  // Comme setState, mais sans re-rendu : pour les champs texte, où rien
  // d'autre à l'écran ne dépend de la valeur frappe par frappe. Reconstruire
  // tout le DOM à chaque caractère saisi provoquait un flash visuel (la
  // transition CSS globale rejoue sur les nœuds recréés) et perturbait le
  // clavier virtuel sur mobile.
  function setStateSilent(patch) {
    var partial = typeof patch === 'function' ? patch(state) : patch;
    state = Object.assign({}, state, partial);
  }

  // ---------- Helpers métier (portés du prototype) ----------

  function person(id) { return calc.findPerson(state.people, id); }
  function group(id) { return state.groups.find(function (g) { return g.id === id; }); }
  // Devise par défaut utilisée pour les agrégats qui traversent plusieurs
  // groupes (accueil, toutes les dépenses, historique) : on considère qu'un
  // même compte n'utilise en pratique qu'une seule devise à la fois (cf.
  // README) — ces vues agrégées ne s'affichent d'ailleurs que si tous les
  // groupes du compte partagent la même devise (cf. groupsHaveSingleCurrency),
  // donc celle du premier groupe. Chaque groupe garde sa propre devise pour
  // son propre affichage. '€' ne sert que si le compte n'a encore aucun
  // groupe (aucun montant à afficher de toute façon).
  function defaultCurrency() { return state.groups.length ? state.groups[0].currency : null; }
  function currencyMeta(code) {
    var resolved = code || defaultCurrency();
    return seed.CURRENCIES.find(function (c) { return c.code === resolved; }) || null;
  }
  function currencySymbolFor(code) {
    var m = currencyMeta(code);
    return m ? m.symbol : '€';
  }
  function currencyDecimalsFor(code) {
    var m = currencyMeta(code);
    return m ? m.decimals : 2;
  }
  function fmt(n) { return fmtIn(n, null); }
  // Sépare les milliers (espace, convention française) et n'affiche des
  // décimales que si la devise les utilise couramment au quotidien (la
  // plupart des francs africains n'en ont pas, cf. scripts/data.js).
  function fmtIn(n, currencyCode) {
    var decimals = currencyDecimalsFor(currencyCode);
    var sign = n < 0 ? '-' : '';
    var v = Math.abs(n).toLocaleString('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    return sign + v + ' ' + currencySymbolFor(currencyCode);
  }
  // Montant d'une dépense pour l'affichage : montant converti dans la
  // devise du groupe, plus le montant d'origine entre parenthèses si la
  // dépense a été payée dans une devise différente (cf. migration 0019).
  function expenseAmountLabel(e, groupCurrency) {
    var main = escapeHtml(fmtIn(e.amount, groupCurrency));
    if (!e.originalCurrency) return main;
    return main + '<div class="expense-amount-original">' + escapeHtml(fmtIn(e.originalAmount, e.originalCurrency)) + '</div>';
  }
  // Marque Rohy (motif tissé) — géométrie fixe (10 rectangles arrondis sur
  // un viewBox 100x100), reprise telle quelle de la brand sheet. Fill/stroke
  // paramétrables pour couvrir les différents habillages (logo plein sur
  // fond neutre, etc.) sans dupliquer la liste de rectangles à chaque appel.
  var LOGO_RECTS = [
    [16, 0, 18, 100], [42, 0, 18, 100], [68, 0, 18, 100],
    [0, 13.5, 43.5, 18], [58, 13.5, 42, 18],
    [0, 40, 17, 18], [32, 40, 37, 18], [85, 40, 15, 18],
    [0, 65, 43.5, 18], [58, 65, 42, 18],
  ];
  function logoMark(size, fill, stroke) {
    var rects = LOGO_RECTS.map(function (r) {
      return '<rect x="' + r[0] + '" y="' + r[1] + '" width="' + r[2] + '" height="' + r[3] + '" rx="3" fill="' + fill + '" stroke="' + stroke + '" stroke-width="3" stroke-linecap="square" />';
    }).join('');
    // xmlns : indifférent en usage inline (innerHTML), mais indispensable
    // pour rasteriser ce SVG en image autonome (cf. logoPngDataUrl, utilisé
    // par les exports Excel/PDF) — sans lui, un SVG chargé seul via <img>
    // ou new Image() ne se décode pas.
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="' + size + '" height="' + size + '" aria-hidden="true">' + rects + '</svg>';
  }
  // Variante "multicolore" de la marque (une couleur par rectangle, reprise
  // telle quelle de la brand sheet) — réservée à la page d'accueil, plus
  // marquante que la version pleine couleur unique utilisée ailleurs.
  var LOGO_MULTI_COLORS = [
    ['#C9A159', '#96793A'], ['#7B3F98', '#5A2C71'], ['#C9A159', '#96793A'],
    ['#D6247A', '#96195A'], ['#D6247A', '#96195A'],
    ['#0F8F6B', '#0A6B50'], ['#0F8F6B', '#0A6B50'], ['#0F8F6B', '#0A6B50'],
    ['#D6247A', '#96195A'], ['#D6247A', '#96195A'],
  ];
  function logoMarkMulti(size) {
    var rects = LOGO_RECTS.map(function (r, i) {
      var c = LOGO_MULTI_COLORS[i];
      return '<rect x="' + r[0] + '" y="' + r[1] + '" width="' + r[2] + '" height="' + r[3] + '" rx="3" fill="' + c[0] + '" stroke="' + c[1] + '" stroke-width="3" stroke-linecap="square" />';
    }).join('');
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="' + size + '" height="' + size + '" aria-hidden="true">' + rects + '</svg>';
  }
  // Rasterise la marque (fond transparent, teinte pleine) en PNG pour les
  // usages où une image bitmap est nécessaire — jsPDF (doc.addImage) et
  // ExcelJS (workbook.addImage) ne savent pas dessiner un SVG directement.
  function logoPngDataUrl(size) {
    var svg = logoMark(size, '#0F8F6B', '#084b38');
    var url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        canvas.getContext('2d').drawImage(img, 0, 0, size, size);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = function (err) { URL.revokeObjectURL(url); reject(err); };
      img.src = url;
    });
  }
  function initials(name) { return name.slice(0, 2).toUpperCase(); }
  function colorForBalance(n) { return calc.colorForBalance(n); }
  function hasCustomWeight(p) { return p.shareWeight != null && Math.abs(p.shareWeight - 1) > 0.001; }
  function shareBadge(p, inline) {
    if (!hasCustomWeight(p)) return '';
    return '<span class="badge-child' + (inline ? ' inline' : '') + '">Coef. ' + String(p.shareWeight).replace('.', ',') + '</span>';
  }

  function computeDebts() { return calc.computeDebts(state.people, state.expenses, state.payments); }
  function computeDebtsForGroup(groupId) { return calc.computeDebtsForGroup(state.people, state.expenses, state.payments, groupId); }
  function netBalanceFor(personId, groupIdFilter) {
    var debts = groupIdFilter ? computeDebtsForGroup(groupIdFilter) : computeDebts();
    return calc.netBalanceFor(personId, debts);
  }
  function pairNet(a, b, debts) { return calc.pairNet(a, b, debts || computeDebts()); }

  // ---------- Export (CSV / Excel / PDF) ----------

  function slugify(str) {
    return (str || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'groupe';
  }
  function csvEscape(v) {
    var s = v == null ? '' : String(v);
    return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(rows) { return rows.map(function (r) { return r.map(csvEscape).join(';'); }).join('\r\n'); }
  function downloadBlob(filename, content, mime) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    // target="_blank" : filet de sécurité pour Safari iOS, qui ignore parfois
    // l'attribut download selon le type de fichier et navigue à la place —
    // sans ce filet, ce serait vers la même fenêtre (perte de l'état de
    // l'app en cours) plutôt qu'un nouvel onglet, d'où l'on peut quand même
    // enregistrer le fichier via "Partager".
    a.href = url; a.download = filename; a.target = '_blank'; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  // Rassemble les données d'export d'un groupe : dépenses détaillées, soldes
  // nets par personne et transactions à effectuer pour équilibrer (même
  // logique que "pour équilibrer" affiché sur la fiche groupe). Montants en
  // valeurs numériques brutes (pas de symbole) — chaque tableau exporté
  // partage la même devise, mentionnée dans les en-têtes.
  function buildGroupExportTables(groupId) {
    var g = group(groupId);
    if (!g) return null;
    var expenses = state.expenses.filter(function (e) { return e.groupId === groupId; })
      .slice().sort(function (a, b) { return a.date.localeCompare(b.date); });
    var payments = state.payments.filter(function (p) { return p.groupId === groupId; });
    var statuses = calc.computeExpenseStatuses(state.people, expenses, payments);

    var expenseRows = expenses.map(function (e) {
      var cat = seed.EXPENSE_CATEGORIES.find(function (c) { return c.id === categoryForIcon(e.icon); });
      var st = statuses[e.id];
      return [
        fmtDate(e.date), e.label, cat ? cat.label : 'Autre', e.amount,
        e.originalCurrency ? (e.originalAmount + ' ' + e.originalCurrency + ' (taux ' + e.exchangeRate + ')') : '',
        person(e.paidBy).name,
        e.participants.map(function (pid) { return person(pid).name; }).join(', '),
        st ? st.status : '',
      ];
    });

    var debts = computeDebtsForGroup(groupId);
    var balanceRows = g.memberIds.map(function (pid) { return [person(pid).name, netBalanceFor(pid, groupId)]; });
    var settlementRows = calc.simplify(debts, g.memberIds).map(function (t) {
      return [person(t.from).name, person(t.to).name, t.amount];
    });

    return {
      group: g,
      expenses: { header: ['Date', 'Libellé', 'Catégorie', 'Montant (' + g.currency + ')', 'Devise d\'origine', 'Payé par', 'Participants', 'Statut'], rows: expenseRows },
      balances: { header: ['Personne', 'Solde net (' + g.currency + ')'], rows: balanceRows },
      settlements: { header: ['De', 'Vers', 'Montant (' + g.currency + ')'], rows: settlementRows },
    };
  }

  // Portabilité des données personnelles (RGPD, cf. politique de
  // confidentialité) — distinct de l'export d'un groupe (buildGroupExportTables,
  // ci-dessous) : ici, un seul fichier avec tout ce qui concerne
  // spécifiquement la personne connectée, tous groupes confondus, plutôt
  // qu'un grand livre partagé d'un groupe donné. JSON (structuré, lisible
  // par machine) plutôt que CSV/Excel/PDF : la forme attendue par le RGPD
  // pour un export "brut", pas un document de présentation.
  function exportMyData() {
    var me = person(state.currentUserId);
    if (!me) return;
    var myGroups = state.groups.filter(function (g) { return g.memberIds.indexOf(me.id) !== -1; });
    var myGroupIds = myGroups.map(function (g) { return g.id; });
    var data = {
      exportedAt: new Date().toISOString(),
      profile: { id: me.id, name: me.name, email: me.email || null, color: me.color, shareWeight: me.shareWeight },
      groups: myGroups.map(function (g) {
        return { id: g.id, name: g.name, currency: g.currency, role: g.adminId === me.id ? 'admin' : 'membre' };
      }),
      expenses: state.expenses.filter(function (e) {
        return myGroupIds.indexOf(e.groupId) !== -1 && (e.paidBy === me.id || e.participants.indexOf(me.id) !== -1);
      }).map(function (e) {
        return {
          id: e.id, groupId: e.groupId, label: e.label, amount: e.amount, date: e.date,
          paidByMe: e.paidBy === me.id, participant: e.participants.indexOf(me.id) !== -1,
          originalCurrency: e.originalCurrency || null, originalAmount: e.originalAmount || null,
        };
      }),
      payments: state.payments.filter(function (p) {
        return p.from === me.id || p.to === me.id;
      }).map(function (p) {
        return { id: p.id, groupId: p.groupId, amount: p.amount, date: p.date, direction: p.from === me.id ? 'envoyé' : 'reçu' };
      }),
      reminders: state.reminders.filter(function (r) {
        return r.fromPersonId === me.id || r.toPersonId === me.id;
      }).map(function (r) {
        return { id: r.id, groupId: r.groupId || null, amount: r.amount, date: r.date, direction: r.fromPersonId === me.id ? 'envoyé' : 'reçu' };
      }),
    };
    downloadBlob('rohy-mes-donnees-' + slugify(me.name) + '.json', JSON.stringify(data, null, 2), 'application/json;charset=utf-8');
    showToast('Données téléchargées');
  }

  function exportGroupCsv(groupId) {
    var d = buildGroupExportTables(groupId);
    if (!d) return;
    setState({ showGroupMenu: false });
    var lines = [['Dépenses'], d.expenses.header].concat(d.expenses.rows, [
      [], ['Soldes par personne'], d.balances.header,
    ], d.balances.rows, [
      [], ['Transactions à effectuer'], d.settlements.header,
    ], d.settlements.rows);
    downloadBlob('rohy-' + slugify(d.group.name) + '.csv', '﻿' + toCsv(lines), 'text/csv;charset=utf-8');
    showToast('Export CSV téléchargé');
  }

  // En-tête de marque partagé par chaque feuille du classeur : logo (image
  // intégrée, pas juste du texte) + "Rohy" en rose + sous-titre, puis une
  // ligne d'en-tête de tableau colorée (fond rose, texte blanc) et un
  // ombrage alterné très léger sur les lignes — cohérent avec le PDF et le
  // reste de l'app plutôt qu'un tableau brut sans habillage.
  function addBrandedSheet(wb, logoImageId, sheetName, subtitle, header, rows, amountCols) {
    var ws = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 3 }] });
    ws.addImage(logoImageId, { tl: { col: 0.15, row: 0.15 }, ext: { width: 26, height: 26 } });
    ws.mergeCells(1, 2, 1, Math.max(3, header.length));
    ws.getCell(1, 2).value = 'Rohy';
    ws.getCell(1, 2).font = { name: 'Calibri', size: 15, bold: true, color: { argb: 'FF0F8F6B' } };
    ws.mergeCells(2, 2, 2, Math.max(3, header.length));
    ws.getCell(2, 2).value = subtitle;
    ws.getCell(2, 2).font = { name: 'Calibri', size: 10.5, color: { argb: 'FF55575F' } };
    ws.getRow(1).height = 20;
    ws.getRow(2).height = 16;

    var headerRow = ws.getRow(3);
    header.forEach(function (h, i) {
      var cell = headerRow.getCell(i + 1);
      cell.value = h;
      cell.font = { name: 'Calibri', bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F8F6B' } };
      cell.alignment = { vertical: 'middle' };
    });
    headerRow.height = 20;

    rows.forEach(function (r, ri) {
      var row = ws.getRow(4 + ri);
      r.forEach(function (v, ci) {
        var cell = row.getCell(ci + 1);
        cell.value = v;
        cell.font = { name: 'Calibri' };
        if (amountCols.indexOf(ci) !== -1) cell.numFmt = '#,##0.00';
        if (ri % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFBF6E9' } };
      });
    });

    header.forEach(function (h, i) {
      ws.getColumn(i + 1).width = Math.max(14, h.length + 6);
    });
  }

  function exportGroupExcel(groupId) {
    setState({ showGroupMenu: false });
    if (typeof ExcelJS === 'undefined') { showToast('Erreur : bibliothèque Excel indisponible (hors ligne ?).'); return; }
    var d = buildGroupExportTables(groupId);
    if (!d) return;
    logoPngDataUrl(64).then(function (logoPng) {
      var wb = new ExcelJS.Workbook();
      wb.creator = 'Rohy';
      var logoImageId = wb.addImage({ base64: logoPng, extension: 'png' });
      addBrandedSheet(wb, logoImageId, 'Dépenses', d.group.name, d.expenses.header, d.expenses.rows, [3]);
      addBrandedSheet(wb, logoImageId, 'Soldes', d.group.name + ' — soldes par personne', d.balances.header, d.balances.rows, [1]);
      addBrandedSheet(wb, logoImageId, 'Transactions', d.group.name + ' — transactions à effectuer', d.settlements.header, d.settlements.rows, [2]);
      return wb.xlsx.writeBuffer();
    }).then(function (buffer) {
      downloadBlob('rohy-' + slugify(d.group.name) + '.xlsx', buffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      showToast('Export Excel téléchargé');
    }).catch(function () {
      showToast('Erreur : échec de la génération du fichier Excel.');
    });
  }

  function exportGroupPdf(groupId) {
    setState({ showGroupMenu: false });
    if (typeof jspdf === 'undefined') { showToast('Erreur : bibliothèque PDF indisponible (hors ligne ?).'); return; }
    var d = buildGroupExportTables(groupId);
    if (!d) return;
    // Le séparateur de milliers de toLocaleString('fr-FR') est une espace
    // fine insécable (U+202F) — absente de la police Helvetica intégrée à
    // jsPDF, qui affiche alors un glyphe de remplacement (un "/") à sa place.
    // On la remplace par une espace normale, uniquement pour ce rendu PDF.
    var pdfAmount = function (v) { return fmtIn(v, d.group.currency).replace(/[  ]/g, ' '); };
    var fmtRows = function (rows, amountCols) {
      return rows.map(function (r) {
        return r.map(function (v, i) { return amountCols.indexOf(i) !== -1 ? pdfAmount(v) : v; });
      });
    };
    // Couleurs de marque (rose primaire + fond crème pour les lignes
    // alternées) reprises telles quelles des tokens CSS --brand-primary /
    // --surface-canvas (thème clair) — jsPDF ne sait pas lire les variables
    // CSS, donc dupliquées ici en RGB.
    var brandHeadStyles = { fillColor: [15, 143, 107], textColor: [255, 255, 255], fontStyle: 'bold' };
    var brandAltRow = { fillColor: [251, 246, 233] };

    logoPngDataUrl(96).then(function (logoPng) {
      var doc = new jspdf.jsPDF();
      doc.addImage(logoPng, 'PNG', 14, 10, 12, 12);
      doc.setFontSize(16);
      doc.setTextColor(15, 143, 107);
      doc.text('Rohy', 30, 19);
      doc.setFontSize(11);
      doc.setTextColor(20, 22, 27);
      // x:14 (marge de gauche, comme le reste du document) et non plus 30
      // (aligné sur le wordmark) — place le nom du groupe sous le logo, pas
      // à côté du mot "Rohy".
      doc.text(d.group.name, 14, 25);
      doc.setDrawColor(15, 143, 107);
      doc.setLineWidth(0.5);
      doc.line(14, 28, 196, 28);

      doc.setFontSize(11);
      doc.text('Dépenses', 14, 36);
      doc.autoTable({ startY: 39, head: [d.expenses.header], body: fmtRows(d.expenses.rows, [3]), styles: { fontSize: 8 }, headStyles: brandHeadStyles, alternateRowStyles: brandAltRow });
      var y1 = doc.lastAutoTable.finalY + 10;
      doc.text('Soldes par personne', 14, y1);
      doc.autoTable({ startY: y1 + 3, head: [d.balances.header], body: fmtRows(d.balances.rows, [1]), styles: { fontSize: 8 }, headStyles: brandHeadStyles, alternateRowStyles: brandAltRow });
      var y2 = doc.lastAutoTable.finalY + 10;
      doc.text('Transactions à effectuer', 14, y2);
      doc.autoTable({
        startY: y2 + 3, head: [d.settlements.header],
        body: d.settlements.rows.length ? fmtRows(d.settlements.rows, [2]) : [['—', '—', 'Rien à régler']],
        styles: { fontSize: 8 }, headStyles: brandHeadStyles, alternateRowStyles: brandAltRow,
      });
      doc.save('rohy-' + slugify(d.group.name) + '.pdf');
      showToast('Export PDF téléchargé');
    }).catch(function () {
      showToast('Erreur : échec de la génération du PDF.');
    });
  }

  function showToast(msg) {
    clearTimeout(toastTimer);
    setState({ toast: msg });
    // Les messages d'erreur restent affichés plus longtemps : un toast de
    // 2,6s qui disparaît tout seul est facile à manquer, notamment pour un
    // échec d'invitation qu'on ne remarque qu'en constatant après coup
    // qu'un membre n'a pas été ajouté.
    var duration = /^erreur/i.test(msg) ? 6500 : 2600;
    toastTimer = setTimeout(function () {
      setState(function (s) { return s.toast === msg ? { toast: null } : {}; });
    }, duration);
  }

  function firstErrorOf(results) {
    for (var i = 0; i < results.length; i++) {
      if (results[i].error) return results[i].error;
    }
    return null;
  }

  // ---------- Chargement des données (Supabase) ----------

  function loadAppData() {
    setStateSilent({ dataLoading: true });
    render();
    return Promise.all([
      sb.from('profiles').select('*'),
      sb.from('groups').select('*'),
      sb.from('group_members').select('*'),
      sb.from('expenses').select('*'),
      sb.from('expense_participants').select('*'),
      sb.from('payments').select('*'),
      sb.from('reminders').select('*'),
      sb.from('households').select('*'),
      sb.from('group_currency_rates').select('*'),
    ]).then(function (results) {
      var err = firstErrorOf(results);
      if (err) throw err;
      var profileRows = results[0].data, groupRows = results[1].data, memberRows = results[2].data,
        expenseRows = results[3].data, participantRows = results[4].data, paymentRows = results[5].data,
        reminderRows = results[6].data, householdRows = results[7].data, currencyRateRows = results[8].data;

      var people = profileRows.map(function (p) {
        return {
          id: p.id, name: p.name, color: p.color, shareWeight: p.share_weight,
          guardianId: p.guardian_id || undefined,
          householdId: p.household_id || undefined,
          createdBy: p.created_by || undefined,
          hasAccount: !!p.auth_user_id,
          email: p.email || undefined,
        };
      });
      var households = householdRows.map(function (h) {
        return { id: h.id, name: h.name, color: h.color, createdBy: h.created_by, groupId: h.group_id };
      });
      var groups = groupRows.map(function (g) {
        return {
          id: g.id, name: g.name, icon: g.icon, currency: g.currency, adminId: g.admin_id,
          shareToken: g.share_token || null,
          freezeCurrencyRates: !!g.freeze_currency_rates,
          memberIds: memberRows.filter(function (m) { return m.group_id === g.id; }).map(function (m) { return m.user_id; }),
        };
      });
      var currencyRates = {};
      currencyRateRows.forEach(function (r) {
        if (!currencyRates[r.group_id]) currencyRates[r.group_id] = {};
        currencyRates[r.group_id][r.currency] = Number(r.rate);
      });
      var expenses = expenseRows.map(function (e) {
        var parts = participantRows.filter(function (p) { return p.expense_id === e.id; });
        var overrides = {};
        var splitValues = {};
        parts.forEach(function (p) {
          if (p.override_responsible_id) overrides[p.user_id] = p.override_responsible_id;
          if (p.split_value != null) splitValues[p.user_id] = Number(p.split_value);
        });
        return {
          id: e.id, groupId: e.group_id, label: e.label, icon: e.icon, amount: Number(e.amount),
          paidExternal: e.paid_external != null ? Number(e.paid_external) : null,
          paidBy: e.paid_by, date: e.expense_date, participants: parts.map(function (p) { return p.user_id; }), overrides: overrides,
          splitMode: e.split_mode || 'default', splitValues: splitValues,
          receiptPath: e.receipt_path || null,
          originalCurrency: e.original_currency || null,
          originalAmount: e.original_amount != null ? Number(e.original_amount) : null,
          exchangeRate: e.exchange_rate != null ? Number(e.exchange_rate) : null,
        };
      });
      var payments = paymentRows.map(function (p) {
        return {
          id: p.id, from: p.from_user, to: p.to_user, amount: Number(p.amount), date: p.payment_date, groupId: p.group_id,
          paymentMethod: p.payment_method || null, paymentReference: p.payment_reference || null,
        };
      });
      var reminders = reminderRows.map(function (r) {
        return { id: r.id, fromPersonId: r.from_user, toPersonId: r.to_user, amount: Number(r.amount), date: r.reminder_date, message: r.message, groupId: r.group_id || undefined };
      });

      setState({ people: people, groups: groups, expenses: expenses, payments: payments, reminders: reminders, households: households, currencyRates: currencyRates, dataLoading: false });
    }).catch(function (err) {
      setState({ dataLoading: false });
      showToast('Erreur de chargement : ' + (err && err.message ? err.message : 'inconnue'));
    });
  }

  // ---------- Navigation ----------
  function navigate(screen, extra) {
    setState(function (s) {
      return Object.assign({}, extra, { screen: screen, navStack: s.navStack.concat([s.screen]) });
    });
  }
  function goBack() {
    setState(function (s) {
      var stack = s.navStack.slice();
      var prev = stack.pop() || 'home';
      return { screen: prev, navStack: stack };
    });
  }
  function goHome() { setState({ screen: 'home', navStack: [] }); }
  function goGroups() { setState({ screen: 'groups', navStack: [] }); }
  function goHistory() { setState({ screen: 'history', navStack: [] }); }
  function goExpenses() { setState({ screen: 'expenses', navStack: [] }); }
  // Depuis la fiche groupe (cf. renderGroupDetail, carte "Total des
  // dépenses") : direction Dépenses déjà filtré sur ce groupe, plutôt que la
  // vue agrégée — cohérent avec ce qu'on vient de regarder. setState direct
  // (comme goExpenses ci-dessus), pas navigate() : "Dépenses" est un onglet
  // racine de la nav du bas, jamais de flèche "retour" dessus (cf. showBack
  // dans renderTopBar), donc empiler sur navStack n'aurait aucun effet visible.
  function goExpensesForGroup(groupId) { setState({ screen: 'expenses', navStack: [], expensesGroupFilter: groupId || null }); }
  function openGroup(id) { navigate('groupDetail', { selectedGroupId: id, lastActiveGroupId: id }); }
  // Depuis Dépenses (cf. renderAllExpenses) : si un filtre par groupe est
  // actif, sa fiche a déjà sa propre section "Pour équilibrer" — sinon,
  // direction l'accueil pour la vue agrégée tous groupes confondus.
  function goSettleFromExpenses(groupId) { if (groupId) { openGroup(groupId); } else { goHome(); } }
  function openPerson(id) { navigate('person', { selectedPersonId: id, personGroupFilter: state.homeGroupFilter }); }
  function openAbout() { navigate('about', { showAccount: false }); }
  // Même distinction qu'openAbout ci-dessus, mais accessible aussi AVANT
  // connexion (lien "Confidentialité" du pied de page de la landing) : dans
  // ce cas navigate() ne suffit pas (render() ignore state.screen tant que
  // !enteredApp, cf. plus bas) — on bascule directement l'écran, que
  // render() intercepte en priorité pour cet état précis.
  function openPrivacy() {
    // Sans ce garde, cliquer sur "En savoir plus" (bandeau de consentement)
    // alors qu'on est déjà sur cette page (rouverte via "Modifier mes
    // préférences", par exemple) empilait une entrée de navigation
    // redondante sans rien changer à l'écran — un clic qui semblait "ne
    // mener nulle part" alors qu'on y était déjà.
    if (state.screen === 'privacy') return;
    if (state.loggedIn && state.enteredApp) { navigate('privacy', { showAccount: false }); }
    else { setState({ screen: 'privacy' }); }
  }
  function closePrivacyScreen() {
    if (state.loggedIn && state.enteredApp) { goBack(); }
    else { setState({ screen: 'home' }); }
  }
  // Avant connexion, `render()` affiche la landing ou renderLogin() selon
  // `state.showLoginForm`, quel que soit `state.screen` (cf. plus bas) :
  // `navigate('about', ...)` ne suffit donc pas depuis cette zone — état
  // dédié à la place.
  function openLoginForm() { setState({ showLoginForm: true, showSplash: true }); armSplashTimeout(); }
  function goToLanding() { setState({ showLoginForm: false }); }
  function ctaSignupFromAbout() { setState({ showLoginForm: true, loginMode: 'signup', loginError: null, showSplash: true }); armSplashTimeout(); }
  // Bascule de la landing (racine du site, cf. `enteredApp` dans
  // defaultState) vers l'app pour un compte déjà connecté — même moment de
  // transition qu'un vrai lancement d'appli, donc même écran de lancement.
  function enterApp() { setState({ enteredApp: true, showSplash: true }); armSplashTimeout(); }
  // Symétrique d'enterApp : clic sur le logo depuis l'intérieur de l'app —
  // repasse par la landing (session conservée, juste enteredApp à false)
  // plutôt que de déconnecter ; "Ouvrir l'app" y ramène directement.
  function exitToLanding() { setState({ enteredApp: false, screen: 'home', navStack: [] }); }

  // Symétrique du lien d'invitation (cf. plus bas) : jusqu'ici, seul
  // l'invité pouvait rejoindre un groupe sans compte — l'organisateur devait
  // toujours créer un vrai compte pour commencer. Compte anonyme + ouverture
  // immédiate de "Nouveau groupe" : zéro friction pour essayer, au prix d'un
  // vrai risque (perdre la session anonyme = perdre l'accès admin à ce
  // groupe, personne d'autre ne peut le récupérer) — compensé par la
  // relance "Créer un compte" après la première dépense, cf.
  // maybeShowUpgradeNudge dans submitExpense.
  function tryWithoutAccount() {
    sb.auth.signInAnonymously().then(function (res) {
      if (res.error) { showToast('Erreur : ' + res.error.message); return; }
      setState({ enteredApp: true, showSplash: true, showAddGroup: true });
      armSplashTimeout();
    }).catch(function () {
      showToast('Erreur réseau — réessaie.');
    });
  }

  // ---------- Lien d'invitation par groupe (cf. renderJoinScreen) ----------
  function setJoinNameInput(v) { setStateSilent({ joinNameInput: v, joinError: null }); }

  // Récupère nom/devise/nombre de membres du groupe désigné par le jeton
  // (Edge Function join-group, action "preview") — ne rejoint pas encore,
  // sert juste à afficher "Vous rejoignez tel groupe" avant confirmation.
  function fetchJoinPreview() {
    var token = state.joinToken;
    if (!token) return;
    sb.functions.invoke('join-group', { body: { token: token, action: 'preview' } }).then(function (res) {
      extractFunctionErrorMessage(res).then(function (errMsg) {
        if (errMsg) { setState({ joinPreview: { error: errMsg } }); return; }
        var d = res.data || {};
        setState({ joinPreview: { groupName: d.groupName, currency: d.currency, memberCount: d.memberCount || 0 } });
      });
    }).catch(function () {
      setState({ joinPreview: { error: 'Erreur réseau — réessaie.' } });
    });
  }

  function performJoin() {
    var token = state.joinToken;
    if (!token) return;
    var name = (state.joinNameInput || '').trim();
    if (!state.loggedIn && !name) { setState({ joinError: 'Entre ton prénom.' }); return; }
    setState({ joinSubmitting: true, joinError: null });
    // Déjà connecté (compte réel ou anonyme d'une session précédente) : pas
    // besoin de (re)créer une session, on rejoint directement avec celle-ci.
    // Sinon, une session anonyme est créée à la volée — jamais de mot de
    // passe pour un simple accès par lien.
    var authStep = state.loggedIn ? Promise.resolve() : sb.auth.signInAnonymously().then(function (res) {
      if (res.error) return Promise.reject(res.error);
    });
    authStep.then(function () {
      return sb.functions.invoke('join-group', { body: { token: token, action: 'join', name: name } });
    }).then(function (res) {
      return extractFunctionErrorMessage(res).then(function (errMsg) {
        if (errMsg) throw new Error(errMsg);
        var d = res.data || {};
        setState({
          joinToken: null, joinSubmitting: false, joinPreview: null, joinNameInput: '',
          enteredApp: true, screen: 'groupDetail', navStack: [], selectedGroupId: d.groupId,
        });
        // Retire ?join=... de l'URL : un rechargement ne doit pas rouvrir cet écran.
        try { window.history.replaceState({}, '', window.location.pathname); } catch (err) { /* ignore */ }
        loadAppData();
      });
    }).catch(function (err) {
      setState({ joinSubmitting: false, joinError: (err && err.message) || 'Erreur réseau.' });
    });
  }

  function cancelJoin() {
    setState({ joinToken: null, joinPreview: null, joinError: null, joinNameInput: '' });
    try { window.history.replaceState({}, '', window.location.pathname); } catch (err) { /* ignore */ }
  }
  function setHomeGroupFilter(id) { setState({ homeGroupFilter: id || null }); }
  // Change de groupe réinitialise les filtres membre/catégorie (cascade
  // parent → enfant classique) : sans ça, un filtre membre resté actif mais
  // absent du nouveau groupe rendait la liste vide sans qu'aucune pastille
  // active ne l'explique à l'écran.
  function setExpensesGroupFilter(id) { setState({ expensesGroupFilter: id || null, expensesPersonFilter: null, expensesCategoryFilter: null }); }
  function setExpensesSearch(v) { setState({ expensesSearchQuery: v }); }
  function setExpensesPersonFilter(id) { setState({ expensesPersonFilter: id || null }); }
  function setExpensesCategoryFilter(id) { setState({ expensesCategoryFilter: id || null }); }
  function setExpensesSort(v) { setState({ expensesSort: v }); }
  function toggleExpenseFilters() { setState(function (s) { return { showExpenseFilters: !s.showExpenseFilters }; }); }
  function setExpensesDatePreset(v) { setState({ expensesDatePreset: v || 'all', expensesDateFrom: '', expensesDateTo: '' }); }
  function setExpensesDateFrom(v) { setState({ expensesDatePreset: 'custom', expensesDateFrom: v }); }
  function setExpensesDateTo(v) { setState({ expensesDatePreset: 'custom', expensesDateTo: v }); }
  function setExpensesStatusFilter(v) { setState({ expensesStatusFilter: v || null }); }
  function setExpensesAmountMin(v) { setState({ expensesAmountMin: v }); }
  function setExpensesAmountMax(v) { setState({ expensesAmountMax: v }); }
  function setExpensesFilterGroupSearch(v) { setState({ expensesFilterGroupSearch: v }); }
  function setExpensesFilterPersonSearch(v) { setState({ expensesFilterPersonSearch: v }); }
  // Un seul bouton "Réinitialiser" pour toutes les dimensions de filtre de
  // l'écran Dépenses (hors recherche texte et tri, qui ne sont pas des
  // filtres au sens propre — cf. proposition UX : trier ≠ filtrer).
  function resetExpenseFilters() {
    setState({
      expensesGroupFilter: null, expensesPersonFilter: null, expensesCategoryFilter: null,
      expensesDatePreset: 'all', expensesDateFrom: '', expensesDateTo: '',
      expensesStatusFilter: null, expensesAmountMin: '', expensesAmountMax: '',
    });
  }
  // Retire une seule puce de filtre actif (ligne de résumé au-dessus de la
  // liste), sans toucher aux autres dimensions actives.
  function removeExpenseFilterChip(key) {
    if (key === 'group') setExpensesGroupFilter(null);
    else if (key === 'person') setExpensesPersonFilter(null);
    else if (key === 'category') setExpensesCategoryFilter(null);
    else if (key === 'date') setExpensesDatePreset('all');
    else if (key === 'status') setExpensesStatusFilter(null);
    else if (key === 'amount') setState({ expensesAmountMin: '', expensesAmountMax: '' });
  }
  function setPersonGroupFilter(id) { setState({ personGroupFilter: id || null }); }
  function toggleTheme() {
    setState(function (s) {
      var next = s.theme === 'dark' ? 'light' : 'dark';
      saveTheme(next);
      return { theme: next };
    });
  }
  function acceptAnalytics() {
    saveAnalyticsConsent('granted');
    setState({ analyticsConsent: 'granted' });
    loadCloudflareAnalytics();
  }
  function declineAnalytics() {
    saveAnalyticsConsent('denied');
    setState({ analyticsConsent: 'denied' });
  }
  // Rouvre le bandeau pour revenir sur un choix déjà fait (cf. lien "Gérer
  // mes préférences" dans la politique de confidentialité) — ne réinitialise
  // pas le stockage tant que la personne n'a pas re-choisi explicitement.
  function reopenAnalyticsChoice() { setState({ analyticsConsent: null }); }

  // Bascule FR/EN de la landing (cf. LANDING_I18N) — persistée comme le
  // thème, pour rester dans la langue choisie d'une visite à l'autre.
  function toggleLandingLang() {
    setState(function (s) {
      var next = s.landingLang === 'en' ? 'fr' : 'en';
      saveLandingLang(next);
      return { landingLang: next };
    });
  }

  // Menu ☰ de la nav mobile de la landing (cf. renderAboutFromLogin) : ne
  // regroupe que "Connexion" — le CTA principal reste seul et fixe dans la
  // barre (façon notion.com), le sélecteur de langue vit dans le pied de
  // page plutôt qu'ici, pour ne pas reproduire l'encombrement d'origine.
  function toggleLandingMobileMenu() { setState(function (s) { return { showLandingMobileMenu: !s.showLandingMobileMenu }; }); }
  function closeLandingMobileMenu() { setState({ showLandingMobileMenu: false }); }

  // ---------- Auth ----------
  function toggleLoginMode() { setState(function (s) { return { loginMode: s.loginMode === 'password' ? 'magic' : 'password', loginError: null, magicSent: false }; }); }
  function showSignup() { setState({ loginMode: 'signup', loginError: null }); }
  function showPasswordLogin() { setState({ loginMode: 'password', loginError: null }); }
  function showForgotPassword() { setState({ loginMode: 'forgotPassword', loginError: null, resetSent: false }); }
  function backToLoginForm() { setState({ magicSent: false, loginError: null }); }
  function setLoginEmail(v) { setStateSilent(function (s) { return { loginForm: Object.assign({}, s.loginForm, { email: v }), loginError: null }; }); }
  function setLoginPassword(v) { setStateSilent(function (s) { return { loginForm: Object.assign({}, s.loginForm, { password: v }), loginError: null }; }); }
  function setLoginName(v) { setStateSilent(function (s) { return { loginForm: Object.assign({}, s.loginForm, { name: v }), loginError: null }; }); }
  function setNewPassword(v) { setStateSilent(function (s) { return { newPasswordForm: Object.assign({}, s.newPasswordForm, { password: v }), loginError: null }; }); }

  function submitLogin() {
    var f = state.loginForm;
    if (!f.email.trim() || f.email.indexOf('@') === -1) { setState({ loginError: 'Entre un e-mail valide.' }); return; }
    // Ici on vérifie un mot de passe déjà choisi (pas de règle à faire
    // respecter, juste éviter un envoi vide) — Supabase renvoie de toute
    // façon "e-mail ou mot de passe incorrect" si la valeur ne correspond
    // pas au compte.
    if (!f.password) { setState({ loginError: 'Entre ton mot de passe.' }); return; }
    setState({ loginError: null });
    sb.auth.signInWithPassword({ email: f.email.trim(), password: f.password }).then(function (res) {
      if (res.error) setState({ loginError: 'E-mail ou mot de passe incorrect.' });
      // sinon : onAuthStateChange prend le relais (connexion + chargement des données).
    });
  }

  function submitSignup() {
    var f = state.loginForm;
    if (!f.name.trim()) { setState({ loginError: 'Entre ton prénom.' }); return; }
    if (!f.email.trim() || f.email.indexOf('@') === -1) { setState({ loginError: 'Entre un e-mail valide.' }); return; }
    if (!f.password || f.password.length < 8) { setState({ loginError: 'Mot de passe trop court (8 caractères min).' }); return; }
    setState({ loginError: null });
    sb.auth.signUp({
      email: f.email.trim(), password: f.password,
      options: { data: { name: f.name.trim(), color: INVITEE_COLORS[0] } },
    }).then(function (res) {
      if (res.error) { setState({ loginError: res.error.message }); return; }
      if (!res.data.session) {
        setState({ loginMode: 'password', loginForm: { email: '', password: '', name: '' } });
        showToast('Compte créé — vérifie ta boîte mail pour confirmer avant de te connecter.');
      }
      // sinon (confirmation e-mail désactivée) : onAuthStateChange connecte directement.
    });
  }

  function submitMagicLink() {
    var f = state.loginForm;
    if (!f.email.trim() || f.email.indexOf('@') === -1) { setState({ loginError: 'Entre un e-mail valide.' }); return; }
    setState({ loginError: null });
    sb.auth.signInWithOtp({
      email: f.email.trim(),
      options: { emailRedirectTo: APP_URL },
    }).then(function (res) {
      if (res.error) { setState({ loginError: res.error.message }); return; }
      setState({ magicSent: true });
    });
  }

  function submitForgotPassword() {
    var f = state.loginForm;
    if (!f.email.trim() || f.email.indexOf('@') === -1) { setState({ loginError: 'Entre un e-mail valide.' }); return; }
    setState({ loginError: null });
    sb.auth.resetPasswordForEmail(f.email.trim(), {
      redirectTo: APP_URL,
    }).then(function (res) {
      if (res.error) { setState({ loginError: res.error.message }); return; }
      setState({ resetSent: true });
    });
  }

  function submitNewPassword() {
    var pw = state.newPasswordForm.password;
    if (!pw || pw.length < 8) { setState({ loginError: 'Mot de passe trop court (8 caractères min).' }); return; }
    setState({ loginError: null });
    sb.auth.updateUser({ password: pw }).then(function (res) {
      if (res.error) { setState({ loginError: res.error.message }); return; }
      setState({ passwordRecovery: false, newPasswordForm: { password: '' } });
      showToast('Mot de passe mis à jour');
      if (res.data && res.data.user) {
        setStateSilent({ loggedIn: true, currentUserId: res.data.user.id, dataLoading: true });
        render();
        loadAppData();
      }
    });
  }

  function logout() {
    setState({ showAccount: false });
    sb.auth.signOut();
    // onAuthStateChange (SIGNED_OUT) réinitialise l'état et affiche l'écran de connexion.
  }

  // ---------- Passer d'un compte invité (anonyme) à un compte existant
  // ----------
  // La réinitialisation d'état déclenchée par SIGNED_OUT (cf. plus bas,
  // sb.auth.onAuthStateChange) reconstruit l'état depuis defaultState() —
  // cette variable, hors de `state`, y survit et indique au bloc SIGNED_OUT
  // d'amener directement l'écran de connexion plutôt que la landing.
  var pendingLoginAfterSignOut = false;
  function openConfirmSwitchAccount() { setState({ showConfirmSwitchAccount: true, showAccount: false }); }
  function cancelSwitchAccount() { setState({ showConfirmSwitchAccount: false }); }
  function confirmSwitchAccount() {
    pendingLoginAfterSignOut = true;
    setState({ showConfirmSwitchAccount: false });
    sb.auth.signOut();
  }
  // ---------- Suppression de compte (droit à l'effacement, cf.
  // supabase/functions/delete-account) ----------
  function openConfirmDeleteAccount() { setState({ showConfirmDeleteAccount: true, showAccount: false }); }
  function cancelDeleteAccount() { setState({ showConfirmDeleteAccount: false }); }
  function confirmDeleteAccount() {
    setState({ deletingAccount: true });
    sb.functions.invoke('delete-account', {}).then(function (res) {
      extractFunctionErrorMessage(res).then(function (errMsg) {
        if (errMsg) { setState({ deletingAccount: false }); showToast('Erreur : ' + errMsg); return; }
        // accountJustDeleted survit à la réinitialisation d'état déclenchée
        // par SIGNED_OUT (cf. Object.assign(defaultState(), {...}) plus
        // bas) — affiche un écran de confirmation dédié plutôt qu'un simple
        // toast, qui pourrait disparaître avant que la personne l'ait lu vu
        // la réinitialisation immédiate de l'écran au même moment.
        setStateSilent({ accountJustDeleted: true });
        sb.auth.signOut();
      });
    });
  }
  function dismissAccountDeleted() { setState({ accountJustDeleted: false }); }

  // ---------- Reminders / settle ----------
  // Les Edge Functions renvoient un statut non-2xx pour les erreurs
  // applicatives ; supabase-js remplace alors error.message par un texte
  // générique ("Edge Function returned a non-2xx status code") — le vrai
  // message est dans le corps JSON de la réponse, accessible via
  // error.context. Retourne une promesse résolue à null (pas d'erreur) ou
  // au message d'erreur à afficher.
  function extractFunctionErrorMessage(res) {
    if (!res.error && !(res.data && res.data.error)) return Promise.resolve(null);
    if (res.data && res.data.error) return Promise.resolve(res.data.error);
    var ctx = res.error && res.error.context;
    if (ctx && typeof ctx.json === 'function') {
      return ctx.json().then(function (body) { return (body && body.error) ? body.error : res.error.message; })
        .catch(function () { return res.error.message; });
    }
    return Promise.resolve(res.error ? res.error.message : 'erreur inconnue.');
  }
  // groupId (optionnel) doit correspondre au filtre actif sur l'écran d'où
  // l'action est déclenchée, pour que le montant proposé corresponde à ce
  // qui est affiché à l'écran plutôt qu'au solde tous groupes confondus.
  // L'enregistrement du rappel et la tentative d'envoi d'un vrai e-mail (si
  // le destinataire a un compte connu) sont délégués à une Edge Function
  // (`send-reminder`) : le montant/message restent calculés ici (le moteur
  // de calcul n'est pas dupliqué côté serveur), mais l'e-mail du
  // destinataire n'est jamais chargé côté client.
  function computeReminderMessage(personId, groupId) {
    var p = person(personId);
    var g = groupId ? group(groupId) : null;
    var debts = groupId ? computeDebtsForGroup(groupId) : computeDebts();
    var rel = pairNet(state.currentUserId, personId, debts);
    var amt = rel > 0 ? rel : 0;
    var msg = 'Petit rappel à ' + p.name + ' — psst, tu me dois encore ' + (g ? fmtIn(amt, g.currency) : fmt(amt));
    return { amount: amt, message: msg };
  }
  function sendReminder(personId, groupId) {
    var p = person(personId);
    var data = computeReminderMessage(personId, groupId);
    sb.functions.invoke('send-reminder', { body: { toUserId: personId, amount: data.amount, message: data.message, groupId: groupId || null } }).then(function (res) {
      extractFunctionErrorMessage(res).then(function (errMsg) {
        if (errMsg) { showToast('Erreur : ' + errMsg); return; }
        var d = res.data || {};
        // Affiche directement la raison quand l'e-mail n'est pas parti
        // (plutôt que de le passer sous silence) : permet de diagnostiquer
        // sans avoir à aller fouiller dans les logs de la Edge Function.
        var suffix = '';
        if (d.emailSent) suffix = ' (e-mail envoyé)';
        else if (d.emailSkippedReason === 'no_email') suffix = ' (rappel gardé dans l\'app uniquement — aucun e-mail connu pour ' + p.name + ')';
        else if (d.emailSkippedReason === 'not_configured') suffix = ' (e-mail non envoyé : clé Resend absente côté serveur)';
        else if (d.emailError) suffix = ' (e-mail refusé par Resend : ' + String(d.emailError).slice(0, 150) + ')';
        loadAppData().then(function () {
          showToast('Rappel envoyé à ' + p.name + suffix);
        });
      });
    }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : 'erreur réseau'));
    });
  }
  function openReminderConfirm(personId, groupId) {
    setState({
      showReminderConfirm: true,
      reminderPersonId: personId,
      reminderGroupId: groupId || null,
      reminderEmailDraft: (person(personId).email || ''),
    });
  }
  function closeReminderConfirm() { setState({ showReminderConfirm: false }); }
  function setReminderEmailDraft(v) { setStateSilent({ reminderEmailDraft: v }); }
  // Si un invité sans compte a saisi/modifié un e-mail dans la fenêtre de
  // confirmation, on l'enregistre d'abord (comme depuis "gérer les
  // membres") pour que le rappel qui suit puisse en profiter immédiatement.
  function confirmSendReminder() {
    var personId = state.reminderPersonId;
    var groupId = state.reminderGroupId;
    var p = person(personId);
    var draft = (state.reminderEmailDraft || '').trim();
    // Garde-fou en plus du bouton désactivé côté rendu (cf.
    // renderReminderConfirmModal) : un invité sans compte ni e-mail n'a
    // aucun moyen de voir un rappel envoyé sans en avoir renseigné un.
    if (!p.hasAccount && !p.email && draft.indexOf('@') === -1) {
      showToast('Ajoute un e-mail valide pour envoyer ce rappel.');
      return;
    }
    if (!p.hasAccount && draft && draft !== (p.email || '')) {
      if (draft.indexOf('@') === -1) { showToast('Entre un e-mail valide.'); return; }
      sb.from('profiles').update({ email: draft }).eq('id', personId).then(function (res) {
        if (res.error) { showToast('Erreur : ' + res.error.message); return; }
        setState({ showReminderConfirm: false });
        sendReminder(personId, groupId);
      });
      return;
    }
    setState({ showReminderConfirm: false });
    sendReminder(personId, groupId);
  }
  function openSettle(personId, groupId) {
    var me = state.currentUserId;
    var debts = groupId ? computeDebtsForGroup(groupId) : computeDebts();
    // bal = pairNet(me, personId) : positif si personId me doit (il/elle est
    // débiteur·rice, donc c'est lui/elle qui paie) ; négatif si c'est moi qui
    // dois (c'est donc moi qui paie).
    var bal = pairNet(me, personId, debts);
    var from = bal < 0 ? me : personId;
    var to = bal < 0 ? personId : me;
    var decimals = currencyDecimalsFor(groupId && group(groupId) ? group(groupId).currency : null);
    setState({ showSettle: true, settleGroupId: groupId || null, settleForm: { from: from, to: to, amount: Math.abs(bal).toFixed(decimals).replace('.', ','), paymentMethod: '', paymentReference: '' } });
  }
  // Raccourci "enregistrer" directement sur une ligne de suggestion : à la
  // différence de openSettle (qui déduit qui doit à qui en comparant "moi"
  // à une personne), le from/to/montant sont ici déjà connus tels quels
  // (la suggestion peut concerner deux personnes sans que "moi" soit
  // impliqué, ex. sur la vue "tous les groupes").
  function openSettleForPair(fromId, toId, amount, groupId) {
    var decimals = currencyDecimalsFor(groupId && group(groupId) ? group(groupId).currency : null);
    setState({ showSettle: true, settleGroupId: groupId || null, settleForm: { from: fromId, to: toId, amount: Math.abs(amount).toFixed(decimals).replace('.', ','), paymentMethod: '', paymentReference: '' } });
  }
  function setSettleAmount(v) { setStateSilent(function (s) { return { settleForm: Object.assign({}, s.settleForm, { amount: v }) }; }); }
  function setSettlePaymentMethod(v) { setState({ settleForm: Object.assign({}, state.settleForm, { paymentMethod: v }) }); }
  function setSettleReference(v) { setStateSilent(function (s) { return { settleForm: Object.assign({}, s.settleForm, { paymentReference: v }) }; }); }
  function submitSettle() {
    var sf = state.settleForm;
    var amt = parseFloat((sf.amount || '').replace(',', '.'));
    if (!amt || amt <= 0) return;
    sb.from('payments').insert({
      from_user: sf.from, to_user: sf.to, amount: amt, group_id: state.settleGroupId || null,
      payment_method: sf.paymentMethod || null, payment_reference: (sf.paymentReference || '').trim() || null,
    }).then(function (res) {
      if (res.error) { showToast('Erreur : ' + res.error.message); return; }
      setState({ showSettle: false, settleGroupId: null });
      celebrateSettlement();
      loadAppData().then(function () {
        showToast('Paiement enregistré');
        // Laisse d'abord voir les confettis et le toast avant d'éventuellement
        // superposer la modale d'avis — jamais immédiatement.
        setTimeout(maybeShowFeedbackPrompt, 1200);
      });
    });
  }
  // Codes USSD des principaux opérateurs mobile money à Madagascar — pas de
  // webhook de confirmation possible via ce canal (une session USSD se
  // déroule entièrement côté réseau opérateur, hors de portée du
  // navigateur) : ce bouton ouvre juste le clavier téléphone avec le code
  // pré-rempli, le règlement effectif et sa confirmation dans Rohy restent
  // manuels, comme le reste du règlement des dettes.
  var MOBILE_MONEY_USSD = {
    mvola: '*111#',
    orange_money: '*144#',
    airtel_money: '*436#',
  };
  function ussdTelHref(code) { return 'tel:' + encodeURIComponent(code); }

  // Petite explosion de confettis quand une dette est soldée — un moment
  // gratifiant qui mérite un peu plus qu'un toast discret. `confetti` vient
  // d'une lib CDN (cf. index.html) ; si elle n'a pas pu se charger (réseau
  // capricieux), on l'ignore silencieusement plutôt que de bloquer l'action.
  function celebrateSettlement() {
    if (typeof confetti !== 'function') return;
    var accent = getComputedStyle(document.documentElement).getPropertyValue('--brand-primary').trim() || '#0F8F6B';
    // --brand-secondary vaut désormais la même teinte que --brand-primary
    // (cf. styles.css) : pour garder un peu de variété dans l'explosion de
    // confettis (purement décorative, pas un indicateur de statut), on
    // reprend directement une des autres teintes du logo tissé plutôt que
    // de dupliquer deux fois le même vert.
    confetti({
      particleCount: 90,
      spread: 70,
      startVelocity: 38,
      origin: { y: 0.7 },
      colors: [accent, '#D6247A', '#C9A159', '#FFFFFF'],
      disableForReducedMotion: true,
    });
  }

  // ---------- Expenses ----------
  function openAddExpense(groupId) {
    var g = groupId ? group(groupId) : state.groups[0];
    if (!g) { showToast('Crée d\'abord un groupe pour ajouter une dépense'); return; }
    var overrides = {};
    g.memberIds.forEach(function (pid) { if (person(pid).guardianId) overrides[pid] = person(pid).guardianId; });
    setState({
      showAddExpense: true,
      formError: null,
      form: {
        editingId: null, label: '', amount: '', date: new Date().toISOString().slice(0, 10), groupId: g.id, paidBy: state.currentUserId,
        participantIds: g.memberIds.slice(), overrides: overrides, fullyPaid: true, paidExternal: '', category: 'autre',
        splitMode: 'default', splitValues: {},
        receiptPath: null, receiptFile: null, receiptRemove: false, scanning: false, scanError: null,
        currency: g.currency, foreignAmount: '', exchangeRate: '', rateLoading: false, rateError: null, freezeRates: !!g.freezeCurrencyRates,
      },
    });
  }
  function categoryForIcon(icon) {
    var found = seed.EXPENSE_CATEGORIES.find(function (c) { return c.icon === icon; });
    return found ? found.id : 'autre';
  }
  function iconForCategory(categoryId) {
    var found = seed.EXPENSE_CATEGORIES.find(function (c) { return c.id === categoryId; });
    return found ? found.icon : seed.EXPENSE_CATEGORIES[seed.EXPENSE_CATEGORIES.length - 1].icon;
  }
  function openEditExpense(expenseId) {
    var e = state.expenses.find(function (x) { return x.id === expenseId; });
    if (!e) return;
    var g = group(e.groupId);
    var fullyPaid = (e.paidExternal != null ? e.paidExternal : e.amount) >= e.amount - 0.005;
    var splitValues = {};
    Object.keys(e.splitValues || {}).forEach(function (pid) { splitValues[pid] = String(e.splitValues[pid]).replace('.', ','); });
    setState({
      showAddExpense: true,
      formError: null,
      form: {
        editingId: e.id, label: e.label, amount: String(e.amount).replace('.', ','), date: e.date, groupId: e.groupId, paidBy: e.paidBy,
        participantIds: e.participants.slice(), overrides: Object.assign({}, e.overrides || {}),
        fullyPaid: fullyPaid, paidExternal: fullyPaid ? '' : String(e.paidExternal != null ? e.paidExternal : 0).replace('.', ','),
        category: categoryForIcon(e.icon),
        splitMode: e.splitMode || 'default', splitValues: splitValues,
        receiptPath: e.receiptPath || null, receiptFile: null, receiptRemove: false, scanning: false, scanError: null,
        // Modifier une dépense déjà convertie réaffiche le taux réellement
        // utilisé à l'époque (cf. migration 0019) plutôt que d'aller
        // rechercher un nouveau taux du jour — l'historique ne doit pas
        // bouger tant que la devise/le montant d'origine ne changent pas.
        currency: e.originalCurrency || (g && g.currency), foreignAmount: e.originalAmount != null ? String(e.originalAmount).replace('.', ',') : '',
        exchangeRate: e.exchangeRate != null ? String(e.exchangeRate).replace('.', ',') : '',
        rateLoading: false, rateError: null, freezeRates: !!(g && g.freezeCurrencyRates),
      },
    });
  }
  function deleteExpense() {
    var id = state.form.editingId;
    if (!id) return;
    sb.from('expenses').delete().eq('id', id).then(function (res) {
      if (res.error) { showToast('Erreur : ' + res.error.message); return; }
      setState({ showAddExpense: false });
      loadAppData().then(function () { showToast('Dépense supprimée'); });
    });
  }
  function markExpensePaidFull(expenseId) {
    var e = state.expenses.find(function (x) { return x.id === expenseId; });
    if (!e) return;
    sb.from('expenses').update({ paid_external: e.amount }).eq('id', expenseId).then(function (res) {
      if (res.error) { showToast('Erreur : ' + res.error.message); return; }
      loadAppData().then(function () { showToast('Marqué comme réglé en totalité'); });
    });
  }
  // ---------- Conversion de devise par dépense ----------
  // API gratuite, sans clé, sans limite de débit, servie depuis jsdelivr —
  // déjà un CDN de confiance ici (supabase-js/exceljs/jspdf y sont chargés
  // dans index.html) — donc aucune nouvelle dépendance à faire approuver.
  // https://github.com/fawazahmed0/exchange-api
  function fetchLiveExchangeRate(fromCode, toCode) {
    var from = fromCode.toLowerCase(), to = toCode.toLowerCase();
    var url = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/' + from + '.json';
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 6000) : null;
    return fetch(url, controller ? { signal: controller.signal } : {}).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      var rate = data && data[from] ? data[from][to] : null;
      if (!rate || !isFinite(rate) || rate <= 0) throw new Error('Devise non supportée');
      return rate;
    }).catch(function () {
      if (timer) clearTimeout(timer);
      // Échec silencieux : l'appelant retombe sur le dernier taux connu du
      // groupe, ou laisse le champ vide pour une saisie manuelle (cf.
      // selectExpenseCurrency/refreshExchangeRate) — jamais bloquant pour
      // la suite du formulaire.
      return null;
    });
  }
  // Recalcule le montant en devise du groupe (f.amount, ce que consomme
  // calc.js sans le savoir) à partir du montant payé dans la devise
  // d'origine et du taux — appelé à chaque frappe dans l'un ou l'autre champ
  // pour garder les deux synchronisés en continu.
  function recomputeConvertedAmount(form) {
    var fa = parseFloat((form.foreignAmount || '').replace(',', '.'));
    var rate = parseFloat((form.exchangeRate || '').replace(',', '.'));
    if (!isNaN(fa) && !isNaN(rate) && fa > 0 && rate > 0) {
      return Object.assign({}, form, { amount: String(Math.round(fa * rate * 100) / 100).replace('.', ',') });
    }
    return form;
  }
  function applyFetchedRate(rate, rateError) {
    setState(function (s) {
      var form = Object.assign({}, s.form, { exchangeRate: String(rate).replace('.', ','), rateLoading: false, rateError: rateError || null });
      return { form: recomputeConvertedAmount(form) };
    });
  }
  function selectExpenseCurrency(code) {
    var g = group(state.form.groupId);
    var groupCur = g && g.currency;
    if (!g || code === groupCur) {
      setState(function (s) { return { form: Object.assign({}, s.form, { currency: code, foreignAmount: '', exchangeRate: '', rateError: null, rateLoading: false }) }; });
      return;
    }
    var stored = (state.currencyRates[g.id] || {})[code];
    var useStored = g.freezeCurrencyRates && stored;
    setState(function (s) { return { form: Object.assign({}, s.form, { currency: code, rateError: null, rateLoading: !useStored }) }; });
    if (useStored) { applyFetchedRate(stored); return; }
    var groupId = g.id;
    fetchLiveExchangeRate(code, groupCur).then(function (rate) {
      // Le groupe/la devise a pu changer pendant l'attente réseau — on
      // ignore alors ce résultat devenu obsolète plutôt que d'écraser un
      // champ qui ne correspond plus à la sélection actuelle.
      if (state.form.groupId !== groupId || state.form.currency !== code) return;
      if (rate) { applyFetchedRate(rate); }
      else if (stored) { applyFetchedRate(stored, 'Taux du jour indisponible — dernier taux connu repris, modifiable.'); }
      else { setState(function (s) { return { form: Object.assign({}, s.form, { rateLoading: false, rateError: 'Taux automatique indisponible — saisis-le manuellement.' }) }; }); }
    });
  }
  function refreshExchangeRate() {
    var f = state.form;
    var g = group(f.groupId);
    if (!g || f.currency === g.currency) return;
    setState(function (s) { return { form: Object.assign({}, s.form, { rateLoading: true, rateError: null }) }; });
    var groupId = g.id, code = f.currency;
    fetchLiveExchangeRate(code, g.currency).then(function (rate) {
      if (state.form.groupId !== groupId || state.form.currency !== code) return;
      if (rate) { applyFetchedRate(rate); }
      else { setState(function (s) { return { form: Object.assign({}, s.form, { rateLoading: false, rateError: 'Taux du jour indisponible.' }) }; }); }
    });
  }
  function toggleFreezeCurrencyRates() {
    var g = group(state.form.groupId);
    if (!g) return;
    var next = !g.freezeCurrencyRates;
    sb.from('groups').update({ freeze_currency_rates: next }).eq('id', g.id).then(function (res) {
      if (res.error) { showToast('Erreur : ' + res.error.message); return; }
      setState(function (s) {
        var groups = s.groups.map(function (gg) { return gg.id === g.id ? Object.assign({}, gg, { freezeCurrencyRates: next }) : gg; });
        return { groups: groups, form: Object.assign({}, s.form, { freezeRates: next }) };
      });
    });
  }
  // setState (pas silencieux) : contrairement aux autres champs texte de ce
  // formulaire, l'aperçu "≈ montant converti" affiché juste en dessous doit
  // suivre chaque frappe — même compromis déjà fait pour setSplitValue (le
  // reste à répartir affiché en direct).
  function setForeignAmount(v) { setState(function (s) { return { form: recomputeConvertedAmount(Object.assign({}, s.form, { foreignAmount: v })) }; }); }
  function setExchangeRate(v) { setState(function (s) { return { form: recomputeConvertedAmount(Object.assign({}, s.form, { exchangeRate: v })) }; }); }

  function toggleFullyPaid() { setState(function (s) { return { form: Object.assign({}, s.form, { fullyPaid: !s.form.fullyPaid }) }; }); }
  function setPaidExternal(v) { setStateSilent(function (s) { return { form: Object.assign({}, s.form, { paidExternal: v }) }; }); }
  function setLabel(v) { setStateSilent(function (s) { return { form: Object.assign({}, s.form, { label: v }) }; }); }
  function setAmount(v) { setStateSilent(function (s) { return { form: Object.assign({}, s.form, { amount: v }) }; }); }
  function setDate(v) { setStateSilent(function (s) { return { form: Object.assign({}, s.form, { date: v }) }; }); }
  function setCategory(categoryId) { setState(function (s) { return { form: Object.assign({}, s.form, { category: categoryId }) }; }); }
  function selectGroupForForm(groupId) {
    var g = group(groupId);
    var overrides = {};
    g.memberIds.forEach(function (pid) { if (person(pid).guardianId) overrides[pid] = person(pid).guardianId; });
    // Les membres changent avec le groupe : une répartition ponctuelle
    // (montants/pourcentages/parts) saisie pour l'ancien groupe n'a plus de
    // sens, on repart du mode par défaut plutôt que de garder des valeurs
    // orphelines.
    setState(function (s) {
      return {
        form: Object.assign({}, s.form, {
          groupId: groupId, participantIds: g.memberIds.slice(), overrides: overrides, splitMode: 'default', splitValues: {},
          // Un taux de change saisi pour l'ancien groupe n'a pas de raison de
          // s'appliquer à un autre groupe (devise différente possible, taux
          // gelé propre à chaque groupe) — on repart de la devise du
          // nouveau groupe, comme à l'ouverture du formulaire.
          currency: g.currency, foreignAmount: '', exchangeRate: '', rateError: null, rateLoading: false, freezeRates: !!g.freezeCurrencyRates,
        }),
      };
    });
  }
  function selectPayer(pid) { setState(function (s) { return { form: Object.assign({}, s.form, { paidBy: pid }) }; }); }
  function toggleParticipant(pid) {
    setState(function (s) {
      var has = s.form.participantIds.indexOf(pid) !== -1;
      var participantIds = has ? s.form.participantIds.filter(function (x) { return x !== pid; }) : s.form.participantIds.concat([pid]);
      return { form: Object.assign({}, s.form, { participantIds: participantIds }) };
    });
  }
  function toggleAllParticipants() {
    setState(function (s) {
      var g = s.form.groupId ? group(s.form.groupId) : s.groups[0];
      if (!g) return {};
      var allSelected = g.memberIds.every(function (pid) { return s.form.participantIds.indexOf(pid) !== -1; });
      return { form: Object.assign({}, s.form, { participantIds: allSelected ? [] : g.memberIds.slice() }) };
    });
  }
  // Bascule le mode de répartition d'une dépense. Pré-remplit les valeurs
  // ponctuelles à partir de la répartition actuellement affichée (poids
  // habituel au premier changement, puis valeurs précédemment saisies pour
  // les changements suivants) : l'utilisateur part d'un état cohérent plutôt
  // que de zéro, et n'a qu'à ajuster ce qui doit vraiment différer.
  function setSplitMode(mode) {
    setState(function (s) {
      var f = s.form;
      if (mode === f.splitMode) return {};
      var splitValues = {};
      if (mode === 'shares' || mode === 'exact' || mode === 'percent') {
        var amt = parseFloat((f.amount || '0').replace(',', '.')) || 0;
        var g = f.groupId ? group(f.groupId) : null;
        var decimals = currencyDecimalsFor(g && g.currency);
        var numericValues = {};
        Object.keys(f.splitValues).forEach(function (pid) {
          var n = parseFloat((f.splitValues[pid] || '').replace(',', '.'));
          if (!isNaN(n)) numericValues[pid] = n;
        });
        var baseline = calc.computeShares(amt || 1, f.participantIds, state.people, { splitMode: f.splitMode, splitValues: numericValues });
        f.participantIds.forEach(function (pid) {
          if (mode === 'shares') splitValues[pid] = String(calc.weightFor(person(pid))).replace('.', ',');
          else if (mode === 'exact') splitValues[pid] = (baseline[pid] || 0).toFixed(decimals).replace('.', ',');
          else splitValues[pid] = (amt > 0 ? (baseline[pid] || 0) / amt * 100 : 0).toFixed(1).replace('.', ',');
        });
      }
      return { form: Object.assign({}, f, { splitMode: mode, splitValues: splitValues }) };
    });
  }
  function setSplitValue(pid, v) {
    setState(function (s) {
      var splitValues = Object.assign({}, s.form.splitValues);
      splitValues[pid] = v;
      return { form: Object.assign({}, s.form, { splitValues: splitValues }) };
    });
  }
  // Total actuellement saisi vs. cible (montant de la dépense pour "exact",
  // 100 pour "pourcentage") ; null si le mode courant n'a pas de cible à
  // atteindre (default/equal/shares n'ont pas besoin de sommer à une valeur
  // précise, ce sont de simples poids relatifs).
  function splitTarget(f) {
    if (f.splitMode !== 'exact' && f.splitMode !== 'percent') return null;
    var amt = parseFloat((f.amount || '0').replace(',', '.')) || 0;
    var target = f.splitMode === 'percent' ? 100 : amt;
    var sum = f.participantIds.reduce(function (acc, pid) {
      var v = parseFloat((f.splitValues[pid] || '0').replace(',', '.'));
      return acc + (isNaN(v) ? 0 : v);
    }, 0);
    return { sum: sum, target: target, remainder: target - sum, ok: Math.abs(target - sum) < 0.01 };
  }
  function setReceiptFile(file) {
    setState(function (s) { return { form: Object.assign({}, s.form, { receiptFile: file, receiptRemove: false }) }; });
  }
  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        // reader.result est une data URL ("data:image/jpeg;base64,xxx") —
        // seule la partie après la virgule est le base64 attendu par l'API.
        resolve(String(reader.result).split(',')[1] || '');
      };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsDataURL(file);
    });
  }
  // Photo de ticket -> Edge Function "scan-receipt" (lecture par IA vision,
  // cf. supabase/functions/scan-receipt) -> pré-remplissage du formulaire.
  // Le fichier devient aussi le reçu joint à la dépense (setReceiptFile),
  // pour ne pas demander la même photo deux fois. La lecture ne fait que
  // PRÉ-remplir des champs restant modifiables — aucune dépense n'est créée
  // tant que "Enregistrer la dépense" n'est pas cliqué, et un échec de
  // lecture n'empêche jamais la saisie manuelle.
  function scanReceipt(file) {
    if (!file) return;
    setReceiptFile(file);
    setStateSilent(function (s) { return { form: Object.assign({}, s.form, { scanning: true, scanError: null }) }; });
    render();
    fileToBase64(file).then(function (base64) {
      return sb.functions.invoke('scan-receipt', { body: { image: base64, mimeType: file.type } });
    }).then(function (res) {
      return extractFunctionErrorMessage(res).then(function (errMsg) {
        if (errMsg) throw new Error(errMsg);
        var d = res.data || {};
        setState(function (s) {
          var f = Object.assign({}, s.form, { scanning: false });
          if (d.label) f.label = d.label;
          if (d.amount != null) f.amount = String(d.amount).replace('.', ',');
          if (d.date) f.date = d.date;
          return { form: f };
        });
        showToast('Document lu — vérifie les champs avant d\'enregistrer');
      });
    }).catch(function (err) {
      setState(function (s) { return { form: Object.assign({}, s.form, { scanning: false, scanError: err.message }) }; });
      showToast('Erreur : ' + (err && err.message ? err.message : 'lecture du document impossible'));
    });
  }
  function removeReceipt() {
    setState(function (s) { return { form: Object.assign({}, s.form, { receiptFile: null, receiptRemove: true }) }; });
  }
  function viewReceipt(path) {
    sb.storage.from('receipts').createSignedUrl(path, 120).then(function (res) {
      if (res.error || !res.data) { showToast('Impossible d\'ouvrir le reçu'); return; }
      window.open(res.data.signedUrl, '_blank', 'noopener');
    });
  }
  function setOverride(pid, v) {
    setState(function (s) {
      var overrides = Object.assign({}, s.form.overrides);
      if (v === 'self') delete overrides[pid];
      else overrides[pid] = v;
      return { form: Object.assign({}, s.form, { overrides: overrides }) };
    });
  }
  function sanitizeFilename(name) {
    return String(name || 'fichier').replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  // Dépose/retire le reçu joint après coup (a besoin de l'id de la dépense,
  // donc appelé une fois l'INSERT/UPDATE de la dépense elle-même terminé).
  // Chaque envoi utilise un nom de fichier unique (horodaté) : pas besoin de
  // policy d'update sur storage.objects, l'ancien fichier est juste retiré
  // une fois le nouveau chemin enregistré.
  function persistReceiptChange(expenseId, groupId) {
    var f = state.form;
    if (f.receiptFile) {
      var oldPath = f.receiptPath;
      var path = groupId + '/' + expenseId + '-' + Date.now() + '-' + sanitizeFilename(f.receiptFile.name);
      return sb.storage.from('receipts').upload(path, f.receiptFile).then(function (upRes) {
        if (upRes.error) return { error: upRes.error };
        return sb.from('expenses').update({ receipt_path: path }).eq('id', expenseId).then(function (res) {
          if (res.error) return { error: res.error };
          if (oldPath) sb.storage.from('receipts').remove([oldPath]);
          return { error: null };
        });
      });
    }
    if (f.receiptRemove && f.receiptPath) {
      return sb.from('expenses').update({ receipt_path: null }).eq('id', expenseId).then(function (res) {
        if (res.error) return { error: res.error };
        sb.storage.from('receipts').remove([f.receiptPath]);
        return { error: null };
      });
    }
    return Promise.resolve({ error: null });
  }

  function submitExpense() {
    var f = state.form;
    var g = group(f.groupId);
    var isForeign = !!(g && f.currency && f.currency !== g.currency);
    var originalAmount = null, exchangeRateVal = null, amt;
    if (isForeign) {
      originalAmount = parseFloat((f.foreignAmount || '').replace(',', '.'));
      exchangeRateVal = parseFloat((f.exchangeRate || '').replace(',', '.'));
      if (!originalAmount || originalAmount <= 0) { setState({ formError: 'Montant payé invalide.' }); return; }
      if (!exchangeRateVal || exchangeRateVal <= 0) { setState({ formError: 'Taux de change invalide.' }); return; }
      amt = Math.round(originalAmount * exchangeRateVal * 100) / 100;
    } else {
      amt = parseFloat((f.amount || '').replace(',', '.'));
    }
    if (!f.label.trim()) { setState({ formError: 'Ajoute une description.' }); return; }
    if (!amt || amt <= 0) { setState({ formError: 'Montant invalide.' }); return; }
    if (!f.date) { setState({ formError: 'Choisis une date.' }); return; }
    if (f.participantIds.length === 0) { setState({ formError: 'Sélectionne au moins un participant.' }); return; }
    var target = splitTarget(f);
    if (target && !target.ok) {
      var targetLabel = f.splitMode === 'percent' ? '100 %' : fmtIn(target.target, g && g.currency);
      var sumLabel = f.splitMode === 'percent' ? target.sum.toFixed(1).replace('.', ',') + ' %' : fmtIn(target.sum, g && g.currency);
      setState({ formError: 'La répartition doit sommer à ' + targetLabel + ' (actuellement ' + sumLabel + ').' });
      return;
    }
    var paidExternal = amt;
    if (!f.fullyPaid) {
      var pe = parseFloat((f.paidExternal || '').replace(',', '.'));
      paidExternal = isNaN(pe) ? 0 : Math.max(0, Math.min(amt, pe));
    }
    setState({ formError: null });

    var splitValueFor = function (pid) {
      if (f.splitMode !== 'shares' && f.splitMode !== 'exact' && f.splitMode !== 'percent') return null;
      var v = parseFloat((f.splitValues[pid] || '').replace(',', '.'));
      return isNaN(v) ? null : v;
    };
    var participantRowsFor = function (expenseId) {
      return f.participantIds.map(function (pid) {
        return { expense_id: expenseId, user_id: pid, override_responsible_id: f.overrides[pid] || null, split_value: splitValueFor(pid) };
      });
    };
    // Conserve le dernier taux utilisé pour cette devise dans ce groupe —
    // sert de repli hors-ligne et de pré-remplissage la prochaine fois
    // (immédiatement si "geler les taux" est actif, cf. selectExpenseCurrency).
    // Best-effort, ne bloque jamais la sauvegarde de la dépense elle-même.
    var cacheExchangeRate = function () {
      if (!isForeign) return;
      sb.from('group_currency_rates').upsert(
        { group_id: f.groupId, currency: f.currency, rate: exchangeRateVal, updated_at: new Date().toISOString() },
        { onConflict: 'group_id,currency' }
      );
    };
    var currencyFields = {
      original_currency: isForeign ? f.currency : null,
      original_amount: isForeign ? originalAmount : null,
      exchange_rate: isForeign ? exchangeRateVal : null,
    };

    if (f.editingId) {
      sb.from('expenses').update(Object.assign({
        group_id: f.groupId, label: f.label.trim(), icon: iconForCategory(f.category), amount: amt, paid_external: paidExternal, expense_date: f.date, paid_by: f.paidBy,
        split_mode: f.splitMode,
      }, currencyFields)).eq('id', f.editingId).then(function (res) {
        if (res.error) { setState({ formError: res.error.message }); return; }
        cacheExchangeRate();
        sb.from('expense_participants').delete().eq('expense_id', f.editingId).then(function () {
          sb.from('expense_participants').insert(participantRowsFor(f.editingId)).then(function (insRes) {
            if (insRes.error) { showToast('Erreur : ' + insRes.error.message); return; }
            persistReceiptChange(f.editingId, f.groupId).then(function (recRes) {
              setState({ showAddExpense: false });
              loadAppData().then(function () {
                showToast(recRes.error ? 'Dépense modifiée (reçu : ' + recRes.error.message + ')' : 'Dépense modifiée');
              });
            });
          });
        });
      });
      return;
    }

    sb.from('expenses').insert(Object.assign({
      group_id: f.groupId, label: f.label.trim(), icon: iconForCategory(f.category), amount: amt, paid_external: paidExternal, paid_by: f.paidBy, expense_date: f.date,
      split_mode: f.splitMode,
    }, currencyFields)).select().single().then(function (res) {
      if (res.error) { setState({ formError: res.error.message }); return; }
      cacheExchangeRate();
      sb.from('expense_participants').insert(participantRowsFor(res.data.id)).then(function (insRes) {
        if (insRes.error) { showToast('Erreur : ' + insRes.error.message); return; }
        persistReceiptChange(res.data.id, f.groupId).then(function (recRes) {
          setState({ showAddExpense: false });
          loadAppData().then(function () {
            showToast(recRes.error ? 'Dépense ajoutée à ' + g.name + ' (reçu : ' + recRes.error.message + ')' : 'Dépense ajoutée à ' + g.name);
            maybeShowUpgradeNudge();
          });
        });
      });
    });
  }

  // ---------- Groups ----------
  // Couleurs des pastilles d'avatar (initiales), attribuées en cycle aux
  // nouveaux membres — dérivées des 4 couleurs de la marque (celles du logo
  // tissé : rose, vert, doré, violet), pas une palette générique à part.
  // Chaque teinte est éclaircie (même teinte/saturation, luminosité ajustée)
  // juste ce qu'il faut pour rester lisible avec le texte foncé fixe des
  // avatars (`.avatar`, cf. styles.css) — les couleurs de marque telles
  // quelles n'offrent pas toutes un contraste suffisant avec ce texte (le
  // rose et le violet, notamment, sont trop saturés une fois testés).
  var INVITEE_COLORS = ['#E566A4', '#11A279', '#C9A15A', '#B381CB'];

  function openAddGroup() {
    setState({
      showAddGroup: true,
      formError: null,
      submittingGroup: false,
      groupForm: { name: '', currency: seed.CURRENCIES[0].code, invitees: [{ name: '', email: '', shareWeight: '1', linkExistingId: null }] },
    });
  }
  function setGroupName(v) { setStateSilent(function (s) { return { groupForm: Object.assign({}, s.groupForm, { name: v }) }; }); }
  function setGroupCurrency(code) { setState(function (s) { return { groupForm: Object.assign({}, s.groupForm, { currency: code }) }; }); }
  function updateInvitee(index, field, value, silent) {
    var fn = silent ? setStateSilent : setState;
    fn(function (s) {
      var invitees = s.groupForm.invitees.map(function (inv, i) {
        return i === index ? Object.assign({}, inv, (function () { var patch = {}; patch[field] = value; return patch; })()) : inv;
      });
      return { groupForm: Object.assign({}, s.groupForm, { invitees: invitees }) };
    });
  }
  // Le prénom doit rafraîchir la liste de suggestions de profils existants
  // juste en dessous (cf. guestSuggestionsFor), mais un setState (donc un
  // render() complet, qui recrée tout le DOM de la modale via innerHTML)
  // recrée aussi le champ "Prénom" lui-même, perturbant le clavier virtuel
  // mobile — même debouncé de 300ms, ça reste visible dès que l'utilisateur
  // marque une pause en tapant. Correctif définitif : ne patcher QUE le
  // conteneur sous le champ (cf. data-invitee-below, inviteeBelowNameHtml),
  // jamais le champ "Prénom" lui-même, qui ne quitte donc plus jamais le
  // DOM pendant la frappe.
  function setInviteeName(index, v) {
    updateInvitee(index, 'name', v, true);
    updateInvitee(index, 'linkExistingId', null, true);
    clearTimeout(inviteeNameDebounceTimer);
    inviteeNameDebounceTimer = setTimeout(function () {
      var root = document.getElementById('app');
      var below = root.querySelector('[data-invitee-below="' + index + '"]');
      if (below) below.innerHTML = inviteeBelowNameHtml(index);
    }, 300);
  }
  function setInviteeEmail(index, v) { updateInvitee(index, 'email', v, true); }
  function setInviteeShare(index, v) { updateInvitee(index, 'shareWeight', v, true); }
  function selectExistingGuestForInvitee(index, profileId) {
    var p = person(profileId);
    if (!p) return;
    updateInvitee(index, 'name', p.name, true);
    updateInvitee(index, 'linkExistingId', profileId, false);
  }
  function unlinkExistingGuestForInvitee(index) { updateInvitee(index, 'linkExistingId', null, false); }
  function addInviteeRow() {
    setState(function (s) { return { groupForm: Object.assign({}, s.groupForm, { invitees: s.groupForm.invitees.concat([{ name: '', email: '', shareWeight: '1', linkExistingId: null }]) }) }; });
  }
  function removeInviteeRow(index) {
    setState(function (s) {
      var invitees = s.groupForm.invitees.filter(function (_, i) { return i !== index; });
      if (invitees.length === 0) invitees = [{ name: '', email: '', shareWeight: '1', linkExistingId: null }];
      return { groupForm: Object.assign({}, s.groupForm, { invitees: invitees }) };
    });
  }
  // Invite un membre par e-mail dans un groupe déjà créé. Retourne une
  // promesse résolue avec null en cas de succès, ou une chaîne décrivant
  // l'échec sinon — jamais rejetée, pour pouvoir enchaîner les invitations
  // d'une série les unes après les autres sans qu'un échec en bloque
  // d'autres.
  // Résout toujours { ok, userId, failure } — jamais rejeté — pour pouvoir
  // enchaîner plusieurs invitations sans qu'un échec en bloque d'autres.
  function inviteMemberToGroup(groupId, name, email, shareWeight, color) {
    return sb.functions.invoke('invite-member', {
      body: { groupId: groupId, name: name, email: email, shareWeight: shareWeight, color: color },
    }).then(function (inviteRes) {
      if (!inviteRes.error && !(inviteRes.data && inviteRes.data.error)) {
        return { ok: true, userId: inviteRes.data && inviteRes.data.userId, failure: null };
      }
      if (inviteRes.data && inviteRes.data.error) return { ok: false, userId: null, failure: name + ' (' + inviteRes.data.error + ')' };
      // Quand la fonction répond avec un statut non-2xx, supabase-js met un
      // message générique ("Edge Function returned a non-2xx status code")
      // dans error.message — le vrai message renvoyé par invite-member (ex :
      // "seul l'admin peut inviter", "e-mail invalide"...) est dans le corps
      // JSON de la réponse, accessible via error.context.
      var ctx = inviteRes.error && inviteRes.error.context;
      if (ctx && typeof ctx.json === 'function') {
        return ctx.json().then(function (body) {
          return { ok: false, userId: null, failure: name + ' (' + (body && body.error ? body.error : inviteRes.error.message) + ')' };
        }).catch(function () {
          return { ok: false, userId: null, failure: name + ' (' + inviteRes.error.message + ')' };
        });
      }
      return { ok: false, userId: null, failure: name + ' (' + (inviteRes.error ? inviteRes.error.message : 'erreur inconnue') + ')' };
    }).catch(function (err) {
      return { ok: false, userId: null, failure: name + ' (' + (err && err.message ? err.message : 'erreur réseau') + ')' };
    });
  }

  // Enchaîne les invitations une par une (plutôt qu'en parallèle) : plus
  // simple à diagnostiquer en cas d'échec, et évite de solliciter l'API
  // d'invitation de Supabase avec plusieurs appels concurrents d'un coup.
  function inviteSequentially(invitees, groupId) {
    var failed = [];
    return invitees.reduce(function (chain, invitee, idx) {
      return chain.then(function () {
        return inviteMemberToGroup(groupId, invitee.name.trim(), invitee.email.trim(), invitee.shareWeight, INVITEE_COLORS[idx % INVITEE_COLORS.length])
          .then(function (result) { if (!result.ok) failed.push(result.failure); });
      });
    }, Promise.resolve()).then(function () { return failed; });
  }

  // Un invité sans e-mail à la création d'un groupe est ajouté directement
  // comme profil sans compte (même logique que submitAddMember pour
  // "gérer les membres") plutôt que de passer par invite-member, qui exige
  // un e-mail.
  function addGuestMemberToGroup(groupId, name, shareWeight, color) {
    var w = parseFloat((shareWeight || '1').replace(',', '.'));
    if (isNaN(w) || w < 0) w = 1;
    return sb.from('profiles').insert({
      name: name, color: color, share_weight: w, created_by: state.currentUserId,
    }).select().single().then(function (res) {
      if (res.error) return { ok: false, failure: name + ' (' + res.error.message + ')' };
      return sb.from('group_members').insert({ group_id: groupId, user_id: res.data.id }).then(function (memRes) {
        if (memRes.error) return { ok: false, failure: name + ' (' + memRes.error.message + ')' };
        return { ok: true, failure: null };
      });
    }).catch(function (err) {
      return { ok: false, failure: name + ' (' + (err && err.message ? err.message : 'erreur réseau') + ')' };
    });
  }
  function addGuestMembersSequentially(invitees, groupId, colorOffset) {
    var failed = [];
    return invitees.reduce(function (chain, invitee, idx) {
      return chain.then(function () {
        return addGuestMemberToGroup(groupId, invitee.name.trim(), invitee.shareWeight, INVITEE_COLORS[(colorOffset + idx) % INVITEE_COLORS.length])
          .then(function (result) { if (!result.ok) failed.push(result.failure); });
      });
    }, Promise.resolve()).then(function () { return failed; });
  }

  // Ajoute au groupe des invités déjà liés à un profil existant (suggestion
  // sélectionnée) : pas de création de profil, juste l'adhésion au groupe.
  function linkExistingMembersSequentially(invitees, groupId) {
    var failed = [];
    return invitees.reduce(function (chain, invitee) {
      return chain.then(function () {
        return sb.from('group_members').insert({ group_id: groupId, user_id: invitee.linkExistingId }).then(function (res) {
          if (res.error) failed.push(invitee.name.trim() + ' (' + res.error.message + ')');
        });
      });
    }, Promise.resolve()).then(function () { return failed; });
  }

  function submitGroup() {
    if (state.submittingGroup) return;
    var gf = state.groupForm;
    if (!gf.name.trim()) { setState({ formError: 'Donne un nom au groupe.' }); return; }
    var validInvitees = gf.invitees.filter(function (inv) { return inv.name.trim() || inv.email.trim() || inv.linkExistingId; });
    for (var i = 0; i < validInvitees.length; i++) {
      var inv = validInvitees[i];
      if (!inv.name.trim()) { setState({ formError: 'Donne un prénom à chaque membre invité.' }); return; }
      if (!inv.linkExistingId && inv.email.trim() && inv.email.indexOf('@') === -1) { setState({ formError: 'E-mail invalide pour ' + inv.name.trim() + '.' }); return; }
    }
    setState({ formError: null, submittingGroup: true });

    var linked = validInvitees.filter(function (inv) { return inv.linkExistingId; });
    var withEmail = validInvitees.filter(function (inv) { return !inv.linkExistingId && inv.email.trim(); });
    var withoutEmail = validInvitees.filter(function (inv) { return !inv.linkExistingId && !inv.email.trim(); });

    sb.from('groups').insert({ name: gf.name.trim(), currency: gf.currency, admin_id: state.currentUserId }).select().single().then(function (res) {
      if (res.error) { setState({ formError: res.error.message, submittingGroup: false }); return; }
      var newGroup = res.data;
      sb.from('group_members').insert({ group_id: newGroup.id, user_id: state.currentUserId }).then(function (memRes) {
        if (memRes.error) { setState({ formError: memRes.error.message, submittingGroup: false }); return; }

        Promise.all([
          linkExistingMembersSequentially(linked, newGroup.id),
          inviteSequentially(withEmail, newGroup.id),
          addGuestMembersSequentially(withoutEmail, newGroup.id, withEmail.length),
        ]).then(function (results) {
          var failedInvites = results[0].concat(results[1]).concat(results[2]);
          // Direction directe vers l'écran Dépenses du groupe qu'on vient de
          // créer (filtré dessus), plutôt que de laisser sur la liste des
          // groupes : on vient de créer ce groupe précisément pour y suivre
          // des dépenses, autant y atterrir directement (même logique que
          // Splitwise/Tricount) — état vide déjà pourvu d'un bouton "Ajouter
          // une dépense" pré-scopé à ce groupe.
          setState({
            showAddGroup: false, submittingGroup: false, lastActiveGroupId: newGroup.id,
            screen: 'expenses', navStack: [], expensesGroupFilter: newGroup.id,
          });
          loadAppData().then(function () {
            if (failedInvites.length) { showToast('Erreur : ajout impossible pour ' + failedInvites.join(', ') + ' — réessaie depuis "gérer les membres".'); return; }
            var msgParts = [];
            if (withEmail.length) msgParts.push('invitations envoyées par e-mail');
            if (linked.length || withoutEmail.length) msgParts.push((linked.length + withoutEmail.length) > 1 ? 'membres ajoutés' : 'membre ajouté');
            showToast(msgParts.length ? 'Groupe créé, ' + msgParts.join(' et ') : 'Groupe créé');
          });
        });
      });
    });
  }
  function openConfirmDeleteGroup(groupId) { setState({ showGroupMenu: false, showConfirmDeleteGroup: true, confirmDeleteGroupId: groupId }); }
  function confirmDeleteGroup() {
    var groupId = state.confirmDeleteGroupId;
    if (!groupId) return;
    sb.from('groups').delete().eq('id', groupId).then(function (res) {
      if (res.error) { showToast('Erreur : ' + res.error.message); return; }
      setState({ screen: 'groups', navStack: [], showConfirmDeleteGroup: false, confirmDeleteGroupId: null });
      loadAppData().then(function () { showToast('Groupe supprimé'); });
    });
  }
  // ---------- Lien d'invitation par groupe (cf. renderShareLinkModal /
  // join-group Edge Function / renderJoinScreen) ----------
  // onDone (optionnel) : appelé une fois le token confirmé en base — sert à
  // enchaîner sur le partage natif (cf. shareInviteLink) sans dupliquer la
  // logique de génération pour autant.
  function generateShareLink(onDone) {
    var groupId = state.shareLinkGroupId;
    if (!groupId) return;
    var token = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : (String(Date.now()) + Math.random().toString(36).slice(2));
    // Régénérer révoque l'ancien lien du même coup : join-group cherche une
    // correspondance exacte sur share_token, l'ancienne valeur ne pointe
    // donc plus vers rien une fois remplacée.
    sb.from('groups').update({ share_token: token }).eq('id', groupId).then(function (res) {
      if (res.error) { showToast('Erreur : ' + res.error.message); return; }
      // Patch local plutôt qu'un loadAppData() complet : évite de faire
      // disparaître cette modale derrière l'écran de chargement pour une
      // simple mise à jour d'un seul champ.
      setState(function (s) {
        return { groups: s.groups.map(function (g) { return g.id === groupId ? Object.assign({}, g, { shareToken: token }) : g; }) };
      });
      if (onDone) onDone();
    });
  }
  // Action principale du menu du groupe (cf. renderGroupMenuTrigger) : un
  // seul tap plutôt que "ouvrir la modale puis générer puis copier" — génère
  // le lien silencieusement s'il n'existe pas encore, puis propose le
  // partage natif du système (feuille de partage iOS/Android/desktop) quand
  // disponible. La modale (copier/régénérer/désactiver) reste le repli sur
  // les navigateurs sans Web Share API, mais s'ouvre alors directement sur
  // le lien déjà prêt, sans étape "Générer un lien" à cliquer en premier.
  function shareInviteLink(groupId) {
    setState({ showGroupMenu: false, shareLinkGroupId: groupId });
    var g = group(groupId);
    if (!g) return;
    var proceed = function () {
      var freshG = group(groupId);
      if (!freshG || !freshG.shareToken) return;
      var url = APP_URL + '?join=' + freshG.shareToken;
      if (navigator.share) {
        // catch silencieux : navigator.share rejette aussi quand la personne
        // annule elle-même la feuille de partage, pas seulement en cas
        // d'erreur réelle — rien à signaler dans ce cas.
        navigator.share({ title: 'Rejoins ' + freshG.name + ' sur Rohy', url: url }).catch(function () {});
      } else {
        setState({ showShareLink: true });
      }
    };
    if (g.shareToken) { proceed(); return; }
    generateShareLink(proceed);
  }
  function disableShareLink() {
    var groupId = state.shareLinkGroupId;
    if (!groupId) return;
    sb.from('groups').update({ share_token: null }).eq('id', groupId).then(function (res) {
      if (res.error) { showToast('Erreur : ' + res.error.message); return; }
      setState(function (s) {
        return { groups: s.groups.map(function (g) { return g.id === groupId ? Object.assign({}, g, { shareToken: null }) : g; }) };
      });
      showToast('Lien désactivé');
    });
  }
  function copyShareLink() {
    var g = group(state.shareLinkGroupId);
    if (!g || !g.shareToken) return;
    var url = APP_URL + '?join=' + g.shareToken;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { showToast('Lien copié'); }).catch(function () { showToast("Impossible de copier — sélectionne et copie-le manuellement."); });
    } else {
      showToast('Copie non supportée sur ce navigateur.');
    }
  }

  // Relance affichée une fois, après la première dépense d'un compte
  // anonyme (cf. tryWithoutAccount) : avant, il n'y a encore rien de réel à
  // perdre ; après, le groupe a un vrai historique financier qui mérite
  // d'être protégé par un compte.
  function maybeShowUpgradeNudge() {
    if (!state.isAnonymous || loadUpgradeNudgeDismissed()) return;
    setState({ showUpgradeNudge: true });
  }
  function dismissUpgradeNudge() {
    saveUpgradeNudgeDismissed();
    setState({ showUpgradeNudge: false });
  }

  // Bannière "rappel reçu" sur l'accueil (cf. renderHome) : le plus récent
  // rappel où l'utilisateur connecté est destinataire (RLS reminders_select
  // l'autorise déjà à le lire), tant qu'il n'a pas été ignoré.
  function mostRecentReminderForMe() {
    var dismissed = loadDismissedReminderIds();
    var debts = computeDebts();
    var mine = state.reminders.filter(function (r) {
      if (r.toPersonId !== state.currentUserId || dismissed.indexOf(r.id) !== -1) return false;
      // Un rappel dont la dette est déjà soldée (solde revenu à jour depuis)
      // n'a plus lieu d'être affiché — même logique que .reminder-preview
      // sur la fiche d'un membre.
      if (!r.fromPersonId) return true;
      return pairNet(state.currentUserId, r.fromPersonId, debts) < -0.5;
    });
    if (!mine.length) return null;
    return mine.slice().sort(function (a, b) { return b.date.localeCompare(a.date); })[0];
  }
  function dismissReminderBanner(id) {
    saveDismissedReminderId(id);
    render();
  }

  // ---------- Avis (cf. supabase/migrations/0018_feedback.sql) ----------
  // Sans store (App Store/Play Store), pas de mécanisme de notation intégré
  // à l'app — ce petit formulaire compense, déclenché juste après un
  // règlement réussi (un moment de valeur, contrairement à la déconnexion
  // qui est un moment de sortie où l'utilisateur veut juste partir), et
  // sinon accessible à tout moment depuis le menu compte.
  function maybeShowFeedbackPrompt() {
    if (Date.now() - loadFeedbackLastShown() < FEEDBACK_PROMPT_COOLDOWN_MS) return;
    saveFeedbackLastShown();
    setState({ showFeedback: true, feedbackContext: 'settle', feedbackRating: 0, feedbackComment: '', feedbackError: null });
  }
  function openFeedbackFromMenu() {
    setState({ showAccount: false, showFeedback: true, feedbackContext: 'menu', feedbackRating: 0, feedbackComment: '', feedbackError: null });
  }
  function setFeedbackRating(n) { setState({ feedbackRating: parseInt(n, 10) || 0, feedbackError: null }); }
  function setFeedbackComment(v) { setStateSilent(function (s) { return { feedbackComment: v }; }); }
  function submitFeedback() {
    if (!state.feedbackRating) { setState({ feedbackError: 'Choisis une note avant d\'envoyer.' }); return; }
    setState({ feedbackSubmitting: true, feedbackError: null });
    sb.from('feedback').insert({
      user_id: state.currentUserId, rating: state.feedbackRating,
      comment: state.feedbackComment.trim() || null, context: state.feedbackContext,
    }).then(function (res) {
      if (res.error) { setState({ feedbackSubmitting: false, feedbackError: res.error.message }); return; }
      setState({ showFeedback: false, feedbackSubmitting: false, feedbackContext: null, feedbackRating: 0, feedbackComment: '' });
      showToast('Merci pour ton avis !');
    });
  }

  // ---------- Compte anonyme → compte permanent (cf. performJoin) ----------
  function openUpgradeAccount() {
    var cu = person(state.currentUserId);
    setState({
      showUpgradeAccount: true, upgradeError: null,
      upgradeForm: { name: (cu && cu.name && cu.name !== 'Invité') ? cu.name : '', email: '', password: '' },
    });
  }
  function setUpgradeName(v) { setStateSilent(function (s) { return { upgradeForm: Object.assign({}, s.upgradeForm, { name: v }), upgradeError: null }; }); }
  function setUpgradeEmail(v) { setStateSilent(function (s) { return { upgradeForm: Object.assign({}, s.upgradeForm, { email: v }), upgradeError: null }; }); }
  function setUpgradePassword(v) { setStateSilent(function (s) { return { upgradeForm: Object.assign({}, s.upgradeForm, { password: v }), upgradeError: null }; }); }
  function submitUpgradeAccount() {
    var f = state.upgradeForm;
    if (!f.name.trim()) { setState({ upgradeError: 'Entre ton prénom.' }); return; }
    if (!f.email.trim() || f.email.indexOf('@') === -1) { setState({ upgradeError: 'Entre un e-mail valide.' }); return; }
    if (!f.password || f.password.length < 8) { setState({ upgradeError: 'Mot de passe trop court (8 caractères min).' }); return; }
    setState({ upgradeSubmitting: true, upgradeError: null });
    // updateUser() sur une session anonyme la transforme en compte permanent
    // EN PLACE (même id, donc même historique) plutôt que d'en créer un
    // nouveau — c'est le mécanisme officiel de Supabase pour ce cas.
    sb.auth.updateUser({ email: f.email.trim(), password: f.password }).then(function (res) {
      if (res.error) { setState({ upgradeSubmitting: false, upgradeError: res.error.message }); return; }
      sb.from('profiles').update({ name: f.name.trim() }).eq('id', state.currentUserId).then(function (profRes) {
        saveUpgradeNudgeDismissed();
        setState({ upgradeSubmitting: false, showUpgradeAccount: false, showUpgradeNudge: false, upgradeForm: { name: '', email: '', password: '' } });
        if (profRes.error) { showToast('Compte mis à jour, mais erreur sur le prénom : ' + profRes.error.message); return; }
        loadAppData();
        showToast("Compte créé — si une confirmation par e-mail est activée, vérifie ta boîte mail avant de te reconnecter avec ce mot de passe.");
      });
    });
  }

  // ---------- Modifier mon prénom ----------
  function openEditProfile() {
    var cu = person(state.currentUserId);
    setState({ showEditProfile: true, showAccount: false, editProfileError: null, editProfileName: cu ? cu.name : '' });
  }
  function setEditProfileName(v) { setStateSilent({ editProfileName: v, editProfileError: null }); }
  function cancelEditProfile() { setState({ showEditProfile: false }); }
  function submitEditProfile() {
    var name = (state.editProfileName || '').trim();
    if (!name) { setState({ editProfileError: 'Entre un prénom.' }); return; }
    setState({ editProfileSubmitting: true, editProfileError: null });
    sb.from('profiles').update({ name: name }).eq('id', state.currentUserId).then(function (res) {
      if (res.error) { setState({ editProfileSubmitting: false, editProfileError: res.error.message }); return; }
      setState({ showEditProfile: false, editProfileSubmitting: false });
      loadAppData().then(function () { showToast('Prénom mis à jour'); });
    });
  }

  function openManageMembers(groupId) { setState({ showGroupMenu: false, showManageMembers: true, manageMembersGroupId: groupId, manageMembersSearchQuery: '' }); }
  function setManageMembersSearch(v) { setState({ manageMembersSearchQuery: v }); }
  function toggleAddMemberForm() {
    setState(function (s) {
      return {
        showAddMemberForm: !s.showAddMemberForm,
        formError: null,
        addMemberForm: { name: '', email: '', shareWeight: '1', guardianId: null, linkExistingId: null },
      };
    });
  }
  // Cf. le commentaire de setInviteeName : ne patcher que le conteneur sous
  // le champ "Prénom" (data-add-member-below), jamais le champ lui-même,
  // pour ne plus jamais perturber le clavier virtuel mobile pendant la
  // frappe — y compris lors des pauses (le debounce à lui seul ne suffisait
  // pas, un render() complet reste un render() complet).
  function setAddMemberName(v) {
    setStateSilent(function (s) { return { addMemberForm: Object.assign({}, s.addMemberForm, { name: v, linkExistingId: null }) }; });
    clearTimeout(addMemberNameDebounceTimer);
    addMemberNameDebounceTimer = setTimeout(function () {
      var root = document.getElementById('app');
      var below = root.querySelector('[data-add-member-below]');
      if (below) below.innerHTML = addMemberBelowNameHtml();
    }, 300);
  }
  function setAddMemberEmail(v) { setStateSilent(function (s) { return { addMemberForm: Object.assign({}, s.addMemberForm, { email: v }) }; }); }
  function setAddMemberWeight(v) { setStateSilent(function (s) { return { addMemberForm: Object.assign({}, s.addMemberForm, { shareWeight: v }) }; }); }
  function setAddMemberGuardian(v) { setState(function (s) { return { addMemberForm: Object.assign({}, s.addMemberForm, { guardianId: v || null }) }; }); }
  // Suggère les profils sans compte (donc sans e-mail) déjà créés par
  // l'utilisateur courant dans d'autres groupes, pour éviter de recréer un
  // doublon d'une personne déjà connue (ex. "Avana" déjà membre d'un autre
  // groupe) — sans e-mail, l'app n'a sinon aucun moyen de la reconnaître.
  function guestSuggestionsFor(query, excludeIds) {
    var q = (query || '').trim().toLowerCase();
    if (q.length < 2) return [];
    return state.people.filter(function (p) {
      if (p.hasAccount || p.createdBy !== state.currentUserId) return false;
      if (excludeIds && excludeIds.indexOf(p.id) !== -1) return false;
      return p.name.toLowerCase().indexOf(q) !== -1;
    }).slice(0, 5);
  }
  // Contenu sous le champ "Prénom" d'une ligne d'invité (suggestions de
  // profils existants, ou bandeau "déjà lié·e", ou champs e-mail/part) —
  // extrait dans sa propre fonction pour pouvoir le rafraîchir isolément
  // (cf. setInviteeName) sans reconstruire tout le DOM de la modale, donc
  // sans jamais recréer le champ "Prénom" lui-même pendant la frappe.
  function inviteeBelowNameHtml(index) {
    var gf = state.groupForm;
    var inv = gf.invitees[index];
    if (!inv) return '';
    var linkedProfile = inv.linkExistingId ? person(inv.linkExistingId) : null;
    var otherLinkedIds = gf.invitees.filter(function (_, j) { return j !== index; })
      .map(function (x) { return x.linkExistingId; }).filter(Boolean);
    var suggestions = (!linkedProfile && !inv.email.trim()) ? guestSuggestionsFor(inv.name, otherLinkedIds) : [];
    return (
      (suggestions.length ?
        '<div style="margin:-4px 0 10px">' +
        suggestions.map(function (s) {
          return '<div class="dashed-btn pressable" style="text-align:left;padding:8px 12px;margin-top:4px" data-action="selectExistingGuestForInvitee" data-group-id="' + index + '" data-id="' + s.id + '"><i class="ph-bold ph-user-circle" style="margin-right:6px"></i>' + escapeHtml(s.name) + ' — déjà ajouté·e dans un autre groupe, lier plutôt que recréer</div>';
        }).join('') +
        '</div>' : '') +
      (linkedProfile ?
        '<div style="background:var(--status-positive-bg);border-radius:10px;padding:10px 12px;font-size:12.5px;color:var(--text-primary)">' +
        '<i class="ph-bold ph-link" style="margin-right:6px;color:var(--status-positive)"></i>' + escapeHtml(linkedProfile.name) + ' (déjà connu·e) sera ajouté·e avec sa part habituelle actuelle (' + String(linkedProfile.shareWeight != null ? linkedProfile.shareWeight : 1).replace('.', ',') + ').' +
        '<span class="delete-link" style="display:inline;margin-left:4px" data-action="unlinkExistingGuestForInvitee" data-id="' + index + '">Annuler</span>' +
        '</div>' :
        '<input class="text-input" type="email" data-bind="inviteeEmail" data-id="' + index + '" placeholder="E-mail (facultatif)" value="' + escapeHtml(inv.email) + '" style="margin-bottom:8px" />' +
        '<div style="display:flex;align-items:center;gap:8px">' +
        '<span style="font-size:12.5px;color:var(--text-secondary)">Part habituelle (1 = part entière)</span>' +
        '<input class="child-percent-input" data-bind="inviteeShare" data-id="' + index + '" value="' + escapeHtml(inv.shareWeight) + '" inputmode="decimal" />' +
        '</div>')
    );
  }
  // Même principe que inviteeBelowNameHtml, pour le formulaire "+ ajouter un
  // membre" de "Gérer les membres".
  function addMemberBelowNameHtml() {
    var mg = group(state.manageMembersGroupId);
    var members = mg ? mg.memberIds.map(function (id) { return person(id); }).filter(Boolean) : [];
    var linkedGuestProfile = state.addMemberForm.linkExistingId ? person(state.addMemberForm.linkExistingId) : null;
    var guestSuggestions = (!linkedGuestProfile && !state.addMemberForm.email.trim())
      ? guestSuggestionsFor(state.addMemberForm.name, members.map(function (x) { return x.id; }))
      : [];
    return (
      (guestSuggestions.length ?
        '<div style="margin:-8px 0 12px">' +
        guestSuggestions.map(function (s) {
          return '<div class="dashed-btn pressable" style="text-align:left;padding:8px 12px;margin-top:4px" data-action="selectExistingGuestForAddMember" data-id="' + s.id + '"><i class="ph-bold ph-user-circle" style="margin-right:6px"></i>' + escapeHtml(s.name) + ' — déjà ajouté·e dans un autre groupe, lier plutôt que recréer</div>';
        }).join('') +
        '</div>' : '') +
      (linkedGuestProfile ?
        '<div style="background:var(--status-positive-bg);border-radius:10px;padding:10px 12px;margin-bottom:14px;font-size:12.5px;color:var(--text-primary)">' +
        '<i class="ph-bold ph-link" style="margin-right:6px;color:var(--status-positive)"></i>' + escapeHtml(linkedGuestProfile.name) + ' (déjà connu·e) sera ajouté·e à ce groupe avec sa part habituelle actuelle (' + String(linkedGuestProfile.shareWeight != null ? linkedGuestProfile.shareWeight : 1).replace('.', ',') + ').' +
        '<span class="delete-link" style="display:inline;margin-left:4px" data-action="unlinkExistingGuestForAddMember">Annuler</span>' +
        '</div>' :
        '<div class="field-label">E-mail (facultatif)</div>' +
        '<input class="text-input" type="email" data-bind="addMemberEmail" placeholder="Pour envoyer une invitation" value="' + escapeHtml(state.addMemberForm.email) + '" />' +
        '<div style="font-size:11.5px;color:var(--text-tertiary);margin:-10px 0 14px">Si renseigné, un e-mail d\'invitation est envoyé pour que cette personne puisse se connecter elle-même ; sinon, elle est simplement ajoutée au groupe.</div>' +
        '<div class="field-label">Part habituelle (1 = part entière)</div>' +
        '<input class="text-input" data-bind="addMemberWeight" inputmode="decimal" value="' + escapeHtml(state.addMemberForm.shareWeight) + '" />' +
        '<div class="field-label">Responsable (facultatif)</div>' +
        '<select class="text-input" data-bind-change="addMemberGuardian">' +
        '<option value="">— Aucun —</option>' +
        members.map(function (x) { return '<option value="' + x.id + '"' + (state.addMemberForm.guardianId === x.id ? ' selected' : '') + '>' + escapeHtml(x.name) + '</option>'; }).join('') +
        '</select>')
    );
  }
  function selectExistingGuestForAddMember(profileId) {
    var p = person(profileId);
    if (!p) return;
    setState(function (s) { return { addMemberForm: Object.assign({}, s.addMemberForm, { name: p.name, linkExistingId: profileId }) }; });
  }
  function unlinkExistingGuestForAddMember() {
    setState(function (s) { return { addMemberForm: Object.assign({}, s.addMemberForm, { linkExistingId: null }) }; });
  }
  // L'e-mail est facultatif : renseigné, il déclenche un vrai e-mail
  // d'invitation (compte réel créé pour cette personne) ; laissé vide, on
  // crée juste un profil sans compte, ajouté directement au groupe (utile
  // pour quelqu'un qui ne se connectera jamais à l'app, avec ou sans
  // responsable qui couvre ses dépenses).
  function submitAddMember() {
    if (state.addingMember) return;
    var f = state.addMemberForm;
    var groupId = state.manageMembersGroupId;
    if (!f.name.trim()) { setState({ formError: 'Donne un prénom.' }); return; }
    if (f.email.trim() && f.email.indexOf('@') === -1) { setState({ formError: 'E-mail invalide.' }); return; }
    var w = parseFloat((f.shareWeight || '1').replace(',', '.'));
    if (isNaN(w) || w < 0) { setState({ formError: 'Nombre de parts invalide.' }); return; }
    setState({ formError: null });

    function finish(msg) {
      setState({ showAddMemberForm: false, addMemberForm: { name: '', email: '', shareWeight: '1', guardianId: null, linkExistingId: null } });
      loadAppData().then(function () { showToast(msg); });
    }

    if (f.linkExistingId) {
      setState({ addingMember: true });
      sb.from('group_members').insert({ group_id: groupId, user_id: f.linkExistingId }).then(function (memRes) {
        setState({ addingMember: false });
        if (memRes.error) { setState({ formError: memRes.error.message }); return; }
        finish('Membre ajouté');
      });
      return;
    }

    if (f.email.trim()) {
      setState({ addingMember: true });
      var color = INVITEE_COLORS[state.people.length % INVITEE_COLORS.length];
      inviteMemberToGroup(groupId, f.name.trim(), f.email.trim(), f.shareWeight, color).then(function (result) {
        setState({ addingMember: false });
        if (!result.ok) { setState({ formError: 'Invitation impossible : ' + result.failure }); return; }
        if (f.guardianId && result.userId) {
          sb.from('profiles').update({ guardian_id: f.guardianId }).eq('id', result.userId).then(function () {
            finish('Invitation envoyée par e-mail');
          });
        } else {
          finish('Invitation envoyée par e-mail');
        }
      });
      return;
    }

    sb.from('profiles').insert({
      name: f.name.trim(), color: INVITEE_COLORS[state.people.length % INVITEE_COLORS.length],
      share_weight: w, guardian_id: f.guardianId || null, created_by: state.currentUserId,
    }).select().single().then(function (res) {
      if (res.error) { setState({ formError: res.error.message }); return; }
      sb.from('group_members').insert({ group_id: groupId, user_id: res.data.id }).then(function (memRes) {
        if (memRes.error) { showToast('Erreur : ' + memRes.error.message); return; }
        finish('Membre ajouté');
      });
    });
  }
  function openConfirmRemoveMember(groupId, personId) {
    var g = group(groupId);
    if (!g || personId === g.adminId) return;
    setState({ showConfirmRemoveMember: true, confirmRemoveMemberGroupId: groupId, confirmRemoveMemberId: personId });
  }
  function cancelRemoveMember() { setState({ showConfirmRemoveMember: false, confirmRemoveMemberGroupId: null, confirmRemoveMemberId: null }); }
  function confirmRemoveMember() {
    var groupId = state.confirmRemoveMemberGroupId;
    var personId = state.confirmRemoveMemberId;
    if (!groupId || !personId) return;
    sb.from('group_members').delete().eq('group_id', groupId).eq('user_id', personId).then(function (res) {
      if (res.error) { showToast('Erreur : ' + res.error.message); return; }
      setState({ showConfirmRemoveMember: false, confirmRemoveMemberGroupId: null, confirmRemoveMemberId: null });
      loadAppData().then(function () { showToast('Membre retiré du groupe'); });
    });
  }
  function openConfirmLeaveGroup(groupId) {
    var g = group(groupId);
    if (!g || g.adminId === state.currentUserId) return;
    setState({ showGroupMenu: false, showConfirmLeaveGroup: true, confirmLeaveGroupId: groupId });
  }
  function cancelLeaveGroup() { setState({ showConfirmLeaveGroup: false, confirmLeaveGroupId: null }); }
  function confirmLeaveGroup() {
    var groupId = state.confirmLeaveGroupId;
    if (!groupId) return;
    sb.from('group_members').delete().eq('group_id', groupId).eq('user_id', state.currentUserId).then(function (res) {
      if (res.error) { showToast('Erreur : ' + res.error.message); return; }
      setState({ showConfirmLeaveGroup: false, confirmLeaveGroupId: null, screen: 'groups', navStack: [], selectedGroupId: null });
      loadAppData().then(function () { showToast('Tu as quitté le groupe'); });
    });
  }
  // Déclenché quand setMemberEmail échoue sur profiles_email_unique : cette
  // adresse appartient déjà à un vrai compte ailleurs, probablement la même
  // personne que cet invité. Propose de fusionner (cf. merge-guest-profile)
  // plutôt que de bloquer sans solution.
  function openConfirmMergeGuest(guestId, email) {
    setState({ showConfirmMergeGuest: true, confirmMergeGuestId: guestId, confirmMergeGuestEmail: email });
  }
  function cancelMergeGuest() {
    setState({ showConfirmMergeGuest: false, confirmMergeGuestId: null, confirmMergeGuestEmail: '' });
  }
  function confirmMergeGuest() {
    if (state.mergingGuest) return;
    var guestId = state.confirmMergeGuestId, email = state.confirmMergeGuestEmail;
    if (!guestId || !email) return;
    setState({ mergingGuest: true });
    sb.functions.invoke('merge-guest-profile', { body: { guestId: guestId, targetEmail: email } }).then(function (res) {
      return extractFunctionErrorMessage(res).then(function (errMsg) {
        if (errMsg) throw new Error(errMsg);
        var targetName = res.data && res.data.targetName;
        setState({ showConfirmMergeGuest: false, confirmMergeGuestId: null, confirmMergeGuestEmail: '', mergingGuest: false });
        loadAppData().then(function () {
          showToast(targetName ? 'Fusionné avec le compte de ' + targetName : 'Fusion effectuée');
        });
      });
    }).catch(function (err) {
      setState({ mergingGuest: false });
      showToast('Erreur : ' + (err && err.message ? err.message : 'fusion impossible'));
    });
  }
  function setShareWeight(personId, value) {
    var w = parseFloat(String(value).replace(',', '.'));
    if (isNaN(w) || w < 0) return;
    sb.from('profiles').update({ share_weight: w }).eq('id', personId).then(function (res) {
      if (res.error) { showToast('Erreur : ' + res.error.message); return; }
      loadAppData();
    });
  }
  function setGuardian(personId, guardianId) {
    if (guardianId === personId) return;
    sb.from('profiles').update({ guardian_id: guardianId || null }).eq('id', personId).then(function (res) {
      if (res.error) { showToast('Erreur : ' + res.error.message); return; }
      loadAppData();
    });
  }
  function setMemberHousehold(personId, householdId) {
    sb.from('profiles').update({ household_id: householdId || null }).eq('id', personId).then(function (res) {
      if (res.error) { showToast('Erreur : ' + res.error.message); return; }
      loadAppData();
    });
  }
  // Uniquement pour un profil sans compte (invité) : un membre avec un vrai
  // compte a son e-mail lié à sa connexion Supabase Auth, pas modifiable
  // depuis ici (cf. renderManageMembersModal, qui n'affiche ce champ en
  // éditable que pour !hasAccount). Permet notamment d'activer après coup
  // l'envoi d'un vrai e-mail de rappel (send-reminder) à un invité qui
  // n'avait pas d'adresse renseignée à sa création.
  function setMemberEmail(personId, value) {
    var trimmed = (value || '').trim();
    if (trimmed && trimmed.indexOf('@') === -1) { showToast('Entre un e-mail valide.'); return; }
    sb.from('profiles').update({ email: trimmed || null }).eq('id', personId).then(function (res) {
      if (res.error) {
        // Contrainte profiles_email_unique (migration 0011) : deux profils
        // ne peuvent pas partager la même adresse — le cas le plus courant
        // est un invité dont on découvre après coup qu'il a déjà un vrai
        // compte ailleurs, plutôt qu'un vrai doublon accidentel. On propose
        // de fusionner (cf. openConfirmMergeGuest) plutôt que de bloquer net.
        if (res.error.code === '23505') { openConfirmMergeGuest(personId, trimmed); return; }
        showToast('Erreur : ' + res.error.message);
        return;
      }
      loadAppData().then(function () { showToast(trimmed ? 'E-mail enregistré' : 'E-mail retiré'); });
    });
  }
  function setNewHouseholdName(v) { setStateSilent({ newHouseholdName: v }); }
  function createHousehold() {
    var name = (state.newHouseholdName || '').trim();
    if (!name) return;
    sb.from('households').insert({ name: name, created_by: state.currentUserId, group_id: state.manageMembersGroupId }).then(function (res) {
      if (res.error) { showToast('Erreur : ' + res.error.message); return; }
      setState({ newHouseholdName: '' });
      loadAppData().then(function () { showToast('Foyer créé'); });
    });
  }
  function renameHousehold(householdId, name) {
    var trimmed = (name || '').trim();
    if (!trimmed) { showToast('Le nom du foyer ne peut pas être vide.'); return; }
    sb.from('households').update({ name: trimmed }).eq('id', householdId).then(function (res) {
      if (res.error) { showToast('Erreur : ' + res.error.message); return; }
      loadAppData().then(function () { showToast('Foyer renommé'); });
    });
  }

  // ---------- Modales ----------
  function openAccount() { setState({ showAccount: true }); }
  function toggleGroupMenu() { setState(function (s) { return { showGroupMenu: !s.showGroupMenu }; }); }
  function closeModal() {
    lastModalScrollTop = null;
    setState({
      showAddExpense: false, showAddGroup: false, showSettle: false, showAccount: false, showGroupMenu: false, showManageMembers: false,
      showExpenseFilters: false,
      showConfirmDeleteGroup: false, confirmDeleteGroupId: null, formError: null,
      showConfirmRemoveMember: false, confirmRemoveMemberGroupId: null, confirmRemoveMemberId: null,
      showConfirmLeaveGroup: false, confirmLeaveGroupId: null,
      showConfirmMergeGuest: false, confirmMergeGuestId: null, confirmMergeGuestEmail: '',
      showConfirmDeleteAccount: false,
      showConfirmSwitchAccount: false,
      showEditProfile: false, editProfileError: null,
      showReminderConfirm: false, showShareLink: false, shareLinkGroupId: null,
      showUpgradeAccount: false, upgradeError: null, upgradeForm: { name: '', email: '', password: '' },
      settleGroupId: null, showAddMemberForm: false,
      showFeedback: false, feedbackContext: null, feedbackError: null,
    });
  }

  // ---------- Rendu ----------

  function captureFocus(root) {
    var active = document.activeElement;
    if (!active || !root.contains(active)) return null;
    var bind = active.getAttribute('data-bind') || active.getAttribute('data-bind-change');
    if (!bind) return null;
    return {
      bind: bind,
      id: active.getAttribute('data-id'),
      selStart: active.selectionStart,
      selEnd: active.selectionEnd,
    };
  }

  function restoreFocus(root, info) {
    if (!info) return;
    var attr = 'data-bind';
    var el = root.querySelector('[' + attr + '="' + info.bind + '"]' + (info.id ? '[data-id="' + info.id + '"]' : ''));
    if (!el) el = root.querySelector('[data-bind-change="' + info.bind + '"]' + (info.id ? '[data-id="' + info.id + '"]' : ''));
    if (!el) return;
    el.focus();
    if (typeof info.selStart === 'number' && el.setSelectionRange) {
      try { el.setSelectionRange(info.selStart, info.selEnd); } catch (err) { /* input type sans sélection texte */ }
    }
  }

  // Persiste au-delà d'un seul appel à render() : une modification dans une
  // modale (ex. changer le foyer d'un membre) déclenche un loadAppData(),
  // qui affiche brièvement l'écran de chargement (la modale disparaît du
  // DOM) avant de la recréer une fois les données rechargées. Sans ça, la
  // modale recréée repart toujours en haut, ce qui donne l'impression que
  // la page "s'est rechargée" et a perdu la modification qu'on venait de
  // faire plus bas dans la liste.
  var lastModalScrollTop = null;

  // Scroll-reveal de la landing (cf. sections [data-reveal] dans
  // renderAboutScreen) : ces deux variables vivent hors de render() et
  // survivent donc à chaque reconstruction complète du DOM (innerHTML) —
  // sans quoi une section déjà révélée réapparaîtrait masquée puis rejouerait
  // son animation à la moindre action sans rapport (changer de langue,
  // ouvrir un menu...) qui déclenche un nouveau render().
  var scrollRevealedIds = Object.create(null);
  var scrollRevealObserver = null;

  function initScrollReveal(root) {
    var els = root.querySelectorAll('[data-reveal]');
    if (!els.length) return;
    if (scrollRevealObserver) scrollRevealObserver.disconnect();
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (var i = 0; i < els.length; i++) els[i].classList.add('reveal-visible');
      return;
    }
    scrollRevealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var revealId = entry.target.getAttribute('data-reveal');
        scrollRevealedIds[revealId] = true;
        entry.target.classList.remove('reveal-hidden');
        entry.target.classList.add('reveal-visible');
        scrollRevealObserver.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    els.forEach(function (el) {
      if (scrollRevealedIds[el.getAttribute('data-reveal')]) {
        el.classList.add('reveal-visible');
      } else {
        el.classList.add('reveal-hidden');
        scrollRevealObserver.observe(el);
      }
    });
  }

  function render() {
    var root = document.getElementById('app');
    // Le chargement de session/données continue en arrière-plan pendant
    // l'écran de lancement et déclenche son propre render() (setState) —
    // sans ce garde, chaque appel recréerait le DOM de l'écran de lancement
    // (innerHTML) et relancerait donc son animation depuis le début. Une
    // fois affiché, on le laisse simplement jouer jusqu'au bout, quel que
    // soit le nombre de render() déclenchés entretemps par autre chose.
    if (state.showSplash) {
      if (!root.querySelector('.splash-screen')) {
        root.setAttribute('data-theme', state.theme);
        document.documentElement.setAttribute('data-theme', state.theme);
        root.innerHTML = renderSplashScreen();
      }
      return;
    }
    var focusInfo = captureFocus(root);
    var priorModalSheet = root.querySelector('.modal-sheet');
    if (priorModalSheet) lastModalScrollTop = priorModalSheet.scrollTop;
    root.setAttribute('data-theme', state.theme);
    // <html> porte aussi data-theme (pas seulement .app-frame) pour que le
    // fond de <body>, résolu hors du scope de la carte, corresponde toujours
    // au thème actif plutôt qu'à la valeur par défaut (sombre) de :root.
    document.documentElement.setAttribute('data-theme', state.theme);
    // Un re-rendu reconstruit tout le sous-arbre DOM (innerHTML) : la
    // transition CSS globale (background-color/border-color) rejoue alors
    // sur les nœuds fraîchement créés, provoquant un flash visuel. On la
    // désactive le temps du remplacement, puis on la réactive à la frame
    // suivante (une fois les nouveaux nœuds en place, rien à transitionner).
    root.classList.add('no-transition');
    var mainHtml;
    var showingAppShell = false;
    if (state.accountJustDeleted) {
      // Priorité absolue : ce drapeau survit volontairement à la
      // réinitialisation d'état déclenchée par SIGNED_OUT (cf.
      // confirmDeleteAccount) — sans ce court-circuit, la branche
      // !state.loggedIn plus bas reprendrait la main dès ce même render().
      mainHtml = renderAccountDeletedScreen();
    } else if (state.passwordRecovery) {
      mainHtml = renderNewPasswordScreen();
    } else if (state.joinToken) {
      // Lien d'invitation ouvert (cf. renderJoinScreen) : passe devant tout
      // le reste, connecté ou non — se referme de lui-même une fois la
      // personne ajoutée au groupe (performJoin remet joinToken à null).
      mainHtml = renderJoinScreen();
    } else if (state.screen === 'privacy' && (!state.loggedIn || !state.enteredApp)) {
      // Politique de confidentialité ouverte depuis la landing (avant
      // connexion, ou connecté mais pas encore entré dans l'app) : même cas
      // que renderAboutFromLogin ci-dessous, qui ignore state.screen — celui-
      // ci doit donc être intercepté ici pour ne pas être écrasé par
      // renderAboutFromLogin(). Une fois entré dans l'app, ce même écran est
      // servi normalement par renderContent() (case 'privacy').
      mainHtml = renderPrivacyStandalone();
    } else if (!state.loggedIn) {
      mainHtml = state.showLoginForm ? renderLogin() : renderAboutFromLogin();
    } else if (!state.enteredApp) {
      // Racine du site : toujours la landing en premier, même connecté (cf.
      // commentaire sur `enteredApp` dans defaultState) — le CTA "Ouvrir
      // l'app" de la nav/du hero (enterApp) fait passer à l'écran suivant.
      mainHtml = renderAboutFromLogin();
    } else if (state.dataLoading || !person(state.currentUserId)) {
      mainHtml = renderLoadingScreen();
    } else {
      mainHtml = renderApp();
      // Seul ce cas affiche .bottom-nav (cf. renderApp) : le bandeau de
      // consentement doit alors se loger juste au-dessus plutôt que la
      // recouvrir (cf. .consent-banner.above-nav, styles.css).
      showingAppShell = true;
    }
    // Bandeau de consentement mesure d'audience : superposé à n'importe quel
    // écran (sauf le lancement, déjà exclu plus haut) tant qu'aucun choix
    // n'a été fait — jamais affiché une fois state.analyticsConsent décidé
    // ('granted' ou 'denied'), cf. acceptAnalytics/declineAnalytics.
    root.innerHTML = mainHtml + (state.analyticsConsent === null ? renderConsentBanner(showingAppShell) : '');
    bindEvents(root);
    initScrollReveal(root);
    restoreFocus(root, focusInfo);
    var newModalSheet = root.querySelector('.modal-sheet');
    if (newModalSheet && lastModalScrollTop != null) newModalSheet.scrollTop = lastModalScrollTop;
    void root.offsetHeight;
    requestAnimationFrame(function () { root.classList.remove('no-transition'); });
  }

  // Écran de lancement : la marque se tisse bande par bande (3 verticales +
  // 3 horizontales), suivant la chorégraphie de la section "07 · Motion" du
  // design system (v1) : les verticales tombent d'en haut (cascade légère),
  // les horizontales entrent en ALTERNANCE gauche/droite/gauche à travers
  // elles, puis l'ensemble rebondit légèrement une fois assemblé (cf.
  // .splash-weave). Les découpes dans les bandes horizontales (fill-rule
  // evenodd) ne varient pas dans le temps : elles reproduisent le motif
  // tissé final (quelle bande passe au-dessus/en-dessous de quelle autre)
  // dès leur apparition — seuls la direction et l'ORDRE d'arrivée des 6
  // bandes (via animation-delay) donnent l'impression de tissage progressif.
  // Délai d'apparition par brin (cf. .splash-v/.splash-h-ltr/.splash-h-rtl,
  // styles.css) : réutilise LOGO_RECTS (la géométrie exacte du logo statique,
  // brins pleins + segments coupés aux croisements pour le vrai tissage
  // over/under) plutôt qu'une forme dédiée à l'écran de lancement — le motif
  // construit à l'ouverture est donc pixel pour pixel celui utilisé partout
  // ailleurs (footer, en-tête...), pas une approximation.
  function renderSplashScreen() {
    var rects = LOGO_RECTS.map(function (r, i) {
      var cls, delay;
      if (i < 3) { cls = 'splash-v'; delay = [0, .09, .18][i]; }
      else if (i < 5) { cls = 'splash-h-ltr'; delay = .5; }
      else if (i < 8) { cls = 'splash-h-rtl'; delay = .8; }
      else { cls = 'splash-h-ltr'; delay = 1.1; }
      return '<rect class="' + cls + '" x="' + r[0] + '" y="' + r[1] + '" width="' + r[2] + '" height="' + r[3] + '" rx="3" fill="#0F8F6B" stroke="#084b38" stroke-width="3" stroke-linecap="square" style="animation-delay:' + delay + 's"></rect>';
    }).join('');
    return (
      '<div class="splash-screen">' +
      '<div class="splash-row">' +
      // viewBox élargi (marge de 6 unités de chaque côté) plutôt que 0 0 100
      // 100 pile : le contour (stroke-width 3, centré sur le tracé) déborde
      // déjà de 1,5 unité de chaque côté à l'état statique, et le rebond final
      // (.splash-weave, scale jusqu'à 1.035) l'accentue encore — sans marge,
      // les extrémités des brins se retrouvaient rognées pile au bord du SVG.
      '<svg viewBox="-6 -6 112 112" width="100" height="100" aria-hidden="true">' +
      '<g class="splash-weave">' + rects + '</g>' +
      '</svg>' +
      '<div class="splash-text">' +
      '<div class="splash-wordmark">Rohy</div>' +
      '<div class="splash-tagline">Suivi des dépenses entre amis et en famille</div>' +
      '</div>' +
      '</div>' +
      '</div>'
    );
  }

  function renderLoadingScreen() {
    return '<div class="loading-screen">Chargement…</div>';
  }

  function renderLogin() {
    var f = state.loginForm;
    var body = '';
    if (state.loginMode === 'signup') {
      body =
        '<div class="field-label">Prénom</div>' +
        '<input class="text-input" data-bind="loginName" autocomplete="name" placeholder="Toi" value="' + escapeHtml(f.name) + '" />' +
        '<div class="field-label">E-mail</div>' +
        '<input class="text-input" type="email" autocomplete="email" data-bind="loginEmail" placeholder="toi@exemple.com" value="' + escapeHtml(f.email) + '" />' +
        '<div class="field-label">Mot de passe</div>' +
        '<input class="text-input" type="password" autocomplete="new-password" data-bind="loginPassword" placeholder="•••••••• (8 caractères min)" value="' + escapeHtml(f.password) + '" />' +
        '<button class="btn-primary pressable" data-action="submitSignup">Créer le compte</button>' +
        (state.loginError ? '<div class="form-error">' + escapeHtml(state.loginError) + '</div>' : '') +
        '<div class="link-center" style="margin-top:20px" data-action="showPasswordLogin">J\'ai déjà un compte →</div>' +
        // Option discrète plutôt qu'un CTA du hero (cf. discussion) : pas
        // envie de diluer le CTA principal de la landing, mais utile pour
        // qui hésite déjà à créer un compte au moment précis où on le lui demande.
        '<div class="link-center" style="margin-top:12px" data-action="tryWithoutAccount">Essayer sans compte →</div>';
    } else if (state.loginMode === 'password') {
      body =
        '<div class="field-label">E-mail</div>' +
        '<input class="text-input" type="email" autocomplete="email" data-bind="loginEmail" placeholder="toi@exemple.com" value="' + escapeHtml(f.email) + '" />' +
        '<div class="field-label">Mot de passe</div>' +
        '<input class="text-input" type="password" autocomplete="current-password" data-bind="loginPassword" placeholder="••••••••" value="' + escapeHtml(f.password) + '" />' +
        '<button class="btn-primary pressable" data-action="submitLogin">Se connecter</button>' +
        (state.loginError ? '<div class="form-error">' + escapeHtml(state.loginError) + '</div>' : '') +
        '<div class="link-center" style="margin-top:12px" data-action="showForgotPassword">Mot de passe oublié ?</div>' +
        '<div class="divider-or">Ou</div>' +
        '<div class="link-center" data-action="toggleLoginMode">Se connecter sans mot de passe →</div>' +
        '<div class="link-center" style="margin-top:12px" data-action="showSignup">Pas encore de compte ? En créer un →</div>';
    } else if (state.loginMode === 'forgotPassword') {
      body = state.resetSent ?
        '<div class="magic-confirm">' +
        '<div class="magic-icon"><i class="ph-bold ph-paper-plane-tilt"></i></div>' +
        '<div class="login-title" style="font-size:20px">E-mail envoyé !</div>' +
        '<div class="login-subtitle" style="line-height:1.5">Clique sur le lien reçu par e-mail pour choisir un nouveau mot de passe.</div>' +
        '<div class="link-center" style="margin-top:20px" data-action="showPasswordLogin">Retour</div>' +
        '</div>' :
        '<div class="field-label">E-mail</div>' +
        '<input class="text-input" type="email" autocomplete="email" data-bind="loginEmail" placeholder="toi@exemple.com" value="' + escapeHtml(f.email) + '" />' +
        '<button class="btn-primary pressable" data-action="submitForgotPassword">Envoyer le lien de réinitialisation</button>' +
        (state.loginError ? '<div class="form-error">' + escapeHtml(state.loginError) + '</div>' : '') +
        '<div class="link-center" style="margin-top:20px" data-action="showPasswordLogin">Retour à la connexion →</div>';
    } else if (state.magicSent) {
      body =
        '<div class="magic-confirm">' +
        '<div class="magic-icon"><i class="ph-bold ph-paper-plane-tilt"></i></div>' +
        '<div class="login-title" style="font-size:20px">Lien envoyé !</div>' +
        '<div class="login-subtitle" style="line-height:1.5">Clique sur le lien reçu par e-mail pour continuer.</div>' +
        '<div class="link-center" style="margin-top:20px" data-action="backToLoginForm">Retour</div>' +
        '</div>';
    } else {
      body =
        '<div class="field-label">E-mail</div>' +
        '<input class="text-input" type="email" autocomplete="email" data-bind="loginEmail" placeholder="toi@exemple.com" value="' + escapeHtml(f.email) + '" />' +
        '<button class="btn-primary pressable" data-action="submitMagicLink">Envoyer le lien</button>' +
        (state.loginError ? '<div class="form-error">' + escapeHtml(state.loginError) + '</div>' : '') +
        '<div class="link-center" style="margin-top:20px" data-action="toggleLoginMode">Se connecter avec un mot de passe →</div>';
    }
    return (
      '<div class="login-screen">' +
      '<div class="login-brand"><div class="login-icon">' + logoMark(30, '#0F8F6B', '#084b38') + '</div><span class="login-wordmark">Rohy</span></div>' +
      '<div class="login-title">Se connecter</div>' +
      '<div class="login-subtitle">Retrouve tes groupes et vos comptes</div>' +
      body +
      '<div class="login-footer-link pressable" data-action="goToLanding">← Retour à l\'accueil</div>' +
      '</div>'
    );
  }
  // Lien d'invitation par groupe (cf. renderGroupDetail → "Partager le lien
  // d'invitation", et l'Edge Function join-group) : à l'ouverture de
  // rohy-app.com/?join=<token>, montre "Vous rejoignez tel groupe" puis
  // ajoute la personne comme un vrai participant (compte anonyme si elle
  // n'était pas déjà connectée) — jamais de mot de passe à créer ici.
  function renderJoinScreen() {
    var preview = state.joinPreview;
    var body;
    if (!preview) {
      body = '<div class="login-subtitle" style="text-align:center">Chargement du lien d\'invitation…</div>';
    } else if (preview.error) {
      body =
        '<div class="login-subtitle" style="text-align:center">' + escapeHtml(preview.error) + '</div>' +
        '<div class="link-center" style="margin-top:20px" data-action="cancelJoin">← Retour à l\'accueil</div>';
    } else {
      var memberLine = preview.memberCount > 0
        ? preview.memberCount + (preview.memberCount > 1 ? ' participants déjà dans ce groupe.' : ' participant déjà dans ce groupe.')
        : 'Sois le premier à rejoindre ce groupe.';
      body =
        '<div class="login-subtitle" style="text-align:center;margin-bottom:18px">' + escapeHtml(memberLine) + '</div>' +
        (state.loggedIn ?
          '<button class="btn-primary pressable" data-action="performJoin"' + (state.joinSubmitting ? ' disabled' : '') + '>' +
          (state.joinSubmitting ? 'Ajout en cours…' : 'Rejoindre avec « ' + escapeHtml(person(state.currentUserId).name) + ' »') +
          '</button>' :
          '<div class="field-label">Ton prénom</div>' +
          '<input class="text-input" data-bind="joinName" placeholder="Toi" value="' + escapeHtml(state.joinNameInput) + '" />' +
          '<button class="btn-primary pressable" data-action="performJoin"' + (state.joinSubmitting ? ' disabled' : '') + '>' +
          (state.joinSubmitting ? 'Ajout en cours…' : 'Rejoindre le groupe') + '</button>' +
          '<div class="login-subtitle" style="font-size:12px;margin-top:10px">Aucun mot de passe requis — tu pourras créer un compte plus tard si tu veux retrouver ce groupe depuis un autre appareil.</div>') +
        (state.joinError ? '<div class="form-error">' + escapeHtml(state.joinError) + '</div>' : '') +
        '<div class="link-center" style="margin-top:20px" data-action="cancelJoin">← Retour à l\'accueil</div>';
    }
    return (
      '<div class="login-screen">' +
      '<div class="login-brand"><div class="login-icon">' + logoMark(30, '#0F8F6B', '#084b38') + '</div><span class="login-wordmark">Rohy</span></div>' +
      '<div class="login-title">' + (preview && !preview.error ? 'Rejoindre « ' + escapeHtml(preview.groupName) + ' »' : 'Lien d\'invitation') + '</div>' +
      body +
      '</div>'
    );
  }

  // État dédié (cf. openLoginForm/goToLanding) : render() affiche cet écran
  // à la place de renderLogin() sans passer par la navigation habituelle
  // (navStack), indisponible avant connexion. La landing est la racine de
  // l'app tant qu'on n'est pas connecté (comme Notion) : nav avec
  // connexion/inscription plutôt qu'un simple bouton retour.
  // Traductions de la landing (cf. toggleLandingLang) : objectif élargir la
  // cible au-delà du public francophone tout en restant sur le marché
  // africain — le "Made in Madagascar" et les témoignages/exemples
  // malgaches sont donc conservés tels quels en anglais (authenticité,
  // ancrage du produit), seul le texte est traduit.
  var LANDING_I18N = {
    fr: {
      navLogin: 'Connexion', navSignup: '🚀 Essayer Rohy gratuitement', navOpenApp: '🚀 Ouvrir l\'app',
      heroEyebrow: 'Suivi de dépenses partagées',
      heroH1Main: 'Les comptes clairs,', heroH1Sub: 'même quand les parts sont inégales.',
      heroLede: 'Rohy simplifie le partage des dépenses entre amis, en famille ou en voyage, même lorsque certains participants paient pour leurs enfants, leur conjoint ou ne participent qu\'à certaines dépenses.',
      ctaSignup: '🚀 Créer un compte gratuitement', ctaFinal: '🚀 Commencer gratuitement', ctaWatchDemo: '▶ Voir la démo',
      heroBadge: 'Conçu à Madagascar pour les groupes d\'amis, les familles et les voyageurs',
      heroImgAlt1: 'Écran d\'accueil Rohy montrant le solde net et les soldes par personne.',
      heroImgAlt2: 'Détail d\'un groupe Rohy sur mobile : Famille Randria apparaît comme un foyer consolidé en une seule ligne de solde.',
      problemEyebrow: 'Le problème', problemH2: 'Les dépenses de groupe sont rarement aussi simples qu\'un partage égal',
      problem1: 'Un parent paie pour ses enfants.', problem2: 'Un couple partage certaines dépenses.',
      problem3: 'Certaines personnes participent à une activité et d\'autres non.', problem4: 'Tout le monde ne contribue pas de la même manière.',
      problemFooter: 'Résultat : les calculs deviennent vite compliqués. Rohy a été conçu pour gérer ces situations naturellement.',
      differenceEyebrow: 'Pourquoi Rohy est différent', differenceH2: 'Conçu pour la vraie vie',
      mech1Title: 'Les enfants et personnes à charge', mech1Body: 'Attribuez des demi-parts ou rattachez plusieurs personnes à un même participant.',
      mech2Title: 'Les contributions personnalisées', mech2Body: 'Chaque membre peut participer selon sa situation grâce à un système de parts flexible.',
      mech3Title: 'Les dépenses ciblées', mech3Body: 'Une dépense peut concerner uniquement certains participants du groupe.',
      mech4Title: 'Les calculs automatiques', mech4Body: 'Rohy s\'occupe des calculs pour que chacun sache exactement qui doit combien à qui.',
      exampleEyebrow: 'Exemple concret', exampleH2: 'Un week-end entre amis et en famille',
      exampleP: 'Rohy calcule automatiquement la contribution de chacun en tenant compte des parts attribuées. Plus besoin de calculer manuellement.',
      exampleIgTitle: 'Loyer de la villa', exampleShare: 'part', exampleCovered: 'à charge',
      exampleFoot: 'Part calculée automatiquement, à chaque dépense.',
      howEyebrow: 'Comment ça marche', howH2: 'En 3 étapes',
      step1Title: 'Créez votre groupe', step1Body: 'Voyage, colocation, week-end ou dépenses familiales.', step1Alt: 'Formulaire de création d\'un nouveau groupe.',
      step2Title: 'Ajoutez les dépenses', step2Body: 'Indiquez qui a payé et qui participe à chaque dépense.', step2Alt: 'Formulaire d\'ajout de dépense.',
      step3Title: 'Laissez Rohy calculer', step3Body: 'Les soldes et remboursements sont calculés automatiquement.', step3Alt: 'Détail d\'un groupe Rohy montrant les soldes et suggestions de règlement.',
      usecasesEyebrow: 'Cas d\'usage', usecasesH2: 'Adapté à toutes les situations',
      uc1Title: 'Vacances en famille', uc1Body: 'Prenez en compte les enfants et les personnes à charge sans calcul compliqué.',
      uc2Title: 'Événements familiaux', uc2Body: 'Mariage, baptême, cérémonie religieuse, cotisation d\'association : comité familial, participations inégales entre foyers, chacun contribue selon ses moyens.',
      uc6Title: 'Colocations', uc6Body: 'Suivez les dépenses du quotidien et répartissez les coûts équitablement.',
      uc7Title: 'Voyages entre amis', uc7Body: 'Hébergement, restaurants, activités, carburant : gardez une vision claire des dépenses du groupe.',
      demoEyebrow: 'Démonstration', demoH2: 'Voyez Rohy en action',
      demoP: 'Créez un groupe, ajoutez vos dépenses, et laissez Rohy calculer automatiquement les remboursements.',
      demoAlt: 'Détail d\'un groupe Rohy, montrant le tableau payé/part/solde et les suggestions de règlement.',
      featuresEyebrow: 'Fonctionnalités principales', featuresH2: 'Tout ce qu\'il faut, rien de superflu',
      feat1Title: 'Gestion des groupes', feat1Body: 'Créez autant de groupes que nécessaire.',
      feat4Title: 'Historique complet', feat4Body: 'Retrouvez toutes les dépenses et remboursements.',
      feat5Title: 'Scan intelligent des tickets', feat5Body: 'Ajoutez rapidement vos dépenses à partir d\'une photo.',
      feat6Title: 'Suivi des remboursements', feat6Body: 'Gardez une vue claire des règlements effectués.',
      feat7Title: 'Lien d\'invitation', feat7Body: 'Invitez sans obliger vos proches à créer un compte.',
      feat8Title: 'Devises et mobile money africains', feat8Body: 'Ariary, francs CFA, Mvola, Orange Money, Airtel Money.',
      feat9Title: 'Export de vos données', feat9Body: 'Téléchargez les dépenses et les soldes d\'un groupe en CSV, Excel ou PDF.',
      feat10Title: 'Rappels automatiques', feat10Body: 'Envoyez un rappel — dans l\'app et par e-mail — à qui vous doit encore de l\'argent.',
      feat11Title: 'Simplification des dettes', feat11Body: 'Rohy regroupe les soldes entre tous vos groupes communs pour réduire le nombre de règlements.',
      feat12Title: 'Conversion de devise', feat12Body: 'Payez une dépense dans une autre devise que celle du groupe (ex. un billet d\'avion en euros) : le taux se pré-remplit automatiquement et reste modifiable.',
      compareEyebrow: 'Rohy vs. les autres apps',
      compareColRohy: 'Rohy', compareColOthers: 'Concurrents',
      compareRow1: 'Répartition classique', compareRow2: 'Demi-parts', compareRow3: 'Enfants et personnes à charge',
      compareRow4: 'Contributions personnalisées', compareRow5: 'Dépenses ciblées', compareRow6: 'Suivi des remboursements',
      compareRare: 'Rare', compareLimited: 'Limité',
      testimonialsEyebrow: 'Témoignages', testimonialsH2: 'Ils utilisent déjà Rohy pour leurs dépenses de groupe',
      t1Quote: 'Pour la première fois, nous avons pu gérer facilement les dépenses du groupe sans passer des heures à refaire les calculs.', t1Meta: 'Week-end à Mahambo, 8 participants',
      t2Quote: 'La gestion des demi-parts pour les enfants nous a énormément simplifié la vie.', t2Meta: 'Voyage à Nosy Be, 6 adultes et 2 enfants',
      t3Quote: 'Tout le monde sait exactement ce qu\'il doit. Plus de discussions interminables à la fin du mois.', t3Meta: 'Colocation à Antananarivo, 4 colocataires',
      faqEyebrow: 'Questions fréquentes', faqH2: 'Tout ce qu\'il faut savoir avant de commencer',
      faq1Q: 'Rohy est-il gratuit ?', faq1A: 'Oui. Vous pouvez créer des groupes et gérer vos dépenses gratuitement.',
      faq2Q: 'Dois-je installer une application ?', faq2A: 'Non. Rohy fonctionne directement depuis votre navigateur.',
      faq3Q: 'Puis-je l\'utiliser sur mobile ?', faq3A: 'Oui. Rohy est optimisé pour les smartphones, tablettes et ordinateurs.',
      faq4Q: 'Puis-je gérer des demi-parts ?', faq4A: 'Oui. Rohy a été conçu pour gérer les contributions inégales, les enfants et les personnes à charge.',
      faq5Q: 'Mes données sont-elles sécurisées ?', faq5A: 'Oui. Vos données sont stockées de manière sécurisée et ne sont accessibles qu\'aux membres de vos groupes.',
      finalH2: 'Prêt à simplifier vos dépenses de groupe ?', finalP: 'Créez votre premier groupe gratuitement et laissez Rohy faire les calculs à votre place.',
      footerTagline: 'Rohy signifie « lien » en malgache. Les comptes s\'équilibrent, les liens restent.',
      footerCol1: 'Découvrir', footerLinkProblem: 'Le problème', footerLinkDifference: 'Pourquoi Rohy est différent', footerLinkHow: 'Comment ça marche', footerLinkUsecases: 'Cas d\'usage', footerLinkFeatures: 'Fonctionnalités',
      footerCol2: 'En savoir plus', footerLinkTestimonials: 'Témoignages', footerLinkFaq: 'FAQ',
      footerBtnSignup: 'Créer un compte', footerBtnLogin: 'Connexion',
      footerBottom: '© 2026 Rohy.',
    },
    en: {
      navLogin: 'Log in', navSignup: '🚀 Try Rohy for free', navOpenApp: '🚀 Open the app',
      heroEyebrow: 'Shared expense tracking',
      heroH1Main: 'Clear accounts,', heroH1Sub: 'even when shares aren\'t equal.',
      heroLede: 'Rohy makes it simple to split expenses between friends, family, or on a trip — even when some people pay for their kids or partner, or only join in on certain expenses.',
      ctaSignup: '🚀 Create a free account', ctaFinal: '🚀 Get started for free', ctaWatchDemo: '▶ Watch the demo',
      heroBadge: 'Made in Madagascar, loved across Africa',
      heroImgAlt1: 'Rohy home screen showing the net balance and per-person balances.',
      heroImgAlt2: 'Rohy group detail on mobile: the Randria family appears as one consolidated household balance line.',
      problemEyebrow: 'The problem', problemH2: 'Group expenses are rarely as simple as splitting evenly',
      problem1: 'A parent pays for their kids.', problem2: 'A couple shares some expenses.',
      problem3: 'Some people join an activity, others don\'t.', problem4: 'Not everyone contributes the same way.',
      problemFooter: 'The result: the math gets complicated fast. Rohy was built to handle these situations naturally.',
      differenceEyebrow: 'Why Rohy is different', differenceH2: 'Built for real life',
      mech1Title: 'Kids and dependents', mech1Body: 'Assign half-shares or link several people to the same participant.',
      mech2Title: 'Custom contributions', mech2Body: 'Every member can contribute based on their situation, with a flexible share system.',
      mech3Title: 'Targeted expenses', mech3Body: 'An expense can involve only some of the group\'s participants.',
      mech4Title: 'Automatic calculations', mech4Body: 'Rohy handles the math so everyone knows exactly who owes what to whom.',
      exampleEyebrow: 'A real example', exampleH2: 'A weekend with friends and family',
      exampleP: 'Rohy automatically calculates each person\'s contribution based on assigned shares. No more manual math.',
      exampleIgTitle: 'Villa rental', exampleShare: 'share', exampleCovered: 'covered',
      exampleFoot: 'Share calculated automatically, for every expense.',
      howEyebrow: 'How it works', howH2: 'In 3 steps',
      step1Title: 'Create your group', step1Body: 'Trip, roommates, weekend, or family expenses.', step1Alt: 'New group creation form.',
      step2Title: 'Add expenses', step2Body: 'Say who paid and who\'s in on each expense.', step2Alt: 'Add expense form.',
      step3Title: 'Let Rohy do the math', step3Body: 'Balances and reimbursements are calculated automatically.', step3Alt: 'Rohy group detail showing balances and settlement suggestions.',
      usecasesEyebrow: 'Use cases', usecasesH2: 'Built for every situation',
      uc1Title: 'Family vacations', uc1Body: 'Account for kids and dependents without complicated math.',
      uc2Title: 'Family events', uc2Body: 'Weddings, baptisms, religious ceremonies, association dues: family committee, uneven contributions between households, everyone chips in based on what they can.',
      uc6Title: 'Roommates', uc6Body: 'Track everyday expenses and split costs fairly.',
      uc7Title: 'Trips with friends', uc7Body: 'Lodging, restaurants, activities, fuel — keep a clear view of the group\'s spending.',
      demoEyebrow: 'Demo', demoH2: 'See Rohy in action',
      demoP: 'Create a group, add your expenses, and let Rohy automatically calculate reimbursements.',
      demoAlt: 'Rohy group detail, showing the paid/share/balance table and settlement suggestions.',
      featuresEyebrow: 'Key features', featuresH2: 'Everything you need, nothing you don\'t',
      feat1Title: 'Group management', feat1Body: 'Create as many groups as you need.',
      feat4Title: 'Full history', feat4Body: 'Find every expense and reimbursement.',
      feat5Title: 'Smart receipt scan', feat5Body: 'Add expenses quickly from a photo.',
      feat6Title: 'Reimbursement tracking', feat6Body: 'Keep a clear view of settlements made.',
      feat7Title: 'Invite link', feat7Body: 'Invite people without making them create an account.',
      feat8Title: 'African currencies and mobile money', feat8Body: 'Ariary, CFA francs, Mvola, Orange Money, Airtel Money.',
      feat9Title: 'Export your data', feat9Body: 'Download a group\'s expenses and balances as CSV, Excel, or PDF.',
      feat10Title: 'Automatic reminders', feat10Body: 'Send a reminder — in the app and by e-mail — to whoever still owes you money.',
      feat11Title: 'Debt simplification', feat11Body: 'Rohy nets out balances across every group you share with someone, so fewer payments are needed to settle up.',
      feat12Title: 'Currency conversion', feat12Body: 'Pay an expense in a different currency than the group\'s (e.g. a plane ticket in euros): the rate is pre-filled automatically and stays editable.',
      compareEyebrow: 'Rohy vs. other apps',
      compareColRohy: 'Rohy', compareColOthers: 'Competitors',
      compareRow1: 'Classic even split', compareRow2: 'Half-shares', compareRow3: 'Kids and dependents',
      compareRow4: 'Custom contributions', compareRow5: 'Targeted expenses', compareRow6: 'Reimbursement tracking',
      compareRare: 'Rare', compareLimited: 'Limited',
      testimonialsEyebrow: 'Testimonials', testimonialsH2: 'Already using Rohy for their group expenses',
      t1Quote: 'For the first time, we could easily manage the group\'s expenses without spending hours redoing the math.', t1Meta: 'Weekend in Mahambo, 8 people',
      t2Quote: 'Handling half-shares for the kids made our life so much easier.', t2Meta: 'Trip to Nosy Be, 6 adults and 2 kids',
      t3Quote: 'Everyone knows exactly what they owe. No more endless discussions at the end of the month.', t3Meta: 'Roommates in Antananarivo, 4 flatmates',
      faqEyebrow: 'Frequently asked questions', faqH2: 'Everything you need to know before you start',
      faq1Q: 'Is Rohy free?', faq1A: 'Yes. You can create groups and manage your expenses for free.',
      faq2Q: 'Do I need to install an app?', faq2A: 'No. Rohy runs directly from your browser.',
      faq3Q: 'Can I use it on mobile?', faq3A: 'Yes. Rohy is optimized for smartphones, tablets, and computers.',
      faq4Q: 'Can I manage half-shares?', faq4A: 'Yes. Rohy was built to handle uneven contributions, kids, and dependents.',
      faq5Q: 'Is my data secure?', faq5A: 'Yes. Your data is stored securely and only accessible to members of your groups.',
      finalH2: 'Ready to simplify your group expenses?', finalP: 'Create your first group for free and let Rohy do the math for you.',
      footerTagline: 'Rohy means "link" in Malagasy. The accounts balance out. The bonds remain.',
      footerCol1: 'Discover', footerLinkProblem: 'The problem', footerLinkDifference: 'Why Rohy is different', footerLinkHow: 'How it works', footerLinkUsecases: 'Use cases', footerLinkFeatures: 'Features',
      footerCol2: 'Learn more', footerLinkTestimonials: 'Testimonials', footerLinkFaq: 'FAQ',
      footerBtnSignup: 'Create an account', footerBtnLogin: 'Log in',
      footerBottom: '© 2026 Rohy.',
    },
  };
  function landingT() { return LANDING_I18N[state.landingLang] || LANDING_I18N.fr; }

  // Politique de confidentialité — reflète les traitements réels de l'app
  // (cf. commentaires dans supabase/functions/scan-receipt et send-reminder
  // pour les sous-traitants concernés). Réutilise state.landingLang comme le
  // reste de la landing plutôt qu'un réglage de langue séparé.
  var PRIVACY_I18N = {
    fr: {
      title: 'Politique de confidentialité',
      updated: 'Dernière mise à jour : juillet 2026.',
      s1Title: 'Responsable du traitement',
      s1Body: 'Rohy est édité par Malagasy Wonders, responsable du traitement des données décrites ci-dessous. Pour toute question ou pour exercer tes droits, contacte-nous à contact@rohy-app.com.',
      s2Title: 'Données que nous traitons',
      s2Items: [
        'Ton nom, ton adresse e-mail et, si tu en crées un, ton mot de passe (haché, jamais stocké en clair).',
        'Les groupes que tu crées ou rejoins, et les dépenses que tu y ajoutes : libellé, montant, date, catégorie, qui a payé, qui participe.',
        'Les photos de tickets/factures que tu choisis de joindre ou de scanner.',
        'L\'adresse e-mail des personnes à qui tu envoies un rappel de paiement.',
      ],
      s3Title: 'Pourquoi nous les traitons, et sur quelle base',
      s3Items: [
        'Faire fonctionner le service (créer un compte, suivre des dépenses, calculer les soldes) — exécution du contrat qui nous lie à toi en utilisant Rohy.',
        'Lire automatiquement le contenu d\'un ticket scanné pour pré-remplir le formulaire — exécution du contrat, déclenchée uniquement quand tu choisis d\'utiliser cette fonctionnalité.',
        'Envoyer un rappel de paiement par e-mail — déclenché uniquement par ton action explicite (le bouton "Envoyer un rappel").',
        'Mesurer la fréquentation du site — intérêt légitime à comprendre l\'usage de Rohy, via une mesure d\'audience qui ne dépose pas de cookie de suivi individuel (cf. section Cookies ci-dessous).',
      ],
      s4Title: 'Avec qui ces données sont partagées',
      s4Intro: 'Nous faisons appel aux prestataires suivants pour faire fonctionner Rohy. Tous sont situés hors de l\'Union européenne (États-Unis) ; leurs transferts de données sont encadrés par les clauses contractuelles types de la Commission européenne ou un mécanisme équivalent.',
      s4Items: [
        'Supabase, Inc. — hébergement de la base de données, authentification, stockage des reçus.',
        'Cloudflare, Inc. — mesure d\'audience du site (sans cookie de suivi individuel).',
        'Resend — envoi des e-mails de rappel de paiement.',
        'Anthropic PBC — lecture automatique du contenu des tickets scannés.',
      ],
      s5Title: 'Combien de temps nous les gardons',
      s5Body: 'Tes données sont conservées tant que ton compte est actif. Tu peux demander leur suppression à tout moment (cf. "Tes droits" ci-dessous) ; elles sont alors supprimées, sous réserve des durées de conservation légales qui pourraient s\'appliquer.',
      s6Title: 'Sécurité',
      s6Body: 'Les échanges avec Rohy sont chiffrés (HTTPS). L\'accès aux données est cloisonné par des règles strictes côté base de données : chacun ne peut voir et modifier que les groupes dont il est membre.',
      s7Title: 'Tes droits',
      s7Body: 'Tu disposes d\'un droit d\'accès, de rectification, d\'effacement, de portabilité et d\'opposition sur tes données. Pour les exercer, écris-nous à contact@rohy-app.com. Tu disposes aussi du droit d\'introduire une réclamation auprès de l\'autorité de protection des données de ton pays de résidence (la CNIL en France).',
      s8Title: 'Cookies et traceurs',
      s8Body: 'Rohy n\'utilise aucun cookie publicitaire ou de profilage. La mesure d\'audience (Cloudflare Web Analytics) est conçue pour fonctionner sans cookie de suivi individuel.',
      manageConsent: 'Modifier mes préférences de mesure d\'audience',
      exportMyData: 'Télécharger mes données',
      exportMyDataLoggedOut: 'Connecte-toi pour télécharger tes données.',
      backLabel: '← Retour',
      bannerText: 'Nous utilisons une mesure d\'audience (Cloudflare Web Analytics, sans cookie de suivi individuel) pour comprendre l\'usage de Rohy. Tu peux l\'accepter ou la refuser — ça ne change rien au fonctionnement de l\'app.',
      bannerAccept: 'Accepter', bannerDecline: 'Refuser', bannerLearnMore: 'En savoir plus',
    },
    en: {
      title: 'Privacy policy',
      updated: 'Last updated: July 2026.',
      s1Title: 'Data controller',
      s1Body: 'Rohy is published by Malagasy Wonders, the controller for the data described below. For any question or to exercise your rights, contact us at contact@rohy-app.com.',
      s2Title: 'Data we process',
      s2Items: [
        'Your name, e-mail address, and, if you create one, your password (hashed, never stored in plain text).',
        'The groups you create or join, and the expenses you add there: label, amount, date, category, who paid, who\'s involved.',
        'Photos of receipts/invoices you choose to attach or scan.',
        'The e-mail address of people you send a payment reminder to.',
      ],
      s3Title: 'Why we process it, and on what basis',
      s3Items: [
        'Running the service (creating an account, tracking expenses, computing balances) — performance of the contract you enter into by using Rohy.',
        'Automatically reading a scanned receipt to pre-fill the form — performance of the contract, only triggered when you choose to use this feature.',
        'Sending a payment reminder by e-mail — only triggered by your explicit action (the "Send a reminder" button).',
        'Measuring site traffic — legitimate interest in understanding how Rohy is used, via an analytics tool that does not set individual tracking cookies (see Cookies below).',
      ],
      s4Title: 'Who this data is shared with',
      s4Intro: 'We rely on the following providers to run Rohy. All are located outside the European Union (United States); their data transfers are governed by the European Commission\'s standard contractual clauses or an equivalent mechanism.',
      s4Items: [
        'Supabase, Inc. — database hosting, authentication, receipt storage.',
        'Cloudflare, Inc. — site traffic measurement (no individual tracking cookie).',
        'Resend — sending payment reminder e-mails.',
        'Anthropic PBC — automatically reading the content of scanned receipts.',
      ],
      s5Title: 'How long we keep it',
      s5Body: 'Your data is kept as long as your account is active. You can request its deletion at any time (see "Your rights" below); it is then deleted, subject to any legal retention periods that may apply.',
      s6Title: 'Security',
      s6Body: 'Exchanges with Rohy are encrypted (HTTPS). Access to data is strictly compartmentalized at the database level: each person can only see and modify the groups they belong to.',
      s7Title: 'Your rights',
      s7Body: 'You have the right to access, rectify, erase, port, and object to your data. To exercise these rights, write to us at contact@rohy-app.com. You also have the right to lodge a complaint with the data protection authority in your country of residence.',
      s8Title: 'Cookies and trackers',
      s8Body: 'Rohy uses no advertising or profiling cookies. Our traffic measurement tool (Cloudflare Web Analytics) is designed to work without individual tracking cookies.',
      manageConsent: 'Change my traffic measurement preferences',
      exportMyData: 'Download my data',
      exportMyDataLoggedOut: 'Log in to download your data.',
      backLabel: '← Back',
      bannerText: 'We use a traffic measurement tool (Cloudflare Web Analytics, no individual tracking cookie) to understand how Rohy is used. You can accept or decline — it changes nothing about how the app works.',
      bannerAccept: 'Accept', bannerDecline: 'Decline', bannerLearnMore: 'Learn more',
    },
  };
  function privacyT() { return PRIVACY_I18N[state.landingLang] || PRIVACY_I18N.fr; }

  function renderAboutFromLogin() {
    // Déjà connecté (racine du site rouverte dans un nouvel onglet, ou après
    // rechargement) : plus besoin du bouton "Connexion", et le CTA principal
    // doit mener dans l'app plutôt qu'à l'inscription (cf. enterApp).
    var L = landingT();
    // Bouton "Connexion" rendu deux fois — une fois visible en ligne (nav
    // desktop), une fois dans le menu ☰ (nav mobile, cf. CSS qui bascule
    // l'affichage de l'un ou l'autre selon la largeur) — plutôt qu'une seule
    // version déplacée en JS selon la taille d'écran.
    var loginBtn = '<button class="btn-outline pressable ldg-nav-login-inline" data-action="openLoginForm">' + L.navLogin + '</button>';
    var ctaBtn = state.loggedIn ?
      '<button class="btn-primary pressable" data-action="enterApp">' + L.navOpenApp + '</button>' :
      '<button class="btn-primary pressable" data-action="ctaSignupFromAbout">' + L.navSignup + '</button>';
    var hamburger = state.loggedIn ? '' :
      '<button class="icon-btn ldg-hamburger pressable" data-action="toggleLandingMobileMenu" aria-label="Menu"><i class="ph-bold ph-list"></i></button>';
    var mobileMenu = (state.showLandingMobileMenu && !state.loggedIn) ?
      '<div class="ldg-mobile-menu-overlay" data-action="closeLandingMobileMenu"></div>' +
      '<div class="ldg-mobile-menu" data-stop-click>' +
      '<button class="pressable" data-action="openLoginForm">' + L.navLogin + '</button>' +
      '</div>' : '';
    return (
      '<div class="about-standalone-screen">' +
      '<nav class="ldg-nav">' +
      '<div class="ldg-nav-brand">' + logoMark(26, '#0F8F6B', '#084b38') + '<span>Rohy</span></div>' +
      '<div class="ldg-nav-actions">' + (state.loggedIn ? '' : loginBtn) + ctaBtn + hamburger + '</div>' +
      mobileMenu +
      '</nav>' +
      renderAboutScreen() +
      '</div>'
    );
  }

  function renderNewPasswordScreen() {
    return (
      '<div class="login-screen">' +
      '<div class="login-brand"><div class="login-icon">' + logoMark(30, '#0F8F6B', '#084b38') + '</div><span class="login-wordmark">Rohy</span></div>' +
      '<div class="login-title">Nouveau mot de passe</div>' +
      '<div class="login-subtitle">Choisis un nouveau mot de passe pour ton compte</div>' +
      '<div class="field-label">Mot de passe</div>' +
      '<input class="text-input" type="password" autocomplete="new-password" data-bind="newPassword" placeholder="•••••••• (8 caractères min)" value="' + escapeHtml(state.newPasswordForm.password) + '" />' +
      '<button class="btn-primary pressable" data-action="submitNewPassword">Mettre à jour le mot de passe</button>' +
      (state.loginError ? '<div class="form-error">' + escapeHtml(state.loginError) + '</div>' : '') +
      '</div>'
    );
  }

  function renderAccountDeletedScreen() {
    return (
      '<div class="login-screen">' +
      '<div class="login-brand"><div class="login-icon">' + logoMark(30, '#0F8F6B', '#084b38') + '</div><span class="login-wordmark">Rohy</span></div>' +
      '<div class="login-title">Compte supprimé</div>' +
      '<div class="login-subtitle">Ton compte et tes informations personnelles ont été supprimés. Les dépenses partagées avec d\'autres membres restent visibles pour eux, sous un profil anonymisé.</div>' +
      '<button class="btn-primary pressable" data-action="dismissAccountDeleted">Retour à l\'accueil</button>' +
      '</div>'
    );
  }

  function renderApp() {
    return (
      renderTopBar() +
      renderUpgradeNudgeBanner() +
      '<div class="content">' + renderContent() + '</div>' +
      renderBottomNav() +
      renderModals() +
      renderToast()
    );
  }

  // Relance persistante (cf. maybeShowUpgradeNudge) : visible sur tous les
  // écrans tant qu'elle n'est pas ignorée ou qu'un compte n'a pas été créé.
  function renderUpgradeNudgeBanner() {
    if (!state.showUpgradeNudge) return '';
    return (
      '<div class="upgrade-nudge">' +
      '<span><i class="ph-bold ph-info"></i> Ce groupe n\'est pas encore protégé par un compte — tu pourrais en perdre l\'accès en changeant d\'appareil.</span>' +
      '<div class="upgrade-nudge-actions">' +
      '<button class="btn-primary pressable" style="padding:8px 16px;font-size:13px;flex:none" data-action="openUpgradeAccount">Créer un compte</button>' +
      '<button class="icon-btn pressable" data-action="dismissUpgradeNudge" aria-label="Ignorer"><i class="ph-bold ph-x"></i></button>' +
      '</div>' +
      '</div>'
    );
  }

  function renderTopBar() {
    var showBack = state.screen !== 'home' && state.screen !== 'groups' && state.screen !== 'history' && state.screen !== 'expenses';
    var showAddButton = state.screen === 'home' || state.screen === 'groups' || state.screen === 'expenses';
    var titles = { home: 'Mes dépenses', groups: 'Groupes', history: 'Historique', expenses: 'Dépenses', person: 'Détail', about: 'À propos' };
    var title = titles[state.screen];
    var subtitle = '';
    if (state.screen === 'groupDetail') {
      var g = group(state.selectedGroupId);
      title = g ? g.name : '';
      subtitle = g ? 'Admin : ' + person(g.adminId).name : '';
    }
    var isHome = state.screen === 'home';
    var cu = person(state.currentUserId);
    return (
      '<div class="top-bar">' +
      (showBack ? '<button class="icon-btn pressable" data-action="goBack" aria-label="Retour"><i class="ph-bold ph-arrow-left"></i></button>' :
        isHome ? '<div class="top-bar-wordmark pressable" data-action="exitToLanding">' + logoMarkMulti(26) + '<span>Rohy</span></div>' :
        '<div class="top-bar-logo pressable" data-action="exitToLanding">' + logoMark(20, '#0F8F6B', '#084b38') + '</div>') +
      '<div style="flex:1">' +
      '<div class="top-title' + (isHome ? ' home-title' : '') + '">' + escapeHtml(title) + '</div>' +
      (subtitle ? '<div class="top-subtitle">' + escapeHtml(subtitle) + '</div>' : '') +
      '</div>' +
      (state.screen === 'groupDetail' ? renderGroupMenuTrigger() : '') +
      // Icône de compte : seul point d'accès à "Mon compte"/déconnexion
      // avant cette modification, elle n'était joignable que depuis
      // l'accueil ("Bonjour, ..."). Toujours visible ici, sur tous les
      // écrans, façon avatar de profil dans un en-tête.
      // Le mode jour/nuit vit désormais dans "Mon compte" (feuille mobile)
      // /le menu déroulant (desktop) avec les autres réglages de préférence
      // — trop peu fréquent pour mériter une icône permanente dans la barre
      // du haut, cf. À propos/Se déconnecter qui suivent le même principe.
      '<button class="avatar avatar-30 pressable account-icon-btn" data-action="openAccount" style="background:' + cu.color + ';border:none;padding:0;cursor:pointer" title="Mon compte" aria-label="Mon compte">' + initials(cu.name) + '</button>' +
      (showAddButton ? '<button class="icon-btn small brand pressable" data-action="openAddExpenseGlobal" aria-label="Ajouter une dépense"><i class="ph-bold ph-plus"></i></button>' : '') +
      '</div>'
    );
  }

  // Actions d'administration du groupe (gérer les membres, partager le lien,
  // supprimer/quitter) : déplacées ici depuis le corps de l'écran (cf.
  // ancien .admin-actions) — des boutons pleine largeur juste sous le solde
  // n'avaient pas leur place parmi les informations qu'on vient consulter en
  // premier ; un menu contextuel dans la barre du haut est plus idiomatique
  // pour des actions secondaires (même principe que "Mon compte").
  function renderGroupMenuTrigger() {
    var g = group(state.selectedGroupId);
    if (!g) return '';
    var isAdmin = g.adminId === state.currentUserId;
    return (
      '<div style="position:relative">' +
      '<button class="icon-btn pressable" data-action="toggleGroupMenu" aria-label="Options du groupe"><i class="ph-bold ph-dots-three-vertical"></i></button>' +
      (state.showGroupMenu ?
        '<div class="group-menu-overlay" data-action="closeModal"></div>' +
        '<div class="group-menu-dropdown" data-stop-click>' +
        '<button class="group-menu-item pressable" data-action="openManageMembers" data-id="' + g.id + '"><i class="ph-bold ph-users-three"></i>Gérer les membres</button>' +
        '<button class="group-menu-item pressable" data-action="shareInviteLink" data-id="' + g.id + '"><i class="ph-bold ph-link"></i>Partager le lien d\'invitation</button>' +
        '<button class="group-menu-item pressable" data-action="exportGroupCsv" data-id="' + g.id + '"><i class="ph-bold ph-file-csv"></i>Exporter en CSV</button>' +
        '<button class="group-menu-item pressable" data-action="exportGroupExcel" data-id="' + g.id + '"><i class="ph-bold ph-file-xls"></i>Exporter en Excel</button>' +
        '<button class="group-menu-item pressable" data-action="exportGroupPdf" data-id="' + g.id + '"><i class="ph-bold ph-file-pdf"></i>Exporter en PDF</button>' +
        (isAdmin ?
          '<button class="group-menu-item pressable" style="color:var(--status-danger)" data-action="openConfirmDeleteGroup" data-id="' + g.id + '"><i class="ph-bold ph-trash" style="color:var(--status-danger)"></i>Supprimer le groupe</button>' :
          '<button class="group-menu-item pressable" style="color:var(--status-danger)" data-action="openConfirmLeaveGroup" data-id="' + g.id + '"><i class="ph-bold ph-door-open" style="color:var(--status-danger)"></i>Quitter ce groupe</button>') +
        '</div>' : '') +
      '</div>'
    );
  }

  function renderContent() {
    switch (state.screen) {
      case 'home': return renderHome();
      case 'groups': return renderGroups();
      case 'groupDetail': return renderGroupDetail();
      case 'person': return renderPersonDetail();
      case 'expenses': return renderAllExpenses();
      case 'history': return renderHistory();
      case 'about': return renderAboutScreen();
      case 'privacy': return renderPrivacyScreen();
      default: return '';
    }
  }

  // Additionner des soldes/montants de groupes en devises différentes n'a pas
  // de sens (la somme ne correspond à aucune monnaie réelle) : on ne montre
  // un agrégat "tous les groupes" que si tous les groupes du compte partagent
  // la même devise, sinon on invite explicitement à filtrer par groupe.
  function groupsHaveSingleCurrency() {
    if (state.groups.length === 0) return true;
    var first = state.groups[0].currency;
    return state.groups.every(function (g) { return g.currency === first; });
  }

  function renderGroupFilterPills(selectedId, action) {
    if (state.groups.length < 2) return '';
    var allPill = '<div class="pill' + (!selectedId ? ' active' : '') + '" data-action="' + action + '" data-id="">Tous les groupes</div>';
    var groupPills = state.groups.map(function (g) {
      return '<div class="pill' + (selectedId === g.id ? ' active' : '') + '" data-action="' + action + '" data-id="' + g.id + '">' + escapeHtml(g.name) + '</div>';
    }).join('');
    return '<div class="pill-row" style="margin-bottom:16px">' + allPill + groupPills + '</div>';
  }

  // Options des filtres Statut/Période de l'écran Dépenses — partagées entre
  // la modale (choix) et les puces de résumé (libellé court affiché).
  var EXPENSE_STATUS_OPTIONS = [
    { id: 'personnelle', label: 'Personnelle' },
    { id: 'remboursée', label: 'Remboursée' },
    { id: 'partiellement remboursée', label: 'Partielle' },
    { id: 'non remboursée', label: 'Non remboursée' },
  ];
  var EXPENSE_DATE_PRESETS = [
    { id: 'all', label: 'Toutes les dates' },
    { id: 'this_month', label: 'Ce mois-ci' },
    { id: 'last_month', label: 'Mois dernier' },
    { id: 'this_year', label: 'Cette année' },
    { id: 'custom', label: 'Personnalisé' },
  ];
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  // e.date est au format 'AAAA-MM-JJ' (tri déjà fait par comparaison de
  // chaînes ailleurs, cf. sortComparators) — un simple préfixe suffit donc
  // pour "ce mois-ci"/"cette année", pas besoin de parser en Date.
  function expenseDateMatchesFilter(e, preset, from, to) {
    if (!preset || preset === 'all') return true;
    if (preset === 'custom') {
      if (from && e.date < from) return false;
      if (to && e.date > to) return false;
      return true;
    }
    var now = new Date();
    if (preset === 'this_month') return e.date.indexOf(now.getFullYear() + '-' + pad2(now.getMonth() + 1)) === 0;
    if (preset === 'last_month') {
      var lm = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
      var ly = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
      return e.date.indexOf(ly + '-' + pad2(lm + 1)) === 0;
    }
    if (preset === 'this_year') return e.date.indexOf(String(now.getFullYear())) === 0;
    return true;
  }
  // Une dimension de filtre à choix multiple (Groupe/Membre/Catégorie) dans
  // la modale "Filtres" : pastilles si peu de valeurs, sinon un champ de
  // recherche au-dessus pour ne pas faire exploser la hauteur de la feuille
  // (même seuil que "Gérer les membres", cf. renderManageMembersModal).
  function renderFilterOptionsSection(label, allLabel, items, selectedId, action, searchQuery, searchBind) {
    if (items.length < 2) return '';
    var useSearch = items.length > 5;
    var visible = items;
    if (useSearch && (searchQuery || '').trim()) {
      var q = searchQuery.trim().toLowerCase();
      visible = items.filter(function (it) { return it.name.toLowerCase().indexOf(q) !== -1; });
    }
    var allPill = '<div class="pill' + (!selectedId ? ' active' : '') + '" data-action="' + action + '" data-id="">' + escapeHtml(allLabel) + '</div>';
    var pills = visible.map(function (it) {
      return '<div class="pill' + (selectedId === it.id ? ' active' : '') + '" data-action="' + action + '" data-id="' + it.id + '">' +
        (it.icon ? '<i class="' + it.icon + '" style="margin-right:5px"></i>' : '') + escapeHtml(it.name) + '</div>';
    }).join('');
    return '<div class="section-label">' + escapeHtml(label) + '</div>' +
      (useSearch ? '<input class="text-input" data-bind="' + searchBind + '" placeholder="Rechercher..." value="' + escapeHtml(searchQuery || '') + '" />' : '') +
      '<div class="pill-row" style="margin-bottom:16px">' + allPill + pills + '</div>';
  }
  // Nombre de dimensions actives, pour le badge sur le bouton "Filtres" — la
  // recherche texte et le tri n'en font pas partie (cf. proposition UX :
  // trier ≠ filtrer).
  function activeExpenseFilterChips() {
    var chips = [];
    if (state.expensesGroupFilter) {
      var g = group(state.expensesGroupFilter);
      if (g) chips.push({ key: 'group', label: g.name });
    }
    if (state.expensesPersonFilter) {
      var p = person(state.expensesPersonFilter);
      if (p) chips.push({ key: 'person', label: p.name });
    }
    if (state.expensesCategoryFilter) {
      var cat = seed.EXPENSE_CATEGORIES.find(function (c) { return c.id === state.expensesCategoryFilter; });
      if (cat) chips.push({ key: 'category', label: cat.label });
    }
    if (state.expensesDatePreset && state.expensesDatePreset !== 'all') {
      var preset = EXPENSE_DATE_PRESETS.find(function (d) { return d.id === state.expensesDatePreset; });
      var dateLabel = state.expensesDatePreset === 'custom'
        ? ((state.expensesDateFrom ? fmtDate(state.expensesDateFrom) : '…') + ' → ' + (state.expensesDateTo ? fmtDate(state.expensesDateTo) : '…'))
        : (preset ? preset.label : '');
      chips.push({ key: 'date', label: dateLabel });
    }
    if (state.expensesStatusFilter) {
      var st = EXPENSE_STATUS_OPTIONS.find(function (s) { return s.id === state.expensesStatusFilter; });
      if (st) chips.push({ key: 'status', label: st.label });
    }
    if ((state.expensesAmountMin || '').trim() || (state.expensesAmountMax || '').trim()) {
      var minL = (state.expensesAmountMin || '').trim(), maxL = (state.expensesAmountMax || '').trim();
      chips.push({ key: 'amount', label: minL && maxL ? minL + '–' + maxL : minL ? '≥ ' + minL : '≤ ' + maxL });
    }
    return chips;
  }
  function renderExpenseFilterChips(chips) {
    if (!chips.length) return '';
    return '<div class="pill-row" style="margin-bottom:10px">' + chips.map(function (c) {
      return '<div class="filter-chip pressable" data-action="removeExpenseFilterChip" data-id="' + c.key + '">' + escapeHtml(c.label) + '<i class="ph-bold ph-x"></i></div>';
    }).join('') + '</div>';
  }
  function renderExpenseFiltersModal() {
    var filterId = state.expensesGroupFilter && group(state.expensesGroupFilter) ? state.expensesGroupFilter : null;
    var scopedExpenses = filterId ? state.expenses.filter(function (e) { return e.groupId === filterId; }) : state.expenses;

    var groupItems = state.groups.map(function (g) { return { id: g.id, name: g.name }; });

    var presentPersonIds = {};
    scopedExpenses.forEach(function (e) {
      presentPersonIds[e.paidBy] = true;
      e.participants.forEach(function (pid) { presentPersonIds[pid] = true; });
    });
    var personItems = Object.keys(presentPersonIds).map(function (pid) { return person(pid); }).filter(Boolean)
      .map(function (p) { return { id: p.id, name: p.name }; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });

    var presentCatIds = {};
    scopedExpenses.forEach(function (e) { presentCatIds[categoryForIcon(e.icon)] = true; });
    var categoryItems = seed.EXPENSE_CATEGORIES.filter(function (c) { return presentCatIds[c.id]; })
      .map(function (c) { return { id: c.id, name: c.label, icon: c.icon }; });

    return (
      '<div class="modal-overlay bottom" data-action="closeModal">' +
      '<div class="modal-sheet" data-stop-click>' +
      '<div class="modal-header"><div class="modal-title">Filtres</div>' +
      '<button class="modal-close" data-action="closeModal" aria-label="Fermer"><i class="ph-bold ph-x"></i></button></div>' +
      renderFilterOptionsSection('Groupe', 'Tous les groupes', groupItems, filterId, 'setExpensesGroupFilter', state.expensesFilterGroupSearch, 'expensesFilterGroupSearch') +
      renderFilterOptionsSection('Membre', 'Tous les membres', personItems, state.expensesPersonFilter, 'setExpensesPersonFilter', state.expensesFilterPersonSearch, 'expensesFilterPersonSearch') +
      renderFilterOptionsSection('Catégorie', 'Toutes catégories', categoryItems, state.expensesCategoryFilter, 'setExpensesCategoryFilter', '', '') +
      '<div class="section-label">Période</div>' +
      '<div class="pill-row" style="margin-bottom:16px">' + EXPENSE_DATE_PRESETS.map(function (d) {
        return '<div class="pill' + (state.expensesDatePreset === d.id ? ' active' : '') + '" data-action="setExpensesDatePreset" data-id="' + d.id + '">' + escapeHtml(d.label) + '</div>';
      }).join('') + '</div>' +
      (state.expensesDatePreset === 'custom' ?
        '<div style="display:flex;gap:8px;margin:-8px 0 16px">' +
        '<div style="flex:1"><div class="field-label">Du</div><input class="text-input" style="margin-bottom:0" type="date" data-bind="expensesDateFrom" value="' + escapeHtml(state.expensesDateFrom) + '" /></div>' +
        '<div style="flex:1"><div class="field-label">Au</div><input class="text-input" style="margin-bottom:0" type="date" data-bind="expensesDateTo" value="' + escapeHtml(state.expensesDateTo) + '" /></div>' +
        '</div>' : '') +
      '<div class="section-label">Statut</div>' +
      '<div class="pill-row" style="margin-bottom:16px">' +
      '<div class="pill' + (!state.expensesStatusFilter ? ' active' : '') + '" data-action="setExpensesStatusFilter" data-id="">Tous statuts</div>' +
      EXPENSE_STATUS_OPTIONS.map(function (s) {
        return '<div class="pill' + (state.expensesStatusFilter === s.id ? ' active' : '') + '" data-action="setExpensesStatusFilter" data-id="' + s.id + '">' + escapeHtml(s.label) + '</div>';
      }).join('') + '</div>' +
      '<div class="section-label">Montant</div>' +
      '<div style="display:flex;gap:8px;align-items:center;margin-bottom:20px">' +
      '<input class="text-input" style="margin-bottom:0" inputmode="decimal" placeholder="Min" data-bind="expensesAmountMin" value="' + escapeHtml(state.expensesAmountMin) + '" />' +
      '<span style="color:var(--text-tertiary)">–</span>' +
      '<input class="text-input" style="margin-bottom:0" inputmode="decimal" placeholder="Max" data-bind="expensesAmountMax" value="' + escapeHtml(state.expensesAmountMax) + '" />' +
      '</div>' +
      '<div style="display:flex;gap:10px">' +
      '<button class="btn-outline pressable" style="flex:1" data-action="resetExpenseFilters">Réinitialiser</button>' +
      '<button class="btn-primary pressable" style="flex:1" data-action="closeModal">Voir les résultats</button>' +
      '</div>' +
      '</div></div>'
    );
  }

  function renderHome() {
    var moi = state.currentUserId;
    var cu = person(moi);
    var receivedReminder = mostRecentReminderForMe();
    var filterId = state.homeGroupFilter && group(state.homeGroupFilter) ? state.homeGroupFilter : null;
    var filterGroup = filterId ? group(filterId) : null;
    var fmtC = function (n) { return fmtIn(n, filterGroup ? filterGroup.currency : null); };
    var globalDebts = filterId ? computeDebtsForGroup(filterId) : computeDebts();
    // Sans filtre de groupe : ne garder que les personnes qui partagent
    // encore au moins un groupe EXISTANT avec moi — sans ce filtre, un
    // profil invité que j'ai créé restait visible ici même après
    // suppression complète du groupe (la RLS l'autorise toujours via
    // created_by, cf. migration 0008), alors que ses dépenses/soldes ont
    // eux bien disparu (cascade sur groups). Un ex-membre d'un groupe
    // encore existant reste lui volontairement visible sur la fiche de ce
    // groupe s'il a un solde non réglé (cf. renderGroupDetail) — cas
    // différent, pas concerné ici.
    var otherPeople = state.people.filter(function (p) {
      if (p.id === moi || p.guardianId) return false;
      if (filterGroup) return filterGroup.memberIds.indexOf(p.id) !== -1;
      return state.groups.some(function (g) { return g.memberIds.indexOf(p.id) !== -1; });
    });
    var relevantExpenses = filterId ? state.expenses.filter(function (e) { return e.groupId === filterId; }) : state.expenses;
    var pendingShare = calc.computePendingShare(state.people, relevantExpenses, moi);

    var owed = 0, owe = 0;
    var rows = otherPeople.map(function (p) {
      var bal = pairNet(moi, p.id, globalDebts);
      if (bal > 0) owed += bal; else owe += -bal;
      var covered = p.guardianId ? person(p.guardianId) : null;
      var amountLabel = Math.abs(bal) < 0.5 ? 'À jour' : (bal > 0 ? 'Te doit ' + fmtC(bal) : 'Tu dois ' + fmtC(-bal));
      return (
        '<button class="person-row pressable" data-action="openPerson" data-id="' + p.id + '">' +
        '<div class="avatar avatar-38" style="background:' + p.color + '">' + initials(p.name) + '</div>' +
        '<div style="flex:1;min-width:0;text-align:left">' +
        '<div class="person-name">' + escapeHtml(p.name) + '</div>' +
        shareBadge(p, false) +
        (covered ? '<div class="covered-note">Pris en charge par ' + escapeHtml(covered.name) + '</div>' : '') +
        '</div>' +
        '<div style="text-align:right;flex-shrink:0">' +
        '<div class="person-amount" style="color:' + colorForBalance(bal) + '">' + escapeHtml(amountLabel) + '</div>' +
        (bal > 0.5 ? '<span class="remind-link" data-action="remind" data-id="' + p.id + '" data-group-id="' + (filterId || '') + '">Envoyer un rappel →</span>' : '') +
        '</div></button>'
      );
    }).join('');

    var sum = owed - owe;
    var mixedCurrencies = !filterId && !groupsHaveSingleCurrency();

    // Suggestions de règlement à l'échelle du compte : computeDebts() (sans
    // filtre de groupe) fusionne déjà nativement la dette entre deux mêmes
    // personnes partageant plusieurs groupes (les clés de dette ne sont pas
    // scopées par groupe) — simplify() sur cet ensemble complet donne donc
    // directement le nombre minimal de transactions à l'échelle du compte,
    // au lieu des suggestions potentiellement redondantes qu'on obtiendrait
    // en simplifiant groupe par groupe. Seulement affiché en vue agrégée
    // (pas de filtre par groupe actif) avec plusieurs groupes de la même
    // devise — un seul groupe donnerait exactement le même résultat que sa
    // propre section "pour équilibrer".
    var globalSuggestions = '';
    if (!filterId && !mixedCurrencies && state.groups.length > 1) {
      var allMemberIds = [];
      state.groups.forEach(function (g) {
        g.memberIds.forEach(function (id) { if (allMemberIds.indexOf(id) === -1) allMemberIds.push(id); });
      });
      var globalTxns = calc.simplify(globalDebts, allMemberIds);
      if (globalTxns.length) {
        globalSuggestions = '<div class="section-label" style="margin-top:18px">Pour équilibrer (tous les groupes)</div>' +
          globalTxns.map(function (t) {
            return '<div class="suggestion-row"><div><b>' + escapeHtml(person(t.from).name) + '</b> → <b>' + escapeHtml(person(t.to).name) + '</b></div>' +
              '<div style="display:flex;align-items:center;gap:8px"><div class="suggestion-amount">' + fmtC(t.amount) + '</div>' +
              '<button class="btn-icon-settle pressable" title="Enregistrer ce paiement" aria-label="Enregistrer ce paiement" data-action="quickSettle" data-from="' + t.from + '" data-to="' + t.to + '" data-amount="' + t.amount + '" data-group-id=""><i class="ph-bold ph-check-circle"></i></button>' +
              '</div></div>';
          }).join('');
      }
    }

    return (
      renderGroupFilterPills(filterId, 'setHomeGroupFilter') +
      '<div class="current-user-row">' +
      '<div class="avatar avatar-26" style="background:' + cu.color + '">' + initials(cu.name) + '</div>' +
      '<div style="font-size:13px;color:var(--text-secondary)">Bonjour, <b style="color:var(--text-primary);font-weight:700">' + escapeHtml(cu.name) + '</b></div>' +
      '</div>' +
      (receivedReminder ?
        '<div class="warning-banner" style="position:relative;padding-right:44px">' +
        '<div class="warning-banner-title"><i class="ph-bold ph-bell-ringing"></i> Rappel reçu</div>' +
        '<div class="warning-banner-body">' +
        (receivedReminder.fromPersonId && person(receivedReminder.fromPersonId) ? escapeHtml(person(receivedReminder.fromPersonId).name) + ' t\'a envoyé un rappel : ' : '') +
        '« ' + escapeHtml(receivedReminder.message) + ' »' +
        '</div>' +
        '<button class="icon-btn pressable" style="position:absolute;top:10px;right:10px;width:28px;height:28px" data-action="dismissReminderBanner" data-id="' + receivedReminder.id + '" aria-label="Ignorer"><i class="ph-bold ph-x"></i></button>' +
        '</div>' : '') +
      (state.groups.length === 0 ?
        '<div style="font-size:13px;color:var(--text-tertiary);margin-bottom:16px">Crée un groupe et invite des amis pour commencer à suivre vos dépenses.</div>' +
        '<button class="btn-primary pressable" data-action="openAddGroup">Créer un groupe</button>' :
      mixedCurrencies ?
        '<div class="warning-banner"><div class="warning-banner-title"><i class="ph-bold ph-coins"></i> Devises multiples</div>' +
        '<div class="warning-banner-body">Tes groupes utilisent des devises différentes — choisis un groupe ci-dessus pour voir ton solde.</div></div>' :
        '<div class="balance-card">' +
        '<div class="balance-label">Solde net total' + (filterGroup ? ' · ' + escapeHtml(filterGroup.name) : '') + '</div>' +
        '<div class="balance-amount" style="color:' + colorForBalance(sum) + '">' + (sum >= 0 ? '+' : '-') + fmtC(Math.abs(sum)).replace('-', '') + '</div>' +
        '<div class="balance-detail-row"><div class="owed">On te doit ' + fmtC(owed).replace('-', '') + '</div><div class="owe">Tu dois ' + fmtC(owe).replace('-', '') + '</div></div>' +
        '</div>') +
      (!mixedCurrencies && pendingShare > 0.5 ?
        '<div class="warning-banner"><div class="warning-banner-title"><i class="ph-bold ph-clock-countdown"></i> À anticiper</div>' +
        '<div class="warning-banner-body">Un acompte n\'est pas encore payé en totalité. Ta part : ' + fmtC(pendingShare) + '.</div></div>' : '') +
      (!mixedCurrencies && otherPeople.length > 0 ? '<div class="section-label">Par personne</div>' + rows : '') +
      globalSuggestions
    );
  }

  function renderGroups() {
    var moi = state.currentUserId;
    var cards = state.groups.map(function (g) {
      var bal = netBalanceFor(moi, g.id);
      var names = g.memberIds.map(function (id) { return person(id).name; }).join(', ');
      var summary = Math.abs(bal) < 0.5 ? 'Équilibré' : (bal > 0 ? '+' + fmtIn(bal, g.currency) : fmtIn(bal, g.currency));
      return (
        '<button class="group-card pressable" data-action="openGroup" data-id="' + g.id + '">' +
        '<div class="group-icon"><i class="' + g.icon + '"></i></div>' +
        '<div style="flex:1;text-align:left">' +
        '<div class="group-name">' + escapeHtml(g.name) + '</div>' +
        '<div class="group-members">' + escapeHtml(names) + '</div>' +
        '</div>' +
        '<div class="group-summary" style="color:' + colorForBalance(bal) + '">' + summary + '</div>' +
        '</button>'
      );
    }).join('');
    return cards + '<button class="dashed-btn pressable" data-action="openAddGroup">+ Nouveau groupe / événement</button>';
  }

  // Regroupe les membres d'un groupe partageant un même foyer en une seule
  // "unité" d'affichage (vue consolidée par foyer) : paid/part/solde
  // sommés, membres listés en sous-titre. Le moteur de calcul (calc.js)
  // continue de travailler personne par personne — cette consolidation
  // est purement un regroupement d'affichage, appliqué seulement aux
  // membres qui ont effectivement un foyer commun dans ce groupe.
  function computeGroupUnits(g, effectiveIds) {
    var groupHouseholds = state.households.filter(function (h) { return h.groupId === g.id; });
    var units = [];
    var unitByHousehold = {};
    effectiveIds.forEach(function (pid) {
      var p = person(pid);
      var h = p.householdId ? groupHouseholds.find(function (x) { return x.id === p.householdId; }) : null;
      if (!h) { units.push({ key: pid, label: p.name, memberIds: [pid] }); return; }
      var existing = unitByHousehold[h.id];
      if (existing) { existing.memberIds.push(pid); return; }
      var unit = { key: 'foyer:' + h.id, label: h.name, memberIds: [pid] };
      unitByHousehold[h.id] = unit;
      units.push(unit);
    });
    return units;
  }

  // Reprend les suggestions de règlement calculées personne par personne
  // (calc.simplify) et les consolide par foyer : un règlement entre deux
  // membres d'un même foyer devient interne (plus besoin de le suggérer),
  // et les montants entre deux mêmes foyers/personnes sont additionnés en
  // une seule suggestion nette.
  function consolidateSuggestionsByUnit(txns, units) {
    var unitKeyOfPerson = {}, labelOfUnit = {}, soloIdOfUnit = {};
    units.forEach(function (u) {
      labelOfUnit[u.key] = u.label;
      // Un raccourci "enregistrer" n'a de sens que si l'unité représente une
      // seule personne (pas un foyer consolidé, où on ne sait pas laquelle
      // des deux personnes règle concrètement).
      soloIdOfUnit[u.key] = u.memberIds.length === 1 ? u.memberIds[0] : null;
      u.memberIds.forEach(function (pid) { unitKeyOfPerson[pid] = u.key; });
    });
    var totals = {};
    txns.forEach(function (t) {
      var fu = unitKeyOfPerson[t.from], tu = unitKeyOfPerson[t.to];
      if (!fu || !tu || fu === tu) return;
      var k = fu + '>' + tu;
      totals[k] = (totals[k] || 0) + t.amount;
    });
    var seen = {}, out = [];
    Object.keys(totals).forEach(function (k) {
      if (seen[k]) return;
      seen[k] = true;
      var parts = k.split('>'), fu = parts[0], tu = parts[1];
      var revKey = tu + '>' + fu;
      var amt = totals[k];
      if (totals[revKey] != null) {
        seen[revKey] = true;
        var net = amt - totals[revKey];
        if (Math.abs(net) < 0.005) return;
        if (net > 0) out.push({ fromLabel: labelOfUnit[fu], toLabel: labelOfUnit[tu], amount: net, fromId: soloIdOfUnit[fu], toId: soloIdOfUnit[tu] });
        else out.push({ fromLabel: labelOfUnit[tu], toLabel: labelOfUnit[fu], amount: -net, fromId: soloIdOfUnit[tu], toId: soloIdOfUnit[fu] });
      } else {
        out.push({ fromLabel: labelOfUnit[fu], toLabel: labelOfUnit[tu], amount: amt, fromId: soloIdOfUnit[fu], toId: soloIdOfUnit[tu] });
      }
    });
    return out;
  }

  function setGroupUnitMode(mode) { setState({ groupUnitMode: mode }); }

  function renderGroupDetail() {
    var g = group(state.selectedGroupId);
    if (!g) return '';
    var moi = state.currentUserId;
    var isAdmin = g.adminId === moi;
    var debts = computeDebtsForGroup(g.id);
    // Montant nominal de chaque dépense (e.amount), pas paidExternal — même
    // convention que la ligne de dépense elle-même (cf. expenseAmountLabel),
    // pour que ce total corresponde à ce qu'on voit en additionnant la liste.
    var totalExpenses = state.expenses.filter(function (e) { return e.groupId === g.id; })
      .reduce(function (a, e) { return a + e.amount; }, 0);

    // Un retrait de "gérer les membres" enlève l'adhésion au groupe, mais un
    // solde non réglé doit rester visible ici (les dépenses passées restent
    // comptées dans les calculs) : on réintègre à l'affichage toute personne
    // qui a un solde non nul dans ce groupe même si elle n'en est plus membre.
    var effectiveIds = g.memberIds.slice();
    state.people.forEach(function (p) {
      if (effectiveIds.indexOf(p.id) !== -1) return;
      var hasExpenseHere = state.expenses.some(function (e) { return e.groupId === g.id && (e.paidBy === p.id || e.participants.indexOf(p.id) !== -1); });
      if (!hasExpenseHere) return;
      if (Math.abs(netBalanceFor(p.id, g.id)) > 0.5) effectiveIds.push(p.id);
    });

    // La vue "par foyer / par membre" (bouton commun aux deux sections
    // ci-dessous) n'est proposée que si au moins un foyer regroupe
    // effectivement plusieurs membres de ce groupe, sinon les deux vues
    // seraient strictement identiques.
    var units = computeGroupUnits(g, effectiveIds);
    var hasFoyerConsolidation = units.some(function (u) { return u.memberIds.length > 1; });
    var identityUnits = effectiveIds.map(function (pid) { return { key: pid, label: person(pid).name, memberIds: [pid] }; });
    var activeUnits = hasFoyerConsolidation && state.groupUnitMode === 'membre' ? identityUnits : units;
    var groupUnitToggle = !hasFoyerConsolidation ? '' :
      '<div class="pill-row" style="margin-bottom:10px">' +
      '<div class="pill' + (state.groupUnitMode !== 'membre' ? ' active' : '') + '" data-action="setGroupUnitMode" data-id="foyer">Par foyer</div>' +
      '<div class="pill' + (state.groupUnitMode === 'membre' ? ' active' : '') + '" data-action="setGroupUnitMode" data-id="membre">Par membre</div>' +
      '</div>';

    // En-têtes de colonnes alignées sur .col-num/.col-bal — sans elles, les
    // trois nombres de chaque ligne (payé / part / solde) n'étaient
    // distinguables qu'en devinant leur position.
    var memberTableHeader =
      '<div style="display:flex;align-items:center;gap:10px;padding:0 0 6px">' +
      '<div style="width:30px;flex-shrink:0"></div><div style="flex:1"></div>' +
      '<div class="col-num" style="color:var(--text-tertiary);font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.05em">Payé</div>' +
      '<div class="col-num" style="color:var(--text-tertiary);font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.05em">Part</div>' +
      '<div class="col-bal" style="color:var(--text-tertiary);font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.05em">Solde</div>' +
      '</div>';

    var memberRows = activeUnits.map(function (u) {
      var isHousehold = u.memberIds.length > 1;
      var paid = 0, share = 0, bal = 0;
      u.memberIds.forEach(function (pid) {
        paid += state.expenses.filter(function (e) { return e.groupId === g.id && e.paidBy === pid; })
          .reduce(function (a, e) { return a + (e.paidExternal != null ? e.paidExternal : e.amount); }, 0);
        state.expenses.filter(function (e) { return e.groupId === g.id && e.participants.indexOf(pid) !== -1; }).forEach(function (e) {
          var effAmount = e.paidExternal != null ? e.paidExternal : e.amount;
          var shares = calc.computeShares(effAmount, e.participants, state.people);
          share += shares[pid] || 0;
        });
        bal += netBalanceFor(pid, g.id);
      });

      if (!isHousehold) {
        var pid0 = u.memberIds[0];
        var p = person(pid0);
        var isExMember = g.memberIds.indexOf(pid0) === -1;
        var covered = p.guardianId ? person(p.guardianId) : null;
        var balLabel = covered ? '→ ' + covered.name : (Math.abs(bal) < 0.5 ? '0,00' : fmtIn(bal, g.currency));
        var balColor = covered ? 'var(--status-neutral)' : colorForBalance(bal);
        return (
          '<div class="member-row">' +
          '<div class="avatar avatar-30" style="background:' + p.color + '">' + initials(p.name) + '</div>' +
          '<div class="col-name">' + escapeHtml(p.name) + (isExMember ? '<span class="badge-child inline">Ex-membre</span>' : '') + shareBadge(p, true) + '</div>' +
          '<div class="col-num">' + fmtIn(paid, g.currency) + '</div>' +
          '<div class="col-num">' + fmtIn(share, g.currency) + '</div>' +
          '<div class="col-bal" style="color:' + balColor + '">' + escapeHtml(balLabel) + '</div>' +
          '</div>'
        );
      }

      var memberNames = u.memberIds.map(function (pid) { return person(pid).name; }).join(', ');
      var balLabelH = Math.abs(bal) < 0.5 ? '0,00' : fmtIn(bal, g.currency);
      return (
        '<div class="member-row">' +
        '<div class="avatar avatar-30" style="background:var(--surface-overlay);color:var(--text-secondary)"><i class="ph-bold ph-house-line"></i></div>' +
        '<div class="col-name">' + escapeHtml(u.label) + '<span class="badge-child inline">Foyer</span>' +
        '<div style="font-size:11px;font-weight:400;color:var(--text-tertiary);margin-top:2px">' + escapeHtml(memberNames) + '</div></div>' +
        '<div class="col-num">' + fmtIn(paid, g.currency) + '</div>' +
        '<div class="col-num">' + fmtIn(share, g.currency) + '</div>' +
        '<div class="col-bal" style="color:' + colorForBalance(bal) + '">' + escapeHtml(balLabelH) + '</div>' +
        '</div>'
      );
    }).join('');

    var txns = consolidateSuggestionsByUnit(calc.simplify(debts, effectiveIds), activeUnits);
    var suggestions = txns.map(function (t) {
      var canSettle = t.fromId && t.toId;
      return '<div class="suggestion-row"><div><b>' + escapeHtml(t.fromLabel) + '</b> → <b>' + escapeHtml(t.toLabel) + '</b></div>' +
        '<div style="display:flex;align-items:center;gap:8px"><div class="suggestion-amount">' + fmtIn(t.amount, g.currency) + '</div>' +
        (canSettle ? '<button class="btn-icon-settle pressable" title="Enregistrer ce paiement" aria-label="Enregistrer ce paiement" data-action="quickSettle" data-from="' + t.fromId + '" data-to="' + t.toId + '" data-amount="' + t.amount + '" data-group-id="' + g.id + '"><i class="ph-bold ph-check-circle"></i></button>' : '') +
        '</div></div>';
    }).join('');

    var expenseRows = state.expenses.filter(function (e) { return e.groupId === g.id; })
      .slice().sort(function (a, b) { return b.date.localeCompare(a.date); })
      .map(function (e) {
        return (
          '<div class="expense-row pressable" data-action="editExpense" data-id="' + e.id + '">' +
          '<div class="expense-icon"><i class="' + e.icon + '"></i></div>' +
          '<div style="flex:1;min-width:0">' +
          '<div class="expense-label">' + escapeHtml(e.label) + (e.receiptPath ? ' <i class="ph-bold ph-paperclip" style="font-size:12px;color:var(--text-tertiary)"></i>' : '') + '</div>' +
          '<div class="expense-subtitle">Payé par ' + escapeHtml(person(e.paidBy).name) + ' · ' + fmtDate(e.date) + ' · ' + e.participants.length + ' pers.</div>' +
          '</div><div class="expense-amount">' + expenseAmountLabel(e, g.currency) + '</div></div>'
        );
      }).join('');

    return (
      '<div class="balance-card pressable" data-action="goExpensesForGroup" data-id="' + g.id + '">' +
      '<div class="balance-label">Total des dépenses</div>' +
      '<div class="balance-amount" style="color:var(--text-primary)">' + escapeHtml(fmtIn(totalExpenses, g.currency)) + '</div>' +
      '</div>' +
      '<div class="member-table"><div class="section-label">Payé / part / solde</div>' + groupUnitToggle + memberTableHeader + memberRows + '</div>' +
      (txns.length || hasFoyerConsolidation ?
        // Le même bascule Par foyer/Par membre qu'au-dessus de "Payé / part /
        // solde", répété ici : sans lui, quelqu'un qui arrive directement sur
        // "Pour équilibrer" (la section la plus consultée) ne fait pas le
        // lien que les pastilles tout en haut de l'écran contrôlent aussi ce
        // qu'il regarde ici, et croit à tort qu'aucune vue par individu
        // n'existe une fois des foyers créés.
        '<div class="section-label">Pour équilibrer</div>' + groupUnitToggle +
        (txns.length ? suggestions : '<div style="font-size:13px;color:var(--text-tertiary);margin-bottom:14px">Rien à régler pour le moment.</div>') : '') +
      '<div class="section-label" style="margin-top:18px">Dépenses</div>' + expenseRows +
      '<button class="btn-primary pressable" style="margin-top:18px" data-action="openAddExpenseForGroup">Ajouter une dépense</button>'
    );
  }

  function renderPersonDetail() {
    var p = person(state.selectedPersonId);
    if (!p) return '';
    var moi = state.currentUserId;
    var filterId = state.personGroupFilter && group(state.personGroupFilter) ? state.personGroupFilter : null;
    var filterGroup = filterId ? group(filterId) : null;
    var fmtC = function (n) { return fmtIn(n, filterGroup ? filterGroup.currency : null); };
    var bal = filterId ? pairNet(moi, p.id, computeDebtsForGroup(filterId)) : pairNet(moi, p.id);
    var covered = p.guardianId ? person(p.guardianId) : null;
    var lastReminder = state.reminders.slice().reverse().find(function (r) { return r.toPersonId === p.id; });
    var relatedExpenses = state.expenses.filter(function (e) {
      return (e.participants.indexOf(p.id) !== -1 || e.paidBy === p.id) && (!filterId || e.groupId === filterId);
    }).slice().sort(function (a, b) { return b.date.localeCompare(a.date); });

    var amountLabel = Math.abs(bal) < 0.5 ? 'À jour' : (bal > 0 ? 'Te doit ' + fmtC(bal) : 'Tu dois ' + fmtC(-bal));

    return (
      renderGroupFilterPills(filterId, 'setPersonGroupFilter') +
      '<div class="person-header">' +
      '<div class="avatar avatar-64" style="background:' + p.color + '">' + initials(p.name) + '</div>' +
      '<div class="person-header-name">' + escapeHtml(p.name) + '</div>' +
      (hasCustomWeight(p) ? '<div style="margin-top:8px">' + shareBadge(p, false) + '</div>' : '') +
      (covered ? '<div class="covered-note" style="margin-top:6px">Pris en charge par ' + escapeHtml(covered.name) + '</div>' : '') +
      '<div class="person-header-amount" style="color:' + colorForBalance(bal) + '">' + escapeHtml(amountLabel) + '</div>' +
      '</div>' +
      '<div class="person-actions">' +
      (bal > 0.5 ? '<button class="btn-danger-fill pressable" data-action="remind" data-id="' + p.id + '" data-group-id="' + (filterId || '') + '"><i class="ph-bold ph-bell-ringing" style="margin-right:6px"></i>Envoyer un rappel</button>' : '') +
      '<button class="btn-outline-flex pressable" data-action="openSettle" data-id="' + p.id + '" data-group-id="' + (filterId || '') + '">Enregistrer un paiement</button>' +
      '</div>' +
      // bal > 0.5 : une fois le solde revenu à jour, le message d'un ancien
      // rappel ("tu me dois encore X") devient faux et trompeur — inutile
      // de le garder affiché juste parce qu'un rappel a existé un jour.
      (lastReminder && bal > 0.5 ? '<div class="reminder-preview">' + escapeHtml(lastReminder.message) + '</div>' : '') +
      '<div class="section-label">Dépenses concernées</div>' +
      relatedExpenses.map(function (e) {
        var eg = group(e.groupId);
        return '<div class="person-expense-row"><i class="' + e.icon + '" style="color:var(--text-secondary);font-size:15px;width:18px;text-align:center"></i>' +
          '<div style="flex:1;font-size:13.5px;color:var(--text-primary)">' + escapeHtml(e.label) + '</div>' +
          '<div style="font-size:13px;font-weight:600;color:var(--text-secondary)">' + fmtIn(e.amount, eg && eg.currency) + '</div></div>';
      }).join('')
    );
  }

  function renderAllExpenses() {
    var filterId = state.expensesGroupFilter && group(state.expensesGroupFilter) ? state.expensesGroupFilter : null;
    var filterGroup = filterId ? group(filterId) : null;
    var fmtC = function (n) { return fmtIn(n, filterGroup ? filterGroup.currency : null); };
    var expenses = filterId ? state.expenses.filter(function (e) { return e.groupId === filterId; }) : state.expenses;
    var payments = filterId ? state.payments.filter(function (p) { return p.groupId === filterId; }) : state.payments;
    var statuses = calc.computeExpenseStatuses(state.people, expenses, payments);
    var total = expenses.reduce(function (a, e) { return a + e.amount; }, 0);
    var totalOwed = Object.values(statuses).reduce(function (a, st) { return a + st.owed; }, 0);
    var totalRemaining = Object.values(statuses).reduce(function (a, st) { return a + st.remaining; }, 0);
    var totalDueExternal = expenses.reduce(function (a, e) { return a + (e.amount - (e.paidExternal != null ? e.paidExternal : e.amount)); }, 0);

    var searchQuery = (state.expensesSearchQuery || '').trim().toLowerCase();
    var personFilter = state.expensesPersonFilter || null;
    var categoryFilter = state.expensesCategoryFilter || null;
    var statusFilter = state.expensesStatusFilter || null;
    var amountMin = parseFloat((state.expensesAmountMin || '').replace(',', '.'));
    var amountMax = parseFloat((state.expensesAmountMax || '').replace(',', '.'));
    var visibleExpenses = expenses.filter(function (e) {
      if (personFilter && e.paidBy !== personFilter && e.participants.indexOf(personFilter) === -1) return false;
      if (categoryFilter && categoryForIcon(e.icon) !== categoryFilter) return false;
      if (statusFilter && (!statuses[e.id] || statuses[e.id].status !== statusFilter)) return false;
      if (!isNaN(amountMin) && e.amount < amountMin) return false;
      if (!isNaN(amountMax) && e.amount > amountMax) return false;
      if (!expenseDateMatchesFilter(e, state.expensesDatePreset, state.expensesDateFrom, state.expensesDateTo)) return false;
      if (!searchQuery) return true;
      var g = group(e.groupId);
      return e.label.toLowerCase().indexOf(searchQuery) !== -1
        || person(e.paidBy).name.toLowerCase().indexOf(searchQuery) !== -1
        || (g && g.name.toLowerCase().indexOf(searchQuery) !== -1);
    });

    var sortComparators = {
      date_desc: function (a, b) { return b.date.localeCompare(a.date); },
      date_asc: function (a, b) { return a.date.localeCompare(b.date); },
      amount_desc: function (a, b) { return b.amount - a.amount; },
      amount_asc: function (a, b) { return a.amount - b.amount; },
    };
    var sortBy = sortComparators[state.expensesSort] ? state.expensesSort : 'date_desc';
    var rows = visibleExpenses.slice().sort(sortComparators[sortBy]).map(function (e) {
      var g = group(e.groupId);
      var cur = g && g.currency;
      var st = statuses[e.id];
      var paidExternal = e.paidExternal != null ? e.paidExternal : e.amount;
      var dueExternal = e.amount - paidExternal;
      return (
        '<div class="expense-row">' +
        '<div class="expense-icon pressable" data-action="editExpense" data-id="' + e.id + '"><i class="' + e.icon + '"></i></div>' +
        '<div style="flex:1;min-width:0;cursor:pointer" data-action="editExpense" data-id="' + e.id + '">' +
        '<div class="expense-label">' + escapeHtml(e.label) + (e.receiptPath ? ' <i class="ph-bold ph-paperclip" style="font-size:12px;color:var(--text-tertiary)"></i>' : '') + '</div>' +
        '<div class="expense-subtitle">' + (g ? escapeHtml(g.name) + ' · ' : '') + 'payé par ' + escapeHtml(person(e.paidBy).name) + ' · ' + fmtDate(e.date) + ' · ' + e.participants.length + ' pers.</div>' +
        '<div class="expense-meta-row">' +
        '<span class="status-badge" style="color:' + st.color + ';background:' + st.bg + '">' + st.status + '</span>' +
        (st.remaining > 0.5 ? '<span style="font-size:11px;color:var(--text-tertiary)">' + fmtIn(st.remaining, cur) + ' restant entre vous</span>' : '') +
        '</div>' +
        (dueExternal > 0.5 ?
          '<div class="due-external">acompte versé ' + fmtIn(paidExternal, cur) + ' · reste ' + fmtIn(dueExternal, cur) + ' à verser au bailleur</div>' +
          '<button class="mark-paid-link" data-action="markPaidFull" data-id="' + e.id + '">Marquer réglé en totalité →</button>' : '') +
        '</div>' +
        '<div class="expense-amount">' + expenseAmountLabel(e, cur) + '</div>' +
        '</div>'
      );
    }).join('');

    var mixedCurrencies = !filterId && !groupsHaveSingleCurrency();
    var activeChips = activeExpenseFilterChips();

    return (
      (mixedCurrencies ?
        '<div class="warning-banner"><div class="warning-banner-title"><i class="ph-bold ph-coins"></i> Devises multiples</div>' +
        '<div class="warning-banner-body">Tes groupes utilisent des devises différentes — choisis un groupe dans les filtres pour voir les totaux.</div></div>' :
        '<div class="summary-cards">' +
        '<div class="summary-card"><div class="summary-card-label">Total</div><div class="summary-card-value" style="color:var(--text-primary)">' + fmtC(total) + '</div></div>' +
        '<div class="summary-card"><div class="summary-card-label">Remboursé</div><div class="summary-card-value" style="color:var(--status-positive)">' + fmtC(totalOwed - totalRemaining) + '</div></div>' +
        '<div class="summary-card"><div class="summary-card-label">Restant dû</div><div class="summary-card-value" style="color:var(--status-danger)">' + fmtC(totalRemaining) + '</div></div>' +
        '</div>' +
        (totalDueExternal > 0.5 ? '<div class="warning-banner" style="padding:10px 14px;font-size:12.5px">' + fmtC(totalDueExternal) + ' restent à verser à des tiers (acomptes non soldés)</div>' : '')) +
      (expenses.length > 0 ?
        '<div style="display:flex;gap:8px;margin-bottom:10px">' +
        '<input class="text-input" style="margin-bottom:0;flex:1" data-bind="expensesSearch" placeholder="Rechercher une dépense..." value="' + escapeHtml(state.expensesSearchQuery) + '" />' +
        '<select class="text-input" style="margin-bottom:0;width:auto;flex-shrink:0" data-bind-change="expensesSort">' +
        '<option value="date_desc"' + (sortBy === 'date_desc' ? ' selected' : '') + '>Plus récentes</option>' +
        '<option value="date_asc"' + (sortBy === 'date_asc' ? ' selected' : '') + '>Plus anciennes</option>' +
        '<option value="amount_desc"' + (sortBy === 'amount_desc' ? ' selected' : '') + '>Montant décroissant</option>' +
        '<option value="amount_asc"' + (sortBy === 'amount_asc' ? ' selected' : '') + '>Montant croissant</option>' +
        '</select>' +
        '<button class="icon-btn pressable" style="position:relative" data-action="toggleExpenseFilters" aria-label="Filtres"><i class="ph-bold ph-funnel"></i>' +
        (activeChips.length ? '<span class="filter-count-badge">' + activeChips.length + '</span>' : '') +
        '</button>' +
        '</div>' +
        renderExpenseFilterChips(activeChips) : '') +
      (expenses.length === 0 ? '<div style="font-size:13px;color:var(--text-tertiary);margin-bottom:16px">Aucune dépense dans ce groupe.</div>' :
        visibleExpenses.length === 0 ? '<div style="font-size:13px;color:var(--text-tertiary);margin-bottom:16px">' +
          (searchQuery ? 'Aucune dépense ne correspond à « ' + escapeHtml(state.expensesSearchQuery) + ' ».' :
            'Aucune dépense ne correspond à ces filtres.' + (activeChips.length ? ' <span class="select-all-link" data-action="resetExpenseFilters">Réinitialiser</span>' : '')) +
          '</div>' : rows) +
      // Les deux boutons côte à côte, même gabarit : "Ajouter une dépense"
      // reste l'action par défaut (émeraude), "Qui doit quoi à qui" (fuchsia,
      // cf. .btn-accent-fill) marque le passage à l'étape suivante une fois
      // qu'il n'y a plus de nouvelle dépense à saisir — renvoie vers la vue
      // "Pour équilibrer" pertinente (fiche du groupe filtré, ou accueil en
      // vue agrégée) plutôt que de dupliquer ce calcul ici.
      '<div style="display:flex;gap:10px;margin-top:18px">' +
      '<button class="btn-primary pressable" style="width:auto;flex:1" data-action="openAddExpenseGlobal" data-id="' + (filterId || '') + '">Ajouter une dépense</button>' +
      '<button class="btn-accent-fill pressable" data-action="goSettleFromExpenses" data-id="' + (filterId || '') + '">Qui doit quoi à qui →</button>' +
      '</div>'
    );
  }

  function renderHistory() {
    var items = [];
    state.expenses.forEach(function (e) {
      var g = group(e.groupId);
      items.push({ date: e.date, icon: e.icon, iconBg: 'var(--surface-overlay)', iconColor: 'var(--text-secondary)', text: escapeHtml(person(e.paidBy).name) + ' a payé « ' + escapeHtml(e.label) + ' »' + (g ? ' · ' + escapeHtml(g.name) : ''), amountLabel: fmtIn(e.amount, g && g.currency), color: 'var(--text-primary)' });
    });
    state.payments.forEach(function (p) {
      var pg = p.groupId ? group(p.groupId) : null;
      var methodLabel = p.paymentMethod ? PAYMENT_METHOD_LABELS[p.paymentMethod] : null;
      items.push({
        date: p.date, icon: 'ph-bold ph-check-circle', iconBg: 'var(--status-positive-bg)', iconColor: 'var(--status-positive)',
        text: escapeHtml(person(p.from).name) + ' → ' + escapeHtml(person(p.to).name) + (methodLabel ? ' · ' + escapeHtml(methodLabel) : ''),
        amountLabel: fmtIn(p.amount, pg && pg.currency), color: 'var(--status-positive)',
      });
    });
    state.reminders.forEach(function (r) {
      var rg = r.groupId ? group(r.groupId) : null;
      // Écrit du point de vue de la personne qui consulte : « tu as reçu »
      // quand elle est destinataire, « rappel envoyé à » sinon — un même
      // rappel restant visible aux deux (cf. policy RLS reminders_select),
      // le texte générique côté expéditeur sonnait faux pour le destinataire.
      var reminderText = r.toPersonId === state.currentUserId
        ? 'Tu as reçu un rappel' + (r.fromPersonId && person(r.fromPersonId) ? ' de ' + escapeHtml(person(r.fromPersonId).name) : '')
        : 'Rappel envoyé à ' + escapeHtml(person(r.toPersonId).name);
      items.push({ date: r.date, icon: 'ph-bold ph-bell-ringing', iconBg: 'var(--status-danger-bg)', iconColor: 'var(--status-danger)', text: reminderText + (rg ? ' · ' + escapeHtml(rg.name) : ''), amountLabel: null, color: null });
    });
    return items.sort(function (a, b) { return b.date.localeCompare(a.date); }).map(function (h) {
      return (
        '<div class="history-row">' +
        '<div class="history-icon" style="background:' + h.iconBg + ';color:' + h.iconColor + '"><i class="' + h.icon + '"></i></div>' +
        '<div style="flex:1;min-width:0"><div class="history-text">' + h.text + '</div><div class="history-date">' + fmtDate(h.date) + '</div></div>' +
        (h.amountLabel ? '<div class="history-amount" style="color:' + h.color + '">' + h.amountLabel + '</div>' : '') +
        '</div>'
      );
    }).join('');
  }

  function renderAboutScreen() {
    // Landing accessible avant connexion, ou connecté mais pas encore "entré"
    // dans l'app (nav dédiée, cf. renderAboutFromLogin — la racine du site
    // affiche toujours cette landing, cf. commentaire sur `enteredApp` dans
    // defaultState), ou depuis le menu compte une fois dans l'app (cf.
    // openAbout) : les CTA n'ont de sens que dans les deux premiers cas, et
    // pointent vers l'inscription si anonyme, vers l'app si déjà connecté.
    var L = landingT();
    var showCtas = !state.loggedIn || !state.enteredApp;
    var ctaAction = state.loggedIn ? 'enterApp' : 'ctaSignupFromAbout';
    var ctaLabel = state.loggedIn ? L.navOpenApp : L.ctaSignup;
    var ctaRow =
      '<div class="ldg-ctas">' +
      (showCtas ? '<button class="btn-primary pressable" data-action="' + ctaAction + '">' + ctaLabel + '</button>' : '') +
      '<a class="btn-outline ldg-demo-link" href="#ldg-demo" style="flex:none;width:auto;padding:13px 22px;text-decoration:none;display:inline-flex;align-items:center">' + L.ctaWatchDemo + '</a>' +
      '</div>';
    return (
      '<div class="about-screen">' +
      '<div class="ldg-container">' +

      '<header class="ldg-hero">' +
      '<div class="ldg-hero-grid">' +
      '<div class="ldg-hero-copy">' +
      '<span class="ldg-eyebrow">' + L.heroEyebrow + '</span>' +
      '<h1>' + L.heroH1Main +
      '<span class="ldg-h1-sub">' + L.heroH1Sub + '</span>' +
      '</h1>' +
      '<p class="ldg-lede">' + L.heroLede + '</p>' +
      ctaRow +
      '<div class="ldg-hero-badge"><svg class="ldg-flag-mg" viewBox="0 0 30 20" width="18" height="12" aria-hidden="true"><rect width="30" height="20" fill="#fff"></rect><rect x="12" width="18" height="10" fill="#FC3D32"></rect><rect x="12" y="10" width="18" height="10" fill="#007E3A"></rect></svg> ' + L.heroBadge + '</div>' +
      '</div>' +
      '<div class="ldg-hero-stack">' +
      '<div class="ldg-phone back"><div class="ldg-screen"><img src="assets/landing/01-home-mobile.png" alt="' + escapeHtml(L.heroImgAlt1) + '"></div></div>' +
      '<div class="ldg-phone"><div class="ldg-screen"><img src="assets/landing/02-group-detail-mobile.png" alt="' + escapeHtml(L.heroImgAlt2) + '"></div></div>' +
      '</div>' +
      '</div>' +
      '</header>' +

      '<section class="ldg-section" id="ldg-probleme" data-reveal="ldg-probleme">' +
      '<div class="ldg-section-head">' +
      '<span class="ldg-eyebrow">' + L.problemEyebrow + '</span>' +
      '<h2>' + L.problemH2 + '</h2>' +
      '</div>' +
      '<ul class="ldg-problem-list" style="max-width:60ch">' +
      '<li><p style="margin:0">' + L.problem1 + '</p></li>' +
      '<li><p style="margin:0">' + L.problem2 + '</p></li>' +
      '<li><p style="margin:0">' + L.problem3 + '</p></li>' +
      '<li><p style="margin:0">' + L.problem4 + '</p></li>' +
      '</ul>' +
      '<p style="font-size:14.5px;color:var(--text-secondary);max-width:60ch;margin-top:24px">' + L.problemFooter + '</p>' +
      '</section>' +

      '<section class="ldg-section" id="ldg-difference" data-reveal="ldg-difference">' +
      '<div class="ldg-section-head">' +
      '<span class="ldg-eyebrow">' + L.differenceEyebrow + '</span>' +
      '<h2>' + L.differenceH2 + '</h2>' +
      '</div>' +
      '<div class="ldg-mechlist">' +
      '<div class="ldg-mech"><span class="ldg-mech-icon"><i class="ph-bold ph-baby"></i></span><h3>' + L.mech1Title + '</h3><p>' + L.mech1Body + '</p></div>' +
      '<div class="ldg-mech"><span class="ldg-mech-icon" style="background:rgba(214,36,122,.12);color:#D6247A"><i class="ph-bold ph-scales"></i></span><h3>' + L.mech2Title + '</h3><p>' + L.mech2Body + '</p></div>' +
      '<div class="ldg-mech"><span class="ldg-mech-icon" style="background:rgba(201,161,89,.18);color:#8a6a30"><i class="ph-bold ph-target"></i></span><h3>' + L.mech3Title + '</h3><p>' + L.mech3Body + '</p></div>' +
      '<div class="ldg-mech"><span class="ldg-mech-icon"><i class="ph-bold ph-calculator"></i></span><h3>' + L.mech4Title + '</h3><p>' + L.mech4Body + '</p></div>' +
      '</div>' +
      '<div class="ldg-compare-label">' + L.compareEyebrow + '</div>' +
      '<table class="ldg-compare">' +
      '<thead><tr><th></th><th>' + L.compareColRohy + '</th><th>' + L.compareColOthers + '</th></tr></thead>' +
      '<tbody>' +
      '<tr><td>' + L.compareRow1 + '</td><td class="yes">✓</td><td class="yes">✓</td></tr>' +
      '<tr><td>' + L.compareRow2 + '</td><td class="yes">✓</td><td class="no">' + L.compareRare + '</td></tr>' +
      '<tr><td>' + L.compareRow3 + '</td><td class="yes">✓</td><td class="no">' + L.compareRare + '</td></tr>' +
      '<tr><td>' + L.compareRow4 + '</td><td class="yes">✓</td><td class="no">' + L.compareLimited + '</td></tr>' +
      '<tr><td>' + L.compareRow5 + '</td><td class="yes">✓</td><td class="no">' + L.compareLimited + '</td></tr>' +
      '<tr><td>' + L.compareRow6 + '</td><td class="yes">✓</td><td class="yes">✓</td></tr>' +
      '</tbody>' +
      '</table>' +
      '</section>' +

      '<section class="ldg-section ldg-example" id="ldg-exemple" data-reveal="ldg-exemple">' +
      '<div class="ldg-example-grid">' +
      '<div class="ldg-section-head" style="margin-bottom:0">' +
      '<span class="ldg-eyebrow">' + L.exampleEyebrow + '</span>' +
      '<h2>' + L.exampleH2 + '</h2>' +
      '<p>' + L.exampleP + '</p>' +
      '</div>' +
      '<div class="ldg-infographic">' +
      '<div class="ldg-ig-head"><span class="ldg-ig-icon"><i class="ph-bold ph-receipt"></i></span><span class="ldg-ig-title">' + L.exampleIgTitle + '</span></div>' +
      '<div class="ldg-ig-total">2 000 000 Ar</div>' +
      '<div class="ldg-ig-row"><span class="ldg-ig-name">Hery<span class="ldg-ig-part">· 1 ' + L.exampleShare + '</span></span><span class="ldg-ig-amount">571 429 Ar</span></div>' +
      '<div class="ldg-ig-row"><span class="ldg-ig-name">Voahirana<span class="ldg-ig-part">· 1 ' + L.exampleShare + '</span></span><span class="ldg-ig-amount">571 429 Ar</span></div>' +
      '<div class="ldg-ig-row"><span class="ldg-ig-name">Lala<span class="ldg-ig-part">· 1 ' + L.exampleShare + '</span></span><span class="ldg-ig-amount">571 429 Ar</span></div>' +
      '<div class="ldg-ig-row charge" style="background:rgba(214,36,122,.12)"><span class="ldg-ig-name">Mialy<span class="ldg-ig-part">· 0,5 ' + L.exampleShare + '</span><span class="ldg-ig-tag" style="color:#D6247A;background:rgba(214,36,122,.16)">' + L.exampleCovered + '</span></span><span class="ldg-ig-amount">285 714 Ar</span></div>' +
      '<div class="ldg-ig-foot">' + L.exampleFoot + '</div>' +
      '</div>' +
      '</div>' +
      '</section>' +

      '<section class="ldg-section" id="ldg-comment" data-reveal="ldg-comment">' +
      '<div class="ldg-section-head">' +
      '<span class="ldg-eyebrow">' + L.howEyebrow + '</span>' +
      '<h2>' + L.howH2 + '</h2>' +
      '</div>' +
      '<div class="ldg-steps">' +
      '<div class="ldg-step"><span class="ldg-step-num">1</span><h3>' + L.step1Title + '</h3><p>' + L.step1Body + '</p><div class="ldg-phone sm"><div class="ldg-screen"><img src="assets/landing/07-create-group-mobile.png" alt="' + escapeHtml(L.step1Alt) + '"></div></div></div>' +
      '<div class="ldg-step"><span class="ldg-step-num">2</span><h3>' + L.step2Title + '</h3><p>' + L.step2Body + '</p><div class="ldg-phone sm"><div class="ldg-screen"><img src="assets/landing/04-add-expense-mobile.png" alt="' + escapeHtml(L.step2Alt) + '"></div></div></div>' +
      '<div class="ldg-step"><span class="ldg-step-num">3</span><h3>' + L.step3Title + '</h3><p>' + L.step3Body + '</p><div class="ldg-phone sm"><div class="ldg-screen"><img src="assets/landing/02-group-detail-mobile.png" alt="' + escapeHtml(L.step3Alt) + '"></div></div></div>' +
      '</div>' +
      '</section>' +

      '<section class="ldg-section" id="ldg-usecases" data-reveal="ldg-usecases">' +
      '<div class="ldg-section-head">' +
      '<span class="ldg-eyebrow">' + L.usecasesEyebrow + '</span>' +
      '<h2>' + L.usecasesH2 + '</h2>' +
      '</div>' +
      '<div class="ldg-usecases">' +
      '<div class="ldg-usecase"><span class="ldg-uc-icon"><i class="ph-bold ph-house-line"></i></span><h3>' + L.uc1Title + '</h3><p>' + L.uc1Body + '</p></div>' +
      '<div class="ldg-usecase"><span class="ldg-uc-icon" style="background:rgba(214,36,122,.12);color:#D6247A"><i class="ph-bold ph-gift"></i></span><h3>' + L.uc2Title + '</h3><p>' + L.uc2Body + '</p></div>' +
      '<div class="ldg-usecase"><span class="ldg-uc-icon" style="background:rgba(201,161,89,.18);color:#8a6a30"><i class="ph-bold ph-buildings"></i></span><h3>' + L.uc6Title + '</h3><p>' + L.uc6Body + '</p></div>' +
      '<div class="ldg-usecase"><span class="ldg-uc-icon" style="background:rgba(196,67,42,.14);color:#C4432A"><i class="ph-bold ph-airplane-tilt"></i></span><h3>' + L.uc7Title + '</h3><p>' + L.uc7Body + '</p></div>' +
      '</div>' +
      '</section>' +

      '<section class="ldg-section" id="ldg-demo" data-reveal="ldg-demo">' +
      '<div class="ldg-section-head">' +
      '<span class="ldg-eyebrow">' + L.demoEyebrow + '</span>' +
      '<h2>' + L.demoH2 + '</h2>' +
      '<p>' + L.demoP + '</p>' +
      '</div>' +
      '<div class="ldg-laptop" style="max-width:720px;margin:0 auto">' +
      '<div class="ldg-browser"><div class="ldg-browser-bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="url">rohy-app.com</span></div>' +
      '<img src="assets/landing/06-group-detail-desktop.png" alt="' + escapeHtml(L.demoAlt) + '"></div>' +
      '<div class="ldg-laptop-base"></div>' +
      '</div>' +
      '</section>' +

      '<section class="ldg-section" id="ldg-features" data-reveal="ldg-features">' +
      '<div class="ldg-section-head">' +
      '<span class="ldg-eyebrow">' + L.featuresEyebrow + '</span>' +
      '<h2>' + L.featuresH2 + '</h2>' +
      '</div>' +
      '<div class="ldg-feat-rows">' +
      '<details class="ldg-feat-row"><summary><i class="ph-bold ph-users-three"></i><h3>' + L.feat1Title + '</h3><i class="ph-bold ph-caret-down caret"></i></summary><p>' + L.feat1Body + '</p></details>' +
      '<details class="ldg-feat-row"><summary><i class="ph-bold ph-clock-counter-clockwise"></i><h3>' + L.feat4Title + '</h3><i class="ph-bold ph-caret-down caret"></i></summary><p>' + L.feat4Body + '</p></details>' +
      '<details class="ldg-feat-row"><summary><i class="ph-bold ph-camera"></i><h3>' + L.feat5Title + '</h3><i class="ph-bold ph-caret-down caret"></i></summary><p>' + L.feat5Body + '</p></details>' +
      '<details class="ldg-feat-row"><summary><i class="ph-bold ph-check-circle"></i><h3>' + L.feat6Title + '</h3><i class="ph-bold ph-caret-down caret"></i></summary><p>' + L.feat6Body + '</p></details>' +
      '<details class="ldg-feat-row"><summary><i class="ph-bold ph-link"></i><h3>' + L.feat7Title + '</h3><i class="ph-bold ph-caret-down caret"></i></summary><p>' + L.feat7Body + '</p></details>' +
      '<details class="ldg-feat-row"><summary><i class="ph-bold ph-coins"></i><h3>' + L.feat8Title + '</h3><i class="ph-bold ph-caret-down caret"></i></summary><p>' + L.feat8Body + '</p></details>' +
      '<details class="ldg-feat-row"><summary><i class="ph-bold ph-download-simple"></i><h3>' + L.feat9Title + '</h3><i class="ph-bold ph-caret-down caret"></i></summary><p>' + L.feat9Body + '</p></details>' +
      '<details class="ldg-feat-row"><summary><i class="ph-bold ph-bell-ringing"></i><h3>' + L.feat10Title + '</h3><i class="ph-bold ph-caret-down caret"></i></summary><p>' + L.feat10Body + '</p></details>' +
      '<details class="ldg-feat-row"><summary><i class="ph-bold ph-arrows-merge"></i><h3>' + L.feat11Title + '</h3><i class="ph-bold ph-caret-down caret"></i></summary><p>' + L.feat11Body + '</p></details>' +
      '<details class="ldg-feat-row"><summary><i class="ph-bold ph-currency-circle-dollar"></i><h3>' + L.feat12Title + '</h3><i class="ph-bold ph-caret-down caret"></i></summary><p>' + L.feat12Body + '</p></details>' +
      '</div>' +
      '</section>' +

      '<section class="ldg-section" id="ldg-avis" data-reveal="ldg-avis">' +
      '<div class="ldg-section-head">' +
      '<span class="ldg-eyebrow">' + L.testimonialsEyebrow + '</span>' +
      '<h2>' + L.testimonialsH2 + '</h2>' +
      '</div>' +
      '<div class="ldg-testimonials">' +
      '<div class="ldg-testimonial"><i class="ph-bold ph-quotes"></i><p class="quote">« ' + L.t1Quote + ' »</p><div class="ldg-testimonial-author"><span class="ldg-avatar">T</span><div><div class="ldg-testimonial-name">Tiana</div><div class="ldg-testimonial-meta">' + L.t1Meta + '</div></div></div></div>' +
      '<div class="ldg-testimonial"><i class="ph-bold ph-quotes"></i><p class="quote">« ' + L.t2Quote + ' »</p><div class="ldg-testimonial-author"><span class="ldg-avatar" style="background:#D6247A">R</span><div><div class="ldg-testimonial-name">Ravaka</div><div class="ldg-testimonial-meta">' + L.t2Meta + '</div></div></div></div>' +
      '<div class="ldg-testimonial"><i class="ph-bold ph-quotes"></i><p class="quote">« ' + L.t3Quote + ' »</p><div class="ldg-testimonial-author"><span class="ldg-avatar" style="background:#8a6a30">D</span><div><div class="ldg-testimonial-name">Dina</div><div class="ldg-testimonial-meta">' + L.t3Meta + '</div></div></div></div>' +
      '</div>' +
      '</section>' +

      '<section class="ldg-section" id="ldg-faq" data-reveal="ldg-faq">' +
      '<div class="ldg-section-head">' +
      '<span class="ldg-eyebrow">' + L.faqEyebrow + '</span>' +
      '<h2>' + L.faqH2 + '</h2>' +
      '</div>' +
      '<div class="ldg-faq-list">' +
      '<details class="ldg-faq-item"><summary>' + L.faq1Q + '<i class="ph-bold ph-caret-down caret"></i></summary><p>' + L.faq1A + '</p></details>' +
      '<details class="ldg-faq-item"><summary>' + L.faq2Q + '<i class="ph-bold ph-caret-down caret"></i></summary><p>' + L.faq2A + '</p></details>' +
      '<details class="ldg-faq-item"><summary>' + L.faq3Q + '<i class="ph-bold ph-caret-down caret"></i></summary><p>' + L.faq3A + '</p></details>' +
      '<details class="ldg-faq-item"><summary>' + L.faq4Q + '<i class="ph-bold ph-caret-down caret"></i></summary><p>' + L.faq4A + '</p></details>' +
      '<details class="ldg-faq-item"><summary>' + L.faq5Q + '<i class="ph-bold ph-caret-down caret"></i></summary><p>' + L.faq5A + '</p></details>' +
      '</div>' +
      '</section>' +

      '<div class="ldg-thread-divider" aria-hidden="true"></div>' +
      '<div class="ldg-final" data-reveal="ldg-final">' +
      '<h2>' + L.finalH2 + '</h2>' +
      '<p>' + L.finalP + '</p>' +
      '<div class="ldg-ctas">' +
      (showCtas ? '<button class="btn-primary pressable" data-action="' + ctaAction + '">' + (state.loggedIn ? ctaLabel : L.ctaFinal) + '</button>' : '') +
      '</div>' +
      '</div>' +

      '<footer class="ldg-footer">' +
      '<div class="ldg-footer-top">' +
      '<div class="ldg-footer-brand">' +
      '<div class="about-hero" style="align-items:flex-start;text-align:left">' +
      '<div class="about-logo" style="margin-bottom:8px">' + logoMark(24, '#0F8F6B', '#084b38') + '</div>' +
      '<div class="about-name" style="font-size:17px">Rohy</div>' +
      '</div>' +
      '<p>' + L.footerTagline + '</p>' +
      '</div>' +
      '<div class="ldg-footer-links">' +
      '<div class="ldg-footer-col"><h4>' + L.footerCol1 + '</h4><a href="#ldg-probleme">' + L.footerLinkProblem + '</a><a href="#ldg-difference">' + L.footerLinkDifference + '</a><a href="#ldg-comment">' + L.footerLinkHow + '</a><a href="#ldg-usecases">' + L.footerLinkUsecases + '</a><a href="#ldg-features">' + L.footerLinkFeatures + '</a></div>' +
      '<div class="ldg-footer-col"><h4>' + L.footerCol2 + '</h4><a href="#ldg-avis">' + L.footerLinkTestimonials + '</a><a href="#ldg-faq">' + L.footerLinkFaq + '</a><button type="button" data-action="openPrivacy">' + privacyT().title + '</button></div>' +
      (showCtas ? '<div class="ldg-footer-col"><h4>Rohy</h4>' + (state.loggedIn ?
        '<button type="button" data-action="enterApp">' + L.navOpenApp.replace('🚀 ', '') + '</button>' :
        '<button type="button" data-action="ctaSignupFromAbout">' + L.footerBtnSignup + '</button><button type="button" data-action="openLoginForm">' + L.footerBtnLogin + '</button>') + '</div>' : '') +
      '</div>' +
      '</div>' +
      '<div class="ldg-footer-bottom">' +
      '<span>' + L.footerBottom + '</span>' +
      '<button class="ldg-footer-lang pressable" data-action="toggleLandingLang">' + (state.landingLang === 'en' ? 'FR' : 'EN') + '</button>' +
      '</div>' +
      '</footer>' +

      '</div>' +
      '</div>'
    );
  }

  // Contenu de la politique de confidentialité seul (repris dans le shell
  // "landing" avant connexion, cf. renderPrivacyStandalone, et dans le
  // contenu principal de l'app une fois connecté, cf. renderContent).
  function renderPrivacyScreen() {
    var L = privacyT();
    var listItems = function (items) { return '<ul class="ldg-privacy-list">' + items.map(function (i) { return '<li>' + escapeHtml(i) + '</li>'; }).join('') + '</ul>'; };
    return (
      '<div class="about-screen ldg-privacy">' +
      '<section class="ldg-section">' +
      '<h1>' + escapeHtml(L.title) + '</h1>' +
      '<p style="color:var(--text-tertiary);font-size:13px">' + escapeHtml(L.updated) + '</p>' +
      '<h2>' + escapeHtml(L.s1Title) + '</h2><p>' + escapeHtml(L.s1Body) + '</p>' +
      '<h2>' + escapeHtml(L.s2Title) + '</h2>' + listItems(L.s2Items) +
      '<h2>' + escapeHtml(L.s3Title) + '</h2>' + listItems(L.s3Items) +
      '<h2>' + escapeHtml(L.s4Title) + '</h2><p>' + escapeHtml(L.s4Intro) + '</p>' + listItems(L.s4Items) +
      '<h2>' + escapeHtml(L.s5Title) + '</h2><p>' + escapeHtml(L.s5Body) + '</p>' +
      '<h2>' + escapeHtml(L.s6Title) + '</h2><p>' + escapeHtml(L.s6Body) + '</p>' +
      '<h2>' + escapeHtml(L.s7Title) + '</h2><p>' + escapeHtml(L.s7Body) + '</p>' +
      (state.loggedIn && state.enteredApp
        ? '<button type="button" class="select-all-link pressable" data-action="exportMyData">' + escapeHtml(L.exportMyData) + '</button>'
        : '<p style="font-size:13px;color:var(--text-tertiary)">' + escapeHtml(L.exportMyDataLoggedOut) + '</p>') +
      '<h2>' + escapeHtml(L.s8Title) + '</h2><p>' + escapeHtml(L.s8Body) + '</p>' +
      '<button type="button" class="select-all-link pressable" style="margin-top:8px" data-action="reopenAnalyticsChoice">' + escapeHtml(L.manageConsent) + '</button>' +
      '</section>' +
      '</div>'
    );
  }
  // Shell de nav minimal (logo + retour), utilisé quand la politique de
  // confidentialité est ouverte avant connexion ou avant "Ouvrir l'app" —
  // dans les deux cas, render() affiche cet écran à la place de la landing
  // habituelle tant que state.screen === 'privacy' (cf. render()). Une fois
  // dans l'app, c'est renderContent() (case 'privacy') qui sert le même
  // renderPrivacyScreen() dans le chrome habituel (sidebar/bottom-nav).
  function renderPrivacyStandalone() {
    var L = privacyT();
    return (
      '<div class="about-standalone-screen">' +
      '<nav class="ldg-nav">' +
      '<div class="ldg-nav-brand">' + logoMark(26, '#0F8F6B', '#084b38') + '<span>Rohy</span></div>' +
      '<button class="btn-outline pressable" style="flex:none;width:auto;padding:9px 16px" data-action="closePrivacyScreen">' + escapeHtml(L.backLabel) + '</button>' +
      '</nav>' +
      renderPrivacyScreen() +
      '</div>'
    );
  }

  // Bandeau de consentement mesure d'audience — superposé par render() à
  // n'importe quel écran tant qu'aucun choix n'a été fait (cf. plus haut).
  // Fixe en bas de viewport, au-dessus de tout (y compris la bottom-nav
  // mobile) : cf. styles.css pour le z-index.
  function renderConsentBanner(showingAppShell) {
    var L = privacyT();
    return (
      '<div class="consent-banner' + (showingAppShell ? ' above-nav' : '') + '" data-stop-click>' +
      '<p>' + escapeHtml(L.bannerText) + ' <button type="button" class="consent-learn-more" data-action="openPrivacy">' + escapeHtml(L.bannerLearnMore) + '</button></p>' +
      '<div class="consent-banner-actions">' +
      '<button type="button" class="btn-outline pressable" data-action="declineAnalytics">' + escapeHtml(L.bannerDecline) + '</button>' +
      '<button type="button" class="btn-primary pressable" data-action="acceptAnalytics">' + escapeHtml(L.bannerAccept) + '</button>' +
      '</div>' +
      '</div>'
    );
  }

  function renderBottomNav() {
    function color(match) { return match ? 'var(--brand-secondary)' : 'var(--text-tertiary)'; }
    var cu = person(state.currentUserId);
    return (
      '<div class="bottom-nav">' +
      '<div class="sidebar-brand pressable" data-action="exitToLanding">' + logoMark(24, '#0F8F6B', '#084b38') + '<span>Rohy</span></div>' +
      '<button class="nav-item" data-action="goHome" style="color:' + color(state.screen === 'home') + '"><i class="ph-bold ph-house" style="font-size:20px"></i><div class="nav-item-label">Accueil</div></button>' +
      '<button class="nav-item" data-action="goGroups" style="color:' + color(state.screen === 'groups' || state.screen === 'groupDetail') + '"><i class="ph-bold ph-users-three" style="font-size:20px"></i><div class="nav-item-label">Groupes</div></button>' +
      '<button class="nav-item" data-action="goExpenses" style="color:' + color(state.screen === 'expenses') + '"><i class="ph-bold ph-receipt" style="font-size:20px"></i><div class="nav-item-label">Dépenses</div></button>' +
      '<button class="nav-item" data-action="goHistory" style="color:' + color(state.screen === 'history') + '"><i class="ph-bold ph-clock-counter-clockwise" style="font-size:20px"></i><div class="nav-item-label">Historique</div></button>' +
      // Ancrée en bas du menu latéral desktop uniquement (cf. styles.css) —
      // seul point d'accès permanent à "Mon compte"/déconnexion sur cette
      // largeur, l'icône de la barre du haut étant réservée au mobile.
      '<div class="sidebar-account-wrap">' +
      '<button class="sidebar-account pressable" data-action="openAccount">' +
      '<div class="avatar avatar-30 avatar-account" style="background:' + cu.color + '">' + initials(cu.name) + '</div>' +
      '<span class="sidebar-account-name">' + escapeHtml(cu.name) + '</span>' +
      '</button>' +
      (state.showAccount ? renderAccountDropdown() : '') +
      '</div>' +
      '</div>'
    );
  }
  // Menu déroulant ancré à l'avatar du menu latéral, desktop uniquement (cf.
  // styles.css — invisible en dessous de 900px, où renderAccountModal() sert
  // la même fonction en feuille glissée depuis le bas, plus adaptée au
  // mobile). Façon Slack/Notion/Discord plutôt qu'une feuille pleine largeur
  // centrée en bas d'un écran large, peu idiomatique à cette taille. Le
  // calque plein écran (data-action="closeModal") ferme le menu au clic en
  // dehors, comme les autres modales.
  function renderAccountDropdown() {
    var cu = person(state.currentUserId);
    return (
      '<div class="account-dropdown-overlay" data-action="closeModal"></div>' +
      '<div class="account-dropdown" data-stop-click>' +
      '<div class="account-dropdown-header">' +
      '<div class="avatar avatar-30 avatar-account" style="background:' + cu.color + '">' + initials(cu.name) + '</div>' +
      '<span class="account-dropdown-name">' + escapeHtml(cu.name) + '</span>' +
      '<button class="icon-btn pressable" style="margin-left:auto" data-action="openEditProfile" aria-label="Modifier mon prénom"><i class="ph-bold ph-pencil-simple"></i></button>' +
      '</div>' +
      '<div class="account-dropdown-divider"></div>' +
      (state.isAnonymous ? '<button class="account-dropdown-item pressable" data-action="openUpgradeAccount"><i class="ph-bold ph-user-plus"></i>Créer un compte</button>' : '') +
      // "J'ai déjà un compte" (cf. openConfirmSwitchAccount) : contrairement
      // à "Créer un compte" (upgrade la session anonyme en place, données
      // conservées), se connecter à un AUTRE compte existant abandonne
      // forcément les données de cette session invité — d'où la
      // confirmation avant de déconnecter.
      (state.isAnonymous ? '<button class="account-dropdown-item pressable" data-action="openConfirmSwitchAccount"><i class="ph-bold ph-sign-in"></i>Se connecter à un compte existant</button>' : '') +
      '<button class="account-dropdown-item pressable" data-action="openAbout"><i class="ph-bold ph-info"></i>À propos</button>' +
      '<button class="account-dropdown-item pressable" data-action="openPrivacy"><i class="ph-bold ph-shield-check"></i>Confidentialité</button>' +
      '<button class="account-dropdown-item pressable" data-action="openFeedbackFromMenu"><i class="ph-bold ph-chat-text"></i>Donner un avis</button>' +
      '<button class="account-dropdown-item pressable" data-action="toggleTheme"><i class="ph-bold ' + (state.theme === 'dark' ? 'ph-sun' : 'ph-moon') + '"></i>' + (state.theme === 'dark' ? 'Mode clair' : 'Mode sombre') + '</button>' +
      '<div class="account-dropdown-divider"></div>' +
      // Se déconnecter n'est pas une action destructive — pas de traitement
      // "danger" (rouge) comme le ferait une suppression, juste une ligne de
      // menu neutre comme les autres (cf. best practices desktop demandées).
      '<button class="account-dropdown-item pressable" data-action="logout"><i class="ph-bold ph-sign-out"></i>Se déconnecter</button>' +
      // Suppression de compte : seule action réellement destructive de ce
      // menu (droit à l'effacement RGPD, cf. supabase/functions/delete-
      // account) — traitement "danger" pour la distinguer nettement de "Se
      // déconnecter", réversible, juste au-dessus.
      '<button class="account-dropdown-item pressable" style="color:var(--status-danger)" data-action="openConfirmDeleteAccount"><i class="ph-bold ph-trash" style="color:var(--status-danger)"></i>Supprimer mon compte</button>' +
      '</div>'
    );
  }

  function renderModals() {
    var out = '';
    if (state.showAddExpense) out += renderAddExpenseModal();
    if (state.showAddGroup) out += renderAddGroupModal();
    if (state.showSettle) out += renderSettleModal();
    if (state.showAccount) out += renderAccountModal();
    if (state.showManageMembers) out += renderManageMembersModal();
    if (state.showShareLink) out += renderShareLinkModal();
    if (state.showUpgradeAccount) out += renderUpgradeAccountModal();
    if (state.showFeedback) out += renderFeedbackModal();
    if (state.showConfirmDeleteGroup) out += renderConfirmDeleteGroupModal();
    if (state.showConfirmRemoveMember) out += renderConfirmRemoveMemberModal();
    if (state.showConfirmLeaveGroup) out += renderConfirmLeaveGroupModal();
    if (state.showConfirmMergeGuest) out += renderConfirmMergeGuestModal();
    if (state.showConfirmDeleteAccount) out += renderConfirmDeleteAccountModal();
    if (state.showConfirmSwitchAccount) out += renderConfirmSwitchAccountModal();
    if (state.showEditProfile) out += renderEditProfileModal();
    if (state.showReminderConfirm) out += renderReminderConfirmModal();
    if (state.showExpenseFilters) out += renderExpenseFiltersModal();
    return out;
  }

  function renderReminderConfirmModal() {
    var p = person(state.reminderPersonId);
    if (!p) return '';
    var data = computeReminderMessage(state.reminderPersonId, state.reminderGroupId);
    var hasEmail = !!p.email;
    var draft = (state.reminderEmailDraft || '').trim();
    var draftValid = draft.indexOf('@') !== -1;
    // Un rappel sans e-mail ne sert à personne côté invité sans compte (pas
    // de session à lui pour le retrouver dans l'app) — on bloque donc
    // l'envoi tant qu'un e-mail valide n'est pas renseigné, plutôt que de
    // laisser croire qu'un simple clic "prévient" réellement la personne.
    // Cas différent pour un compte existant sans e-mail (rare, ex. compte
    // anonyme) : rien à saisir ici pour son compte, donc pas de blocage.
    var canSend = hasEmail || p.hasAccount || draftValid;
    return (
      '<div class="modal-overlay center" data-action="closeReminderConfirm">' +
      '<div class="modal-card" data-stop-click>' +
      '<div class="modal-title" style="margin-bottom:14px">Envoyer un rappel à ' + escapeHtml(p.name) + ' ?</div>' +
      '<div style="font-size:14px;color:var(--text-secondary);margin-bottom:14px">' + escapeHtml(data.message) + '</div>' +
      (hasEmail ?
        '<div style="font-size:12.5px;color:var(--text-tertiary);margin-bottom:18px">Un e-mail sera aussi envoyé à ' + escapeHtml(p.email) + '.</div>' :
        p.hasAccount ?
          '<div style="font-size:12.5px;color:var(--text-tertiary);margin-bottom:18px">Cette personne n\'a pas d\'e-mail connu — le rappel restera uniquement dans l\'app.</div>' :
          '<div style="font-size:12.5px;color:var(--text-tertiary);margin-bottom:8px">Cette personne n\'a pas de compte — sans e-mail, elle n\'a aucun moyen de voir ce rappel. Ajoute-en un pour continuer :</div>' +
          '<input class="text-input" type="email" data-bind="reminderEmailDraft" placeholder="E-mail (requis)" value="' + escapeHtml(state.reminderEmailDraft || '') + '" />') +
      '<div class="modal-footer-buttons">' +
      '<button class="btn-cancel pressable" data-action="closeReminderConfirm">Annuler</button>' +
      '<button class="btn-confirm pressable" style="' + (canSend ? '' : 'opacity:.5;cursor:not-allowed') + '"' + (canSend ? '' : ' disabled') + ' data-action="confirmSendReminder">Envoyer le rappel</button>' +
      '</div></div></div>'
    );
  }

  // Lien d'invitation façon Tricount/Kittysplit : quiconque l'ouvre devient
  // un vrai participant (voit/ajoute des dépenses, voit son solde) sans
  // jamais créer de compte e-mail/mot de passe — cf. renderJoinScreen et
  // l'Edge Function join-group.
  function renderShareLinkModal() {
    var g = group(state.shareLinkGroupId);
    if (!g) return '';
    var url = g.shareToken ? (APP_URL + '?join=' + g.shareToken) : '';
    return (
      '<div class="modal-overlay center" data-action="closeModal">' +
      '<div class="modal-card" data-stop-click>' +
      '<div class="modal-title" style="margin-bottom:14px">Lien d\'invitation</div>' +
      '<div style="font-size:13.5px;color:var(--text-secondary);margin-bottom:18px">' +
      'Toute personne qui ouvre ce lien rejoint « ' + escapeHtml(g.name) + ' » directement — elle voit ses dépenses et son solde, sans avoir besoin de créer de compte.' +
      '</div>' +
      (g.shareToken ?
        '<div class="text-input" style="display:flex;align-items:center;overflow-x:auto;white-space:nowrap;user-select:all;margin-bottom:14px">' + escapeHtml(url) + '</div>' +
        '<button class="btn-primary pressable" style="margin-bottom:10px" data-action="copyShareLink"><i class="ph-bold ph-copy"></i> Copier le lien</button>' +
        '<div class="modal-footer-buttons">' +
        '<button class="btn-cancel pressable" data-action="disableShareLink">Désactiver</button>' +
        '<button class="btn-outline pressable" data-action="generateShareLink">Régénérer</button>' +
        '</div>' :
        '<button class="btn-primary pressable" data-action="generateShareLink"><i class="ph-bold ph-link"></i> Générer un lien</button>') +
      '</div></div>'
    );
  }

  // Compte anonyme (rejoint via un lien d'invitation, cf. performJoin) qui
  // veut garder l'accès à ses groupes après un changement d'appareil.
  function renderUpgradeAccountModal() {
    var f = state.upgradeForm;
    return (
      '<div class="modal-overlay center" data-action="closeModal">' +
      '<div class="modal-card" data-stop-click>' +
      '<div class="modal-title" style="margin-bottom:14px">Créer un compte</div>' +
      '<div style="font-size:13.5px;color:var(--text-secondary);margin-bottom:16px">Garde l\'accès à tes groupes même en changeant d\'appareil — ton historique est conservé tel quel.</div>' +
      '<div class="field-label">Prénom</div>' +
      '<input class="text-input" data-bind="upgradeName" placeholder="Toi" value="' + escapeHtml(f.name) + '" />' +
      '<div class="field-label">E-mail</div>' +
      '<input class="text-input" type="email" autocomplete="email" data-bind="upgradeEmail" placeholder="toi@exemple.com" value="' + escapeHtml(f.email) + '" />' +
      '<div class="field-label">Mot de passe</div>' +
      '<input class="text-input" type="password" autocomplete="new-password" data-bind="upgradePassword" placeholder="•••••••• (8 caractères min)" value="' + escapeHtml(f.password) + '" />' +
      '<button class="btn-primary pressable" style="margin-top:14px' + (state.upgradeSubmitting ? ';opacity:0.6' : '') + '" data-action="submitUpgradeAccount">' + (state.upgradeSubmitting ? 'Création en cours…' : 'Créer le compte') + '</button>' +
      (state.upgradeError ? '<div class="form-error">' + escapeHtml(state.upgradeError) + '</div>' : '') +
      '</div></div>'
    );
  }

  function renderFeedbackModal() {
    var stars = [1, 2, 3, 4, 5].map(function (n) {
      var filled = n <= state.feedbackRating;
      return '<button type="button" class="feedback-star pressable" data-action="setFeedbackRating" data-id="' + n + '" aria-label="' + n + ' sur 5">' +
        '<i class="ph-bold ' + (filled ? 'ph-star-fill' : 'ph-star') + '"></i></button>';
    }).join('');
    return (
      '<div class="modal-overlay center" data-action="closeModal">' +
      '<div class="modal-card" data-stop-click>' +
      '<div class="modal-title" style="margin-bottom:8px">Comment se passe ton expérience avec Rohy ?</div>' +
      '<div style="font-size:13.5px;color:var(--text-secondary);margin-bottom:18px">Ton avis nous aide à améliorer l\'app.</div>' +
      '<div class="feedback-stars">' + stars + '</div>' +
      '<textarea class="text-input" data-bind="feedbackComment" placeholder="Un commentaire à ajouter ? (facultatif)" rows="3" style="resize:none;font-family:inherit">' + escapeHtml(state.feedbackComment) + '</textarea>' +
      '<button class="btn-primary pressable" style="margin-top:4px' + (state.feedbackSubmitting ? ';opacity:0.6' : '') + '" data-action="submitFeedback">' + (state.feedbackSubmitting ? 'Envoi…' : 'Envoyer') + '</button>' +
      (state.feedbackError ? '<div class="form-error">' + escapeHtml(state.feedbackError) + '</div>' : '') +
      '</div></div>'
    );
  }

  function renderConfirmDeleteGroupModal() {
    var g = group(state.confirmDeleteGroupId);
    if (!g) return '';
    var expenseCount = state.expenses.filter(function (e) { return e.groupId === g.id; }).length;
    var paymentCount = state.payments.filter(function (p) { return p.groupId === g.id; }).length;
    var reminderCount = state.reminders.filter(function (r) { return r.groupId === g.id; }).length;
    // Liste précisément ce qui disparaît avec le groupe (dépenses, règlements
    // et rappels associés, cf. migration 0015) plutôt qu'un simple "action
    // définitive" — pour que la suppression, irréversible, soit un choix
    // informé.
    var consequenceParts = [];
    if (expenseCount > 0) consequenceParts.push(expenseCount > 1 ? expenseCount + ' dépenses' : '1 dépense');
    if (paymentCount > 0) consequenceParts.push(paymentCount > 1 ? paymentCount + ' règlements' : '1 règlement');
    if (reminderCount > 0) consequenceParts.push(reminderCount > 1 ? reminderCount + ' rappels' : '1 rappel');
    return (
      '<div class="modal-overlay center" data-action="closeModal">' +
      '<div class="modal-card" data-stop-click>' +
      '<div class="modal-title" style="margin-bottom:14px">Supprimer « ' + escapeHtml(g.name) + ' » ?</div>' +
      '<div style="font-size:14px;color:var(--text-secondary);margin-bottom:18px">' +
      (consequenceParts.length > 0
        ? 'Cette action supprimera aussi définitivement ' + consequenceParts.join(', ') + ' associé' + (expenseCount + paymentCount + reminderCount > 1 ? 's' : '') + '. Impossible de revenir en arrière.'
        : 'Cette action est définitive.') +
      '</div>' +
      '<div class="modal-footer-buttons">' +
      '<button class="btn-cancel pressable" data-action="closeModal">Annuler</button>' +
      '<button class="btn-confirm pressable" style="background:var(--status-danger)" data-action="confirmDeleteGroup">Supprimer</button>' +
      '</div></div></div>'
    );
  }

  function renderConfirmRemoveMemberModal() {
    var g = group(state.confirmRemoveMemberGroupId);
    var p = person(state.confirmRemoveMemberId);
    if (!g || !p) return '';
    var expenseCount = state.expenses.filter(function (e) {
      return e.groupId === g.id && (e.paidBy === p.id || e.participants.indexOf(p.id) !== -1);
    }).length;
    var bal = netBalanceFor(p.id, g.id);
    var hasBalance = Math.abs(bal) > 0.5;
    return (
      '<div class="modal-overlay center" data-action="cancelRemoveMember">' +
      '<div class="modal-card" data-stop-click>' +
      '<div class="modal-title" style="margin-bottom:14px">Retirer ' + escapeHtml(p.name) + ' du groupe « ' + escapeHtml(g.name) + ' » ?</div>' +
      '<div style="font-size:14px;color:var(--text-secondary);margin-bottom:18px">' +
      (hasBalance
        ? escapeHtml(p.name) + ' a un solde non réglé de ' + fmtIn(Math.abs(bal), g.currency) + ' dans ce groupe — il restera affiché ici (marqué « ex-membre ») tant qu\'il n\'est pas soldé.'
        : expenseCount > 0
          ? escapeHtml(p.name) + ' est lié à ' + expenseCount + (expenseCount > 1 ? ' dépenses' : ' dépense') + ' de ce groupe — elles resteront dans l\'historique.'
          : escapeHtml(p.name) + ' n\'a aucune dépense dans ce groupe.') +
      '</div>' +
      '<div class="modal-footer-buttons">' +
      '<button class="btn-cancel pressable" data-action="cancelRemoveMember">Annuler</button>' +
      '<button class="btn-confirm pressable" style="background:var(--status-danger)" data-action="confirmRemoveMember">Retirer</button>' +
      '</div></div></div>'
    );
  }

  function renderConfirmLeaveGroupModal() {
    var g = group(state.confirmLeaveGroupId);
    if (!g) return '';
    var bal = netBalanceFor(state.currentUserId, g.id);
    var hasBalance = Math.abs(bal) > 0.5;
    return (
      '<div class="modal-overlay center" data-action="cancelLeaveGroup">' +
      '<div class="modal-card" data-stop-click>' +
      '<div class="modal-title" style="margin-bottom:14px">Quitter « ' + escapeHtml(g.name) + ' » ?</div>' +
      '<div style="font-size:14px;color:var(--text-secondary);margin-bottom:18px">' +
      (hasBalance
        ? 'Tu as un solde non réglé de ' + fmtIn(Math.abs(bal), g.currency) + ' dans ce groupe — il reste dû même après ton départ. Tu ne verras plus ce groupe ; seul l\'admin pourra t\'y réintégrer.'
        : 'Tu ne verras plus ce groupe. Seul l\'admin pourra t\'y réintégrer.') +
      '</div>' +
      '<div class="modal-footer-buttons">' +
      '<button class="btn-cancel pressable" data-action="cancelLeaveGroup">Annuler</button>' +
      '<button class="btn-confirm pressable" style="background:var(--status-danger)" data-action="confirmLeaveGroup">Quitter</button>' +
      '</div></div></div>'
    );
  }
  function renderConfirmMergeGuestModal() {
    var p = person(state.confirmMergeGuestId);
    if (!p) return '';
    return (
      '<div class="modal-overlay center" data-action="cancelMergeGuest">' +
      '<div class="modal-card" data-stop-click>' +
      '<div class="modal-title" style="margin-bottom:14px">Fusionner avec un compte existant ?</div>' +
      '<div style="font-size:14px;color:var(--text-secondary);margin-bottom:18px">' +
      '« ' + escapeHtml(state.confirmMergeGuestEmail) + ' » est déjà utilisée par un compte existant. ' +
      'Fusionner l\'historique de ' + escapeHtml(p.name) + ' (dépenses, paiements, rappels) avec ce compte ? ' +
      escapeHtml(p.name) + ' disparaît en tant que profil séparé — cette action est irréversible.' +
      '</div>' +
      '<div class="modal-footer-buttons">' +
      '<button class="btn-cancel pressable" data-action="cancelMergeGuest">Annuler</button>' +
      '<button class="btn-confirm pressable"' + (state.mergingGuest ? ' disabled style="opacity:.6"' : '') + ' data-action="confirmMergeGuest">' +
      (state.mergingGuest ? 'Fusion en cours…' : 'Fusionner') + '</button>' +
      '</div></div></div>'
    );
  }

  function renderConfirmDeleteAccountModal() {
    var cu = person(state.currentUserId);
    if (!cu) return '';
    var myGroups = state.groups.filter(function (g) { return g.memberIds.indexOf(state.currentUserId) !== -1; });
    var groupsWithBalance = myGroups.filter(function (g) { return Math.abs(netBalanceFor(state.currentUserId, g.id)) > 0.5; });
    var adminGroupsWithOthers = myGroups.filter(function (g) { return g.adminId === state.currentUserId && g.memberIds.length > 1; });
    var warnParts = [];
    if (groupsWithBalance.length > 0) {
      warnParts.push(groupsWithBalance.length > 1
        ? 'Des soldes non réglés dans ' + groupsWithBalance.length + ' groupes resteront visibles (marqués « Compte supprimé ») jusqu\'à leur règlement.'
        : 'Un solde non réglé dans « ' + groupsWithBalance[0].name + ' » restera visible (marqué « Compte supprimé ») jusqu\'à son règlement.');
    }
    if (adminGroupsWithOthers.length > 0) {
      warnParts.push('Tu es admin de ' + (adminGroupsWithOthers.length > 1 ? adminGroupsWithOthers.length + ' groupes' : '« ' + adminGroupsWithOthers[0].name + ' »') + ' — l\'administration sera transférée automatiquement à un autre membre.');
    }
    return (
      '<div class="modal-overlay center" data-action="cancelDeleteAccount">' +
      '<div class="modal-card" data-stop-click>' +
      '<div class="modal-title" style="margin-bottom:14px">Supprimer ton compte ?</div>' +
      '<div style="font-size:14px;color:var(--text-secondary);margin-bottom:14px">Ton nom et ton e-mail seront supprimés et tu ne pourras plus te connecter. Cette action est définitive.</div>' +
      (warnParts.length ? '<div style="font-size:13px;color:var(--status-danger);margin-bottom:18px">' + warnParts.map(function (w) { return escapeHtml(w); }).join(' ') + '</div>' : '') +
      '<div class="modal-footer-buttons">' +
      '<button class="btn-cancel pressable" data-action="cancelDeleteAccount">Annuler</button>' +
      '<button class="btn-confirm pressable" style="background:var(--status-danger)" data-action="confirmDeleteAccount"' + (state.deletingAccount ? ' disabled' : '') + '>' + (state.deletingAccount ? 'Suppression…' : 'Supprimer mon compte') + '</button>' +
      '</div></div></div>'
    );
  }

  // Contrairement à confirmDeleteAccount (qui transfère l'administration des
  // groupes avant de couper l'accès, cf. supabase/functions/delete-account),
  // un simple signOut() sur une session anonyme n'a AUCUN filet : les
  // groupes créés/rejoints pendant cette session invité deviennent
  // inaccessibles pour tout le monde qui en dépendait de cette session, sans
  // recours possible (pas d'e-mail à récupérer). D'où la liste explicite
  // plutôt qu'un avertissement générique.
  function renderConfirmSwitchAccountModal() {
    var myGroups = state.groups.filter(function (g) { return g.memberIds.indexOf(state.currentUserId) !== -1; });
    return (
      '<div class="modal-overlay center" data-action="cancelSwitchAccount">' +
      '<div class="modal-card" data-stop-click>' +
      '<div class="modal-title" style="margin-bottom:14px">Se connecter à un autre compte ?</div>' +
      '<div style="font-size:14px;color:var(--text-secondary);margin-bottom:14px">Tu utilises actuellement Rohy en tant qu\'invité(e), un compte temporaire propre à cet appareil. Te connecter à un compte existant déconnecte cette session invité.</div>' +
      (myGroups.length > 0 ?
        '<div style="font-size:13px;color:var(--status-danger);margin-bottom:18px">Aucun moyen de revenir dessus ensuite : tu perdras l\'accès à ' + (myGroups.length > 1 ? 'ces ' + myGroups.length + ' groupes' : '« ' + escapeHtml(myGroups[0].name) + ' »') + ' (' + myGroups.map(function (g) { return escapeHtml(g.name); }).join(', ') + ') et à leurs dépenses, pour toi comme pour les autres membres.</div>' :
        '<div style="font-size:13px;color:var(--text-tertiary);margin-bottom:18px">Cette session invité n\'a encore aucun groupe — rien à perdre pour l\'instant.</div>') +
      '<div class="modal-footer-buttons">' +
      '<button class="btn-cancel pressable" data-action="cancelSwitchAccount">Annuler</button>' +
      '<button class="btn-confirm pressable" data-action="confirmSwitchAccount">Se connecter</button>' +
      '</div></div></div>'
    );
  }

  function renderEditProfileModal() {
    return (
      '<div class="modal-overlay center" data-action="cancelEditProfile">' +
      '<div class="modal-card" data-stop-click>' +
      '<div class="modal-title" style="margin-bottom:14px">Modifier mon prénom</div>' +
      '<div class="field-label">Prénom</div>' +
      '<input class="text-input" data-bind="editProfileName" placeholder="Ton prénom" value="' + escapeHtml(state.editProfileName || '') + '" />' +
      (state.editProfileError ? '<div class="form-error">' + escapeHtml(state.editProfileError) + '</div>' : '') +
      '<div class="modal-footer-buttons" style="margin-top:14px">' +
      '<button class="btn-cancel pressable" data-action="cancelEditProfile">Annuler</button>' +
      '<button class="btn-confirm pressable" data-action="submitEditProfile"' + (state.editProfileSubmitting ? ' disabled' : '') + '>' + (state.editProfileSubmitting ? 'Enregistrement…' : 'Enregistrer') + '</button>' +
      '</div></div></div>'
    );
  }

  // Devise + montant d'une dépense : soit le simple champ "Montant"
  // habituel (devise du groupe, inchangé), soit — si une devise différente
  // est choisie — le montant réellement payé dans cette devise, le taux de
  // change (pré-rempli, toujours modifiable), le montant converti en aperçu,
  // et l'option pour geler ce taux pour tout le groupe (cf. migration 0019).
  function renderExpenseCurrencyFields(f, currentGroup) {
    var groupCur = currentGroup && currentGroup.currency;
    var currencyPicker =
      '<div class="field-label">Devise de la dépense</div>' +
      '<select class="text-input select-native" data-bind-change="expenseCurrency">' + currencyOptionsHtml(f.currency || groupCur) + '</select>';
    var isForeignCur = !!(groupCur && f.currency && f.currency !== groupCur);
    if (!isForeignCur) {
      return (
        currencyPicker +
        '<div class="field-label">Montant (' + currencySymbolFor(groupCur) + ')</div>' +
        '<input class="text-input" data-bind="expenseAmount" placeholder="0,00" inputmode="decimal" value="' + escapeHtml(f.amount) + '" />'
      );
    }
    var convertedPreview = fmtIn(parseFloat((f.amount || '').replace(',', '.')) || 0, groupCur);
    return (
      currencyPicker +
      '<div class="field-label">Montant payé (' + currencySymbolFor(f.currency) + ')</div>' +
      '<input class="text-input" data-bind="expenseForeignAmount" placeholder="0,00" inputmode="decimal" value="' + escapeHtml(f.foreignAmount) + '" />' +
      '<div class="field-label" style="display:flex;align-items:center;justify-content:space-between">' +
      '<span>Taux (1 ' + f.currency + ' = ? ' + groupCur + ')</span>' +
      '<span class="select-all-link pressable" data-action="refreshExchangeRate">' + (f.rateLoading ? 'Recherche...' : 'Actualiser') + '</span>' +
      '</div>' +
      '<input class="text-input" data-bind="expenseExchangeRate" placeholder="Ex : 4800" inputmode="decimal" value="' + escapeHtml(f.exchangeRate) + '" />' +
      (f.rateError ? '<div class="form-error" style="margin-top:-8px">' + escapeHtml(f.rateError) + '</div>' : '') +
      '<div style="font-size:12.5px;color:var(--text-tertiary);margin:6px 0 14px">≈ ' + convertedPreview + '</div>' +
      '<div class="checkbox-row" style="border-top:none;margin-bottom:14px" data-action="toggleFreezeCurrencyRates">' +
      '<div class="checkbox' + (f.freezeRates ? ' checked' : '') + '">' + (f.freezeRates ? '<i class="ph-bold ph-check"></i>' : '') + '</div>' +
      '<div style="font-size:13px;color:var(--text-primary)">Garder ce taux pour toutes les dépenses de ce groupe en ' + escapeHtml(f.currency) + '</div></div>'
    );
  }

  function renderAddExpenseModal() {
    var f = state.form;
    var currentGroup = f.groupId ? group(f.groupId) : state.groups[0];
    var groupChoices = state.groups.map(function (g) {
      return '<div class="pill' + (f.groupId === g.id ? ' active' : '') + '" data-action="selectGroupForForm" data-id="' + g.id + '">' + escapeHtml(g.name) + '</div>';
    }).join('');
    var payerChoices = (currentGroup ? currentGroup.memberIds : []).map(function (pid) {
      var p = person(pid);
      return '<div class="pill' + (f.paidBy === pid ? ' active' : '') + '" data-action="selectPayer" data-id="' + pid + '">' + escapeHtml(p.name) + '</div>';
    }).join('');
    var allParticipantsSelected = !!currentGroup && currentGroup.memberIds.length > 0 && currentGroup.memberIds.every(function (pid) { return f.participantIds.indexOf(pid) !== -1; });
    var splitModeEditable = f.splitMode === 'shares' || f.splitMode === 'exact' || f.splitMode === 'percent';
    var splitModeChoices = seed.SPLIT_MODES.map(function (m) {
      return '<div class="pill' + (f.splitMode === m.id ? ' active' : '') + '" data-action="setSplitMode" data-id="' + m.id + '">' + escapeHtml(m.label) + '</div>';
    }).join('');
    var participantRows = (currentGroup ? currentGroup.memberIds : []).map(function (pid) {
      var p = person(pid);
      var included = f.participantIds.indexOf(pid) !== -1;
      var overrideOptions = [{ value: 'self', label: 'Paie sa part' }].concat(
        currentGroup.memberIds.filter(function (id2) { return id2 !== pid; }).map(function (id2) { return { value: id2, label: 'Pris en charge par ' + person(id2).name }; })
      );
      var splitSuffix = f.splitMode === 'percent' ? '%' : (f.splitMode === 'exact' ? currencySymbolFor(currentGroup && currentGroup.currency) : '');
      return (
        '<div class="checkbox-row">' +
        '<div class="checkbox' + (included ? ' checked' : '') + '" data-action="toggleParticipant" data-id="' + pid + '">' + (included ? '<i class="ph-bold ph-check"></i>' : '') + '</div>' +
        '<div class="col-name">' + escapeHtml(p.name) + (f.splitMode === 'default' ? shareBadge(p, true) : '') + '</div>' +
        (included && splitModeEditable ?
          '<div style="display:flex;align-items:center;gap:4px">' +
          '<input class="child-percent-input" data-bind="splitValue" data-id="' + pid + '" value="' + escapeHtml(f.splitValues[pid] || '') + '" inputmode="decimal" />' +
          (splitSuffix ? '<span style="font-size:12px;color:var(--text-tertiary)">' + escapeHtml(splitSuffix) + '</span>' : '') +
          '</div>' : '') +
        (included ? '<select class="participant-select" data-bind-change="override" data-id="' + pid + '">' +
          overrideOptions.map(function (opt) { return '<option value="' + opt.value + '"' + ((f.overrides[pid] || 'self') === opt.value ? ' selected' : '') + '>' + escapeHtml(opt.label) + '</option>'; }).join('') +
          '</select>' : '') +
        '</div>'
      );
    }).join('');
    var target = splitTarget(f);
    var remainderHtml = !target ? '' :
      '<div style="font-size:12px;font-weight:700;margin:-4px 0 14px;color:' + (target.ok ? 'var(--status-positive)' : 'var(--status-danger)') + '">' +
      (target.ok ? 'Répartition complète' : 'Reste à répartir : ' + (f.splitMode === 'percent' ? target.remainder.toFixed(1).replace('.', ',') + ' %' : fmtIn(target.remainder, currentGroup && currentGroup.currency))) +
      '</div>';

    return (
      '<div class="modal-overlay bottom" data-action="closeModal">' +
      '<div class="modal-sheet" data-stop-click>' +
      '<div class="modal-header"><div class="modal-title">' + (f.editingId ? 'Modifier la dépense' : 'Nouvelle dépense') + '</div>' +
      '<button class="modal-close" data-action="closeModal" aria-label="Fermer"><i class="ph-bold ph-x"></i></button></div>' +
      (f.scanning ?
        '<div class="scan-dropzone scanning"><div class="scan-spinner"></div><span>Lecture du ticket en cours...</span></div>'
        :
        // accept étendu aux PDF (pas seulement image/*) : sur desktop, ce
        // bouton devient le seul moyen de joindre un reçu (cf. plus bas,
        // section "Reçu / pièce jointe" masquée à vide au-delà de 900px car
        // strictement redondante avec celui-ci) — il doit donc couvrir tout
        // ce que couvrait l'ancien input dédié, facture PDF incluse.
        '<label class="scan-dropzone pressable">' +
        '<input type="file" accept="image/*,.pdf" capture="environment" data-bind-change="scanFile" />' +
        '<i class="ph-bold ph-camera"></i>' +
        // Texte différent selon la largeur plutôt qu'un seul libellé : sur
        // mobile, capture="environment" ouvre réellement l'appareil photo
        // ("scanner" est donc juste) ; sur desktop cet attribut est ignoré
        // par le navigateur (simple sélecteur de fichier), donc "scanner"
        // n'y décrit plus la bonne action — d'où "Ajouter un ticket /
        // facture", plus juste quand il s'agit de choisir un fichier existant.
        '<span class="scan-label-mobile">Scanner un ticket (remplit le formulaire)</span>' +
        '<span class="scan-label-desktop">Ajouter un ticket / facture</span>' +
        '</label>') +
      '<div class="field-label">Groupe</div><div class="pill-row">' + groupChoices + '</div>' +
      '<div class="field-label">Description</div>' +
      '<input class="text-input" data-bind="expenseLabel" placeholder="Courses, essence..." value="' + escapeHtml(f.label) + '" />' +
      '<div class="field-label">Catégorie</div>' +
      '<div class="pill-row">' + seed.EXPENSE_CATEGORIES.map(function (c) {
        return '<div class="pill' + (f.category === c.id ? ' active' : '') + '" data-action="setCategory" data-id="' + c.id + '"><i class="' + c.icon + '" style="margin-right:5px"></i>' + escapeHtml(c.label) + '</div>';
      }).join('') + '</div>' +
      renderExpenseCurrencyFields(f, currentGroup) +
      '<div class="field-label">Date</div>' +
      '<input class="text-input" type="date" data-bind="expenseDate" value="' + escapeHtml(f.date) + '" />' +
      '<div class="checkbox-row" style="border-top:none;margin-bottom:16px" data-action="toggleFullyPaid">' +
      '<div class="checkbox' + (f.fullyPaid ? ' checked' : '') + '">' + (f.fullyPaid ? '<i class="ph-bold ph-check"></i>' : '') + '</div>' +
      '<div style="font-size:13.5px;color:var(--text-primary);font-weight:600">Payée intégralement (pas d\'acompte)</div></div>' +
      (!f.fullyPaid ?
        '<div class="field-label">Déjà versé au tiers (' + currencySymbolFor(currentGroup && currentGroup.currency) + ')</div>' +
        '<input class="text-input" data-bind="paidExternal" placeholder="Ex : 500" inputmode="decimal" value="' + escapeHtml(f.paidExternal) + '" />' : '') +
      '<div class="field-label">Payé par</div><div class="pill-row">' + payerChoices + '</div>' +
      '<div class="field-label">Répartition</div><div class="pill-row">' + splitModeChoices + '</div>' +
      '<div class="section-label" style="display:flex;align-items:center;justify-content:space-between">Qui participe ?' +
      '<span class="select-all-link" data-action="toggleAllParticipants">' + (allParticipantsSelected ? 'Tout désélectionner' : 'Tout sélectionner') + '</span>' +
      '</div>' + participantRows + remainderHtml +
      // Rien d'effectivement attaché (jamais eu de reçu, ou un reçu existant
      // qu'on vient de retirer sans encore en choisir un autre) : sur
      // desktop, ce label + cette zone ne seraient qu'un doublon exact du
      // bouton "Ajouter un ticket / facture" tout en haut (qui joint déjà le
      // fichier choisi, cf. scanReceipt) — masqués à partir de 900px (cf.
      // styles.css). Sur mobile, gardés : "scanner" un ticket (capture
      // caméra) et joindre un fichier existant restent deux gestes
      // différents qu'on peut vouloir faire séparément. Dès qu'un reçu
      // existe (chargé ou tout juste choisi), la section redevient utile
      // sur toutes les tailles (voir/retirer/remplacer) et n'est donc
      // jamais masquée.
      (function () {
        var receiptEmpty = (!f.receiptPath || f.receiptRemove) && !f.receiptFile;
        return (
          '<div class="field-label' + (receiptEmpty ? ' receipt-empty-hide' : '') + '">Reçu / pièce jointe (facultatif)</div>' +
          (f.receiptPath && !f.receiptRemove ?
            '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">' +
            '<button type="button" class="btn-outline pressable" style="flex:1" data-action="viewReceipt" data-path="' + escapeHtml(f.receiptPath) + '"><i class="ph-bold ph-paperclip"></i> Voir le reçu actuel</button>' +
            '<button type="button" class="btn-icon-danger pressable" style="width:38px;flex-shrink:0" data-action="removeReceipt" title="retirer le reçu" aria-label="Retirer le reçu"><i class="ph-bold ph-trash"></i></button>' +
            '</div>' : '') +
          (f.receiptFile ?
            '<div class="attachment-picked">' +
            '<i class="ph-bold ph-file-check"></i>' +
            '<span class="attachment-picked-name">' + escapeHtml(f.receiptFile.name) + '</span>' +
            '<button type="button" class="attachment-picked-clear pressable" data-action="clearReceiptFile" title="Choisir un autre fichier" aria-label="Choisir un autre fichier"><i class="ph-bold ph-x"></i></button>' +
            '</div>'
            :
            '<label class="attachment-dropzone pressable' + (receiptEmpty ? ' receipt-empty-hide' : '') + '">' +
            '<input type="file" accept="image/*,.pdf" data-bind-change="receiptFile" />' +
            '<i class="ph-bold ph-paperclip"></i>' +
            '<span>Ajouter une photo ou un PDF</span>' +
            '</label>'
          )
        );
      })() +
      '<button class="btn-primary pressable" style="margin-top:20px" data-action="submitExpense">' + (f.editingId ? 'Enregistrer les modifications' : 'Enregistrer la dépense') + '</button>' +
      (state.formError ? '<div class="form-error">' + escapeHtml(state.formError) + '</div>' : '') +
      (f.editingId ? '<button class="delete-link" data-action="deleteExpense">Supprimer cette dépense</button>' : '') +
      '</div></div>'
    );
  }

  // Regroupe les devises par région (cf. `region` dans scripts/data.js) en
  // <optgroup> plutôt qu'une seule longue liste à plat de 37 devises — plus
  // facile à parcourir, notamment pour retrouver rapidement une devise
  // africaine (public cible principal de l'app) sans défiler tout le reste.
  function currencyOptionsHtml(selectedCode) {
    var groups = [];
    var lastRegion = null;
    seed.CURRENCIES.forEach(function (c) {
      if (c.region !== lastRegion) { groups.push({ region: c.region, items: [] }); lastRegion = c.region; }
      groups[groups.length - 1].items.push(c);
    });
    return groups.map(function (g) {
      var opts = g.items.map(function (c) {
        return '<option value="' + c.code + '"' + (selectedCode === c.code ? ' selected' : '') + '>' + c.code + ' — ' + escapeHtml(c.label) + ' (' + c.symbol + ')</option>';
      }).join('');
      return '<optgroup label="' + escapeHtml(g.region) + '">' + opts + '</optgroup>';
    }).join('');
  }

  function renderAddGroupModal() {
    var gf = state.groupForm;
    var currencyOptions = currencyOptionsHtml(gf.currency);
    var inviteeRows = gf.invitees.map(function (inv, i) {
      return (
        '<div style="background:var(--surface-overlay);border-radius:14px;padding:12px;margin-bottom:10px">' +
        '<div style="display:flex;gap:8px;margin-bottom:8px">' +
        '<input class="text-input" style="margin-bottom:0" data-bind="inviteeName" data-id="' + i + '" placeholder="Prénom" value="' + escapeHtml(inv.name) + '" />' +
        (gf.invitees.length > 1 ? '<button class="btn-icon-danger pressable" style="width:38px;flex-shrink:0" data-action="removeInviteeRow" data-id="' + i + '" aria-label="Retirer cette personne"><i class="ph-bold ph-x"></i></button>' : '') +
        '</div>' +
        '<div data-invitee-below="' + i + '">' + inviteeBelowNameHtml(i) + '</div>' +
        '</div>'
      );
    }).join('');
    return (
      '<div class="modal-overlay bottom" data-action="closeModal">' +
      '<div class="modal-sheet" data-stop-click>' +
      '<div class="modal-header"><div class="modal-title">Nouveau groupe</div>' +
      '<button class="modal-close" data-action="closeModal" aria-label="Fermer"><i class="ph-bold ph-x"></i></button></div>' +
      '<div class="field-label">Nom</div>' +
      '<input class="text-input" data-bind="groupName" placeholder="Ex : week-end à Lyon" value="' + escapeHtml(gf.name) + '" />' +
      '<div class="field-label">Devise</div>' +
      '<div class="select-field">' +
      '<select class="text-input select-native" data-bind-change="groupCurrency">' + currencyOptions + '</select>' +
      '<i class="ph-bold ph-caret-down select-chevron"></i>' +
      '</div>' +
      '<div class="section-label">Ajouter des membres</div>' +
      '<div style="font-size:11.5px;color:var(--text-tertiary);margin:-8px 0 12px">l\'e-mail est facultatif : renseigné, une invitation est envoyée pour que la personne se connecte elle-même ; sinon, elle est simplement ajoutée au groupe.</div>' +
      inviteeRows +
      '<button class="dashed-btn pressable" style="margin-bottom:6px" data-action="addInviteeRow">+ Ajouter un membre</button>' +
      '<button class="btn-primary pressable" style="margin-top:14px' + (state.submittingGroup ? ';opacity:0.6' : '') + '" data-action="submitGroup">' +
      (state.submittingGroup ? 'Création en cours…' : 'Créer le groupe') + '</button>' +
      (state.formError ? '<div class="form-error">' + escapeHtml(state.formError) + '</div>' : '') +
      '</div></div>'
    );
  }

  // Libellés des moyens de paiement (cf. migration 0014) — un seul endroit
  // à mettre à jour si un nouveau moyen de paiement s'ajoute.
  var PAYMENT_METHOD_LABELS = {
    mvola: 'MVola', orange_money: 'Orange Money', airtel_money: 'Airtel Money',
    especes: 'Espèces', virement: 'Virement', autre: 'Autre',
  };
  function renderSettleModal() {
    var sf = state.settleForm;
    var fromName = sf.from ? person(sf.from).name : '';
    var toName = sf.to ? person(sf.to).name : '';
    var settleGroup = state.settleGroupId ? group(state.settleGroupId) : null;
    var ussdCode = MOBILE_MONEY_USSD[sf.paymentMethod];
    return (
      '<div class="modal-overlay center" data-action="closeModal">' +
      '<div class="modal-card" data-stop-click>' +
      '<div class="modal-title" style="margin-bottom:14px">Enregistrer un paiement</div>' +
      '<div style="font-size:14px;color:var(--text-secondary);margin-bottom:14px">' + escapeHtml(fromName) + ' → ' + escapeHtml(toName) + '</div>' +
      '<div class="field-label">Montant (' + currencySymbolFor(settleGroup && settleGroup.currency) + ')</div>' +
      '<input class="text-input" data-bind="settleAmount" inputmode="decimal" value="' + escapeHtml(sf.amount) + '" />' +
      '<div class="field-label">Moyen de paiement (facultatif)</div>' +
      '<div class="select-field"><select class="text-input select-native" data-bind-change="settlePaymentMethod">' +
      '<option value=""' + (!sf.paymentMethod ? ' selected' : '') + '>— Non précisé —</option>' +
      Object.keys(PAYMENT_METHOD_LABELS).map(function (k) {
        return '<option value="' + k + '"' + (sf.paymentMethod === k ? ' selected' : '') + '>' + PAYMENT_METHOD_LABELS[k] + '</option>';
      }).join('') +
      '</select><i class="ph-bold ph-caret-down select-chevron"></i></div>' +
      // Ouvre juste le clavier téléphone avec le code USSD pré-rempli — le
      // règlement se fait ensuite entièrement côté réseau de l'opérateur,
      // hors de portée de l'app (pas de confirmation automatique possible
      // par ce canal, cf. commentaire sur MOBILE_MONEY_USSD).
      (ussdCode ?
        '<a class="btn-outline pressable" style="margin-bottom:14px;text-decoration:none" href="' + ussdTelHref(ussdCode) + '"><i class="ph-bold ph-phone-call"></i> Ouvrir ' + PAYMENT_METHOD_LABELS[sf.paymentMethod] + ' (' + ussdCode + ')</a>'
        : '') +
      '<div class="field-label">Référence de transaction (facultatif)</div>' +
      '<input class="text-input" data-bind="settleReference" placeholder="Ex : identifiant reçu par SMS" value="' + escapeHtml(sf.paymentReference || '') + '" />' +
      '<div class="modal-footer-buttons">' +
      '<button class="btn-cancel pressable" data-action="closeModal">Annuler</button>' +
      '<button class="btn-confirm pressable" data-action="submitSettle">Confirmer</button>' +
      '</div></div></div>'
    );
  }

  // Mobile uniquement à partir de 900px (cf. styles.css) — remplacée sur
  // desktop par le menu déroulant ancré au menu latéral (cf.
  // renderAccountDropdown()), plus idiomatique à cette largeur qu'une
  // feuille pleine largeur centrée en bas de l'écran.
  function renderAccountModal() {
    var cu = person(state.currentUserId);
    return (
      '<div class="modal-overlay bottom account-modal-mobile" data-action="closeModal">' +
      '<div class="modal-sheet" data-stop-click>' +
      '<div class="modal-header"><div class="modal-title">Mon compte</div>' +
      '<button class="modal-close" data-action="closeModal" aria-label="Fermer"><i class="ph-bold ph-x"></i></button></div>' +
      '<div style="display:flex;align-items:center;gap:12px;padding:4px 0 22px">' +
      '<div class="avatar avatar-38" style="background:' + cu.color + '">' + initials(cu.name) + '</div>' +
      '<div style="font-size:15px;font-weight:600;color:var(--text-primary)">' + escapeHtml(cu.name) + '</div>' +
      '<button class="icon-btn pressable" style="margin-left:auto" data-action="openEditProfile" aria-label="Modifier mon prénom"><i class="ph-bold ph-pencil-simple"></i></button>' +
      '</div>' +
      (state.isAnonymous ? '<button class="switch-user-row pressable" data-action="openUpgradeAccount"><i class="ph-bold ph-user-plus" style="font-size:18px;color:var(--text-tertiary)"></i><span style="font-size:14.5px;color:var(--text-primary)">Créer un compte</span></button>' : '') +
      (state.isAnonymous ? '<button class="switch-user-row pressable" data-action="openConfirmSwitchAccount"><i class="ph-bold ph-sign-in" style="font-size:18px;color:var(--text-tertiary)"></i><span style="font-size:14.5px;color:var(--text-primary)">Se connecter à un compte existant</span></button>' : '') +
      '<button class="switch-user-row pressable" data-action="openAbout"><i class="ph-bold ph-info" style="font-size:18px;color:var(--text-tertiary)"></i><span style="font-size:14.5px;color:var(--text-primary)">À propos</span></button>' +
      '<button class="switch-user-row pressable" data-action="openPrivacy"><i class="ph-bold ph-shield-check" style="font-size:18px;color:var(--text-tertiary)"></i><span style="font-size:14.5px;color:var(--text-primary)">Confidentialité</span></button>' +
      '<button class="switch-user-row pressable" data-action="openFeedbackFromMenu"><i class="ph-bold ph-chat-text" style="font-size:18px;color:var(--text-tertiary)"></i><span style="font-size:14.5px;color:var(--text-primary)">Donner un avis</span></button>' +
      '<button class="switch-user-row pressable" data-action="toggleTheme" style="margin-bottom:6px"><i class="ph-bold ' + (state.theme === 'dark' ? 'ph-sun' : 'ph-moon') + '" style="font-size:18px;color:var(--text-tertiary)"></i><span style="font-size:14.5px;color:var(--text-primary)">' + (state.theme === 'dark' ? 'Mode clair' : 'Mode sombre') + '</span></button>' +
      '<button class="delete-link" data-action="logout"><i class="ph-bold ph-sign-out" style="margin-right:6px"></i>Se déconnecter</button>' +
      '<button class="delete-link" style="margin-top:8px" data-action="openConfirmDeleteAccount"><i class="ph-bold ph-trash" style="margin-right:6px"></i>Supprimer mon compte</button>' +
      '</div></div>'
    );
  }

  function renderManageMembersModal() {
    var mg = group(state.manageMembersGroupId);
    if (!mg) return '';
    // Seules les personnes déjà membres de CE groupe apparaissent ici — pour
    // ajouter quelqu'un d'autre, on passe par "+ inviter un membre" (par
    // e-mail) plutôt que par une liste de tous les comptes existants.
    var members = mg.memberIds.map(function (id) { return person(id); }).filter(Boolean);
    // Recherche : ne filtre que la liste des cartes membres ci-dessous — les
    // menus déroulants (responsable, foyer...) continuent de proposer tout
    // le monde, cf. `members` non filtré utilisé pour eux.
    var searchQuery = (state.manageMembersSearchQuery || '').trim().toLowerCase();
    var visibleMembers = !searchQuery ? members : members.filter(function (p) {
      return p.name.toLowerCase().indexOf(searchQuery) !== -1;
    });

    var guardianOptionsFor = function (p) {
      var opts = '<option value=""' + (!p.guardianId ? ' selected' : '') + '>— Aucun —</option>';
      opts += members.filter(function (x) { return x.id !== p.id; }).map(function (x) {
        return '<option value="' + x.id + '"' + (p.guardianId === x.id ? ' selected' : '') + '>' + escapeHtml(x.name) + '</option>';
      }).join('');
      return opts;
    };
    var groupHouseholds = state.households.filter(function (h) { return h.groupId === mg.id; });
    var householdOptionsFor = function (p) {
      var opts = '<option value=""' + (!p.householdId ? ' selected' : '') + '>— Aucun foyer —</option>';
      opts += groupHouseholds.map(function (h) {
        return '<option value="' + h.id + '"' + (p.householdId === h.id ? ' selected' : '') + '>' + escapeHtml(h.name) + '</option>';
      }).join('');
      return opts;
    };
    var rows = visibleMembers.map(function (p) {
      var isAdmin = p.id === mg.adminId;
      return (
        '<div style="background:var(--surface-overlay);border-radius:14px;padding:12px;margin-bottom:10px">' +
        '<div class="checkbox-row" style="border-top:none">' +
        '<div style="flex:1;font-size:14px;color:var(--text-primary);font-weight:600">' + escapeHtml(p.name) +
        (isAdmin ? ' (admin)' : '') +
        // "à charge" est un badge calculé (responsable défini), pas une
        // catégorie à choisir séparément.
        (p.guardianId ? '<span class="badge-child inline">À charge</span>' : '') +
        '</div>' +
        (!isAdmin ?
          '<button class="btn-icon-danger pressable" style="width:30px;height:30px;flex-shrink:0" data-action="openConfirmRemoveMember" data-group-id="' + mg.id + '" data-id="' + p.id + '" title="retirer du groupe" aria-label="Retirer du groupe"><i class="ph-bold ph-trash"></i></button>' : '') +
        '</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">' +
        '<div><div style="font-size:11px;color:var(--text-tertiary);margin-bottom:2px">Part habituelle (1 = part entière)</div>' +
        '<input class="text-input" style="margin-bottom:0" data-bind-change="shareWeight" data-id="' + p.id + '" value="' + (p.shareWeight != null ? p.shareWeight : 1) + '" inputmode="decimal" /></div>' +
        '<div><div style="font-size:11px;color:var(--text-tertiary);margin-bottom:2px">Responsable (si à charge)</div>' +
        '<select class="text-input" style="margin-bottom:0" data-bind-change="guardian" data-id="' + p.id + '">' + guardianOptionsFor(p) + '</select>' +
        '</div>' +
        '<div><div style="font-size:11px;color:var(--text-tertiary);margin-bottom:2px">Foyer</div>' +
        '<select class="text-input" style="margin-bottom:0" data-bind-change="household" data-id="' + p.id + '">' + householdOptionsFor(p) + '</select></div>' +
        '<div style="grid-column:1 / -1">' +
        (p.hasAccount ?
          // Lié à la connexion Supabase Auth de cette personne : pas
          // modifiable depuis ici pour éviter toute désynchronisation.
          (p.email ? '<div style="font-size:11px;color:var(--text-tertiary);margin-bottom:2px">E-mail</div><div style="font-size:13px;color:var(--text-secondary)">' + escapeHtml(p.email) + '</div>' : '') :
          '<div style="font-size:11px;color:var(--text-tertiary);margin-bottom:2px">E-mail (pour les rappels, facultatif)</div>' +
          '<input class="text-input" type="email" style="margin-bottom:0" data-bind-change="memberEmail" data-id="' + p.id + '" placeholder="Pas d\'e-mail renseigné" value="' + escapeHtml(p.email || '') + '" />') +
        '</div>' +
        '</div>' +
        '</div>'
      );
    }).join('');

    var addMemberSection = !state.showAddMemberForm ? '' :
      '<div style="background:var(--surface-overlay);border-radius:14px;padding:12px;margin-bottom:14px">' +
      '<div class="field-label">Prénom</div>' +
      '<input class="text-input" data-bind="addMemberName" placeholder="Prénom" value="' + escapeHtml(state.addMemberForm.name) + '" />' +
      '<div data-add-member-below>' + addMemberBelowNameHtml() + '</div>' +
      '<button class="btn-primary pressable" style="margin-top:10px' + (state.addingMember ? ';opacity:0.6' : '') + '" data-action="submitAddMember">' +
      (state.addingMember ? 'Ajout en cours…' : 'Ajouter') + '</button>' +
      '</div>';

    return (
      '<div class="modal-overlay bottom" data-action="closeModal">' +
      '<div class="modal-sheet" data-stop-click>' +
      '<div class="modal-header"><div class="modal-title">Membres · ' + escapeHtml(mg.name) + '</div>' +
      '<button class="modal-close" data-action="closeModal" aria-label="Fermer"><i class="ph-bold ph-x"></i></button></div>' +
      '<div class="section-label">Foyers</div>' +
      // Foyers existants, nom modifiable directement (comme l'e-mail d'un
      // membre juste en dessous) — jusqu'ici seul le formulaire de création
      // était affiché, aucune liste ne permettait de revenir sur un nom.
      (groupHouseholds.length ?
        '<div style="margin-bottom:10px">' +
        groupHouseholds.map(function (h) {
          return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
            '<i class="ph-bold ph-house-line" style="color:var(--text-tertiary);flex-shrink:0"></i>' +
            '<input class="text-input" style="margin-bottom:0;flex:1" data-bind-change="householdName" data-id="' + h.id + '" value="' + escapeHtml(h.name) + '" />' +
            '</div>';
        }).join('') +
        '</div>' : '') +
      '<div style="display:flex;gap:8px;margin-bottom:14px">' +
      '<input class="text-input" style="margin-bottom:0;flex:1" data-bind="newHouseholdName" placeholder="Nom du foyer" value="' + escapeHtml(state.newHouseholdName) + '" />' +
      '<button class="btn-outline pressable" style="flex-shrink:0" data-action="createHousehold">+ Créer</button>' +
      '</div>' +
      '<div class="section-label">Participants</div>' +
      (members.length > 5 ?
        '<input class="text-input" data-bind="manageMembersSearch" placeholder="Rechercher un membre..." value="' + escapeHtml(state.manageMembersSearchQuery) + '" />' : '') +
      (visibleMembers.length === 0 && searchQuery ?
        '<div style="font-size:13px;color:var(--text-tertiary);margin-bottom:16px">Aucun membre ne correspond à « ' + escapeHtml(state.manageMembersSearchQuery) + ' ».</div>' : rows) +
      addMemberSection +
      '<button class="dashed-btn pressable" data-action="toggleAddMemberForm">' + (state.showAddMemberForm ? 'Annuler' : '+ Ajouter un membre') + '</button>' +
      (state.formError ? '<div class="form-error">' + escapeHtml(state.formError) + '</div>' : '') +
      '</div></div>'
    );
  }

  function renderToast() {
    return state.toast ? '<div class="toast">' + escapeHtml(state.toast) + '</div>' : '';
  }

  // ---------- Délégation d'événements ----------

  function bindEvents(root) {
    root.onclick = function (e) {
      var stopEl = e.target.closest('[data-stop-click]');
      var overlay = e.target.closest('.modal-overlay');
      var el;
      if (overlay && !stopEl) {
        // Clic sur le fond de l'overlay lui-même (en dehors de la carte/feuille
        // de la modale) : on respecte l'action que CET overlay a déclarée
        // (généralement closeModal, mais cancelRemoveMember pour la
        // confirmation imbriquée dans "gérer les membres", pour ne fermer
        // que la confirmation et pas la modale en dessous).
        el = overlay;
      } else {
        if (stopEl && e.target === stopEl) return;
        el = e.target.closest('[data-action]');
        // Un data-action trouvé en dehors du conteneur de la modale (typiquement
        // l'overlay lui-même) ne doit pas s'appliquer à un clic sur un élément
        // inerte (champ texte, libellé...) à l'intérieur de la modale — sinon
        // ça la referme au moment même où l'utilisateur essaie de taper.
        if (el && stopEl && !stopEl.contains(el)) el = null;
      }
      if (!el) return;
      var action = el.getAttribute('data-action');
      var id = el.getAttribute('data-id');
      var groupId = el.getAttribute('data-group-id');
      e.stopPropagation();
      switch (action) {
        case 'goHome': goHome(); break;
        case 'goGroups': goGroups(); break;
        case 'goExpenses': goExpenses(); break;
        case 'goExpensesForGroup': goExpensesForGroup(id || null); break;
        case 'goSettleFromExpenses': goSettleFromExpenses(id || null); break;
        case 'goHistory': goHistory(); break;
        case 'goBack': goBack(); break;
        case 'toggleTheme': toggleTheme(); break;
        case 'toggleLandingLang': toggleLandingLang(); break;
        case 'toggleLandingMobileMenu': toggleLandingMobileMenu(); break;
        case 'closeLandingMobileMenu': closeLandingMobileMenu(); break;
        case 'openPerson': openPerson(id); break;
        case 'openGroup': openGroup(id); break;
        case 'remind': openReminderConfirm(id, groupId || null); break;
        case 'closeReminderConfirm': closeReminderConfirm(); break;
        case 'confirmSendReminder': confirmSendReminder(); break;
        case 'openAccount': openAccount(); break;
        case 'toggleGroupMenu': toggleGroupMenu(); break;
        case 'shareInviteLink': shareInviteLink(id); break;
        case 'openAbout': openAbout(); break;
        case 'openPrivacy': openPrivacy(); break;
        case 'closePrivacyScreen': closePrivacyScreen(); break;
        case 'acceptAnalytics': acceptAnalytics(); break;
        case 'declineAnalytics': declineAnalytics(); break;
        case 'reopenAnalyticsChoice': reopenAnalyticsChoice(); break;
        case 'exportMyData': exportMyData(); break;
        case 'openLoginForm': openLoginForm(); break;
        case 'goToLanding': goToLanding(); break;
        case 'ctaSignupFromAbout': ctaSignupFromAbout(); break;
        case 'enterApp': enterApp(); break;
        case 'exitToLanding': exitToLanding(); break;
        case 'tryWithoutAccount': tryWithoutAccount(); break;
        case 'performJoin': performJoin(); break;
        case 'cancelJoin': cancelJoin(); break;
        case 'logout': logout(); break;
        case 'openConfirmDeleteAccount': openConfirmDeleteAccount(); break;
        case 'cancelDeleteAccount': cancelDeleteAccount(); break;
        case 'confirmDeleteAccount': confirmDeleteAccount(); break;
        case 'openConfirmSwitchAccount': openConfirmSwitchAccount(); break;
        case 'cancelSwitchAccount': cancelSwitchAccount(); break;
        case 'confirmSwitchAccount': confirmSwitchAccount(); break;
        case 'openEditProfile': openEditProfile(); break;
        case 'cancelEditProfile': cancelEditProfile(); break;
        case 'submitEditProfile': submitEditProfile(); break;
        case 'dismissAccountDeleted': dismissAccountDeleted(); break;
        case 'openAddExpenseGlobal': openAddExpense(id || state.lastActiveGroupId || (state.groups[0] && state.groups[0].id)); break;
        case 'setHomeGroupFilter': setHomeGroupFilter(id); break;
        case 'setExpensesGroupFilter': setExpensesGroupFilter(id); break;
        case 'setExpensesPersonFilter': setExpensesPersonFilter(id); break;
        case 'setExpensesCategoryFilter': setExpensesCategoryFilter(id); break;
        case 'toggleExpenseFilters': toggleExpenseFilters(); break;
        case 'setExpensesDatePreset': setExpensesDatePreset(id); break;
        case 'setExpensesStatusFilter': setExpensesStatusFilter(id); break;
        case 'resetExpenseFilters': resetExpenseFilters(); break;
        case 'removeExpenseFilterChip': removeExpenseFilterChip(id); break;
        case 'setPersonGroupFilter': setPersonGroupFilter(id); break;
        case 'openAddExpenseForGroup': openAddExpense(state.selectedGroupId); break;
        case 'openAddGroup': openAddGroup(); break;
        case 'openManageMembers': openManageMembers(id); break;
        case 'generateShareLink': generateShareLink(); break;
        case 'disableShareLink': disableShareLink(); break;
        case 'copyShareLink': copyShareLink(); break;
        case 'openUpgradeAccount': openUpgradeAccount(); break;
        case 'dismissUpgradeNudge': dismissUpgradeNudge(); break;
        case 'dismissReminderBanner': dismissReminderBanner(id); break;
        case 'submitUpgradeAccount': submitUpgradeAccount(); break;
        case 'openFeedbackFromMenu': openFeedbackFromMenu(); break;
        case 'setFeedbackRating': setFeedbackRating(id); break;
        case 'submitFeedback': submitFeedback(); break;
        case 'openConfirmDeleteGroup': openConfirmDeleteGroup(id); break;
        case 'confirmDeleteGroup': confirmDeleteGroup(); break;
        case 'editExpense': openEditExpense(id); break;
        case 'markPaidFull': markExpensePaidFull(id); break;
        case 'closeModal': closeModal(); break;
        case 'toggleLoginMode': toggleLoginMode(); break;
        case 'showSignup': showSignup(); break;
        case 'showPasswordLogin': showPasswordLogin(); break;
        case 'showForgotPassword': showForgotPassword(); break;
        case 'backToLoginForm': backToLoginForm(); break;
        case 'submitLogin': submitLogin(); break;
        case 'submitSignup': submitSignup(); break;
        case 'submitMagicLink': submitMagicLink(); break;
        case 'submitForgotPassword': submitForgotPassword(); break;
        case 'submitNewPassword': submitNewPassword(); break;
        case 'selectGroupForForm': selectGroupForForm(id); break;
        case 'selectPayer': selectPayer(id); break;
        case 'toggleParticipant': toggleParticipant(id); break;
        case 'toggleAllParticipants': toggleAllParticipants(); break;
        case 'toggleFullyPaid': toggleFullyPaid(); break;
        case 'refreshExchangeRate': refreshExchangeRate(); break;
        case 'toggleFreezeCurrencyRates': toggleFreezeCurrencyRates(); break;
        case 'setCategory': setCategory(id); break;
        case 'setSplitMode': setSplitMode(id); break;
        case 'submitExpense': submitExpense(); break;
        case 'deleteExpense': deleteExpense(); break;
        case 'viewReceipt': viewReceipt(el.getAttribute('data-path')); break;
        case 'removeReceipt': removeReceipt(); break;
        case 'clearReceiptFile': setReceiptFile(null); break;
        case 'addInviteeRow': addInviteeRow(); break;
        case 'removeInviteeRow': removeInviteeRow(parseInt(id, 10)); break;
        case 'submitGroup': submitGroup(); break;
        case 'openSettle': openSettle(id, groupId || null); break;
        case 'quickSettle': openSettleForPair(el.getAttribute('data-from'), el.getAttribute('data-to'), parseFloat(el.getAttribute('data-amount')), groupId || null); break;
        case 'exportGroupCsv': exportGroupCsv(id); break;
        case 'exportGroupExcel': exportGroupExcel(id); break;
        case 'exportGroupPdf': exportGroupPdf(id); break;
        case 'submitSettle': submitSettle(); break;
        case 'openConfirmRemoveMember': openConfirmRemoveMember(groupId, id); break;
        case 'cancelRemoveMember': cancelRemoveMember(); break;
        case 'confirmRemoveMember': confirmRemoveMember(); break;
        case 'openConfirmLeaveGroup': openConfirmLeaveGroup(id); break;
        case 'cancelLeaveGroup': cancelLeaveGroup(); break;
        case 'confirmLeaveGroup': confirmLeaveGroup(); break;
        case 'cancelMergeGuest': cancelMergeGuest(); break;
        case 'confirmMergeGuest': confirmMergeGuest(); break;
        case 'setGroupUnitMode': setGroupUnitMode(id); break;
        case 'createHousehold': createHousehold(); break;
        case 'toggleAddMemberForm': toggleAddMemberForm(); break;
        case 'submitAddMember': submitAddMember(); break;
        case 'selectExistingGuestForAddMember': selectExistingGuestForAddMember(id); break;
        case 'unlinkExistingGuestForAddMember': unlinkExistingGuestForAddMember(); break;
        case 'selectExistingGuestForInvitee': selectExistingGuestForInvitee(parseInt(groupId, 10), id); break;
        case 'unlinkExistingGuestForInvitee': unlinkExistingGuestForInvitee(parseInt(id, 10)); break;
        default: break;
      }
    };

    root.oninput = function (e) {
      var el = e.target;
      var bind = el.getAttribute('data-bind');
      if (!bind) return;
      var id = el.getAttribute('data-id');
      var v = el.value;
      switch (bind) {
        case 'loginEmail': setLoginEmail(v); break;
        case 'loginPassword': setLoginPassword(v); break;
        case 'loginName': setLoginName(v); break;
        case 'joinName': setJoinNameInput(v); break;
        case 'upgradeName': setUpgradeName(v); break;
        case 'upgradeEmail': setUpgradeEmail(v); break;
        case 'upgradePassword': setUpgradePassword(v); break;
        case 'editProfileName': setEditProfileName(v); break;
        case 'feedbackComment': setFeedbackComment(v); break;
        case 'newPassword': setNewPassword(v); break;
        case 'expenseLabel': setLabel(v); break;
        case 'expenseAmount': setAmount(v); break;
        case 'expenseForeignAmount': setForeignAmount(v); break;
        case 'expenseExchangeRate': setExchangeRate(v); break;
        case 'expenseDate': setDate(v); break;
        case 'paidExternal': setPaidExternal(v); break;
        case 'groupName': setGroupName(v); break;
        case 'settleAmount': setSettleAmount(v); break;
        case 'settleReference': setSettleReference(v); break;
        case 'expensesSearch': setExpensesSearch(v); break;
        case 'expensesDateFrom': setExpensesDateFrom(v); break;
        case 'expensesDateTo': setExpensesDateTo(v); break;
        case 'expensesAmountMin': setExpensesAmountMin(v); break;
        case 'expensesAmountMax': setExpensesAmountMax(v); break;
        case 'expensesFilterGroupSearch': setExpensesFilterGroupSearch(v); break;
        case 'expensesFilterPersonSearch': setExpensesFilterPersonSearch(v); break;
        case 'reminderEmailDraft':
          setReminderEmailDraft(v);
          // Bascule le bouton d'envoi directement en DOM (comme le reste de
          // ce champ, cf. setStateSilent) plutôt qu'un rendu complet — sans
          // ça, l'état activé/désactivé du bouton ne suivrait la frappe
          // qu'au prochain rendu déclenché par autre chose.
          var confirmBtn = root.querySelector('[data-action="confirmSendReminder"]');
          if (confirmBtn) {
            var canSendNow = v.trim().indexOf('@') !== -1;
            confirmBtn.disabled = !canSendNow;
            confirmBtn.style.opacity = canSendNow ? '' : '.5';
            confirmBtn.style.cursor = canSendNow ? '' : 'not-allowed';
          }
          break;
        case 'manageMembersSearch': setManageMembersSearch(v); break;
        case 'splitValue': setSplitValue(id, v); break;
        case 'inviteeName': setInviteeName(parseInt(id, 10), v); break;
        case 'inviteeEmail': setInviteeEmail(parseInt(id, 10), v); break;
        case 'inviteeShare': setInviteeShare(parseInt(id, 10), v); break;
        case 'newHouseholdName': setNewHouseholdName(v); break;
        case 'addMemberName': setAddMemberName(v); break;
        case 'addMemberEmail': setAddMemberEmail(v); break;
        case 'addMemberWeight': setAddMemberWeight(v); break;
        default: break;
      }
    };

    root.onchange = function (e) {
      var el = e.target;
      var bind = el.getAttribute('data-bind-change');
      if (!bind) return;
      var id = el.getAttribute('data-id');
      if (bind === 'receiptFile') { setReceiptFile(el.files && el.files[0] ? el.files[0] : null); return; }
      if (bind === 'scanFile') { if (el.files && el.files[0]) scanReceipt(el.files[0]); return; }
      switch (bind) {
        case 'override': setOverride(id, el.value); break;
        case 'shareWeight': setShareWeight(id, el.value); break;
        case 'guardian': setGuardian(id, el.value); break;
        case 'household': setMemberHousehold(id, el.value); break;
        case 'memberEmail': setMemberEmail(id, el.value); break;
        case 'householdName': renameHousehold(id, el.value); break;
        case 'addMemberGuardian': setAddMemberGuardian(el.value); break;
        case 'groupCurrency': setGroupCurrency(el.value); break;
        case 'expenseCurrency': selectExpenseCurrency(el.value); break;
        case 'expensesSort': setExpensesSort(el.value); break;
        case 'settlePaymentMethod': setSettlePaymentMethod(el.value); break;
        default: break;
      }
    };
  }

  // ---------- Démarrage ----------

  // Durée de l'écran de lancement : dernière bande installée à 1.13s (sh3
  // démarre à .58s, anime .55s) ; wordmark + baseline finissent leur fondu à
  // 1.8s/1.98s (cf. styles.css) — marge à 3.2s pour laisser un temps de
  // lecture avant de retirer l'écran. Le chargement des données (retour d'un
  // compte connecté) se poursuit en parallèle pendant ce délai (cf. garde
  // dans render()) ; une fois l'écran de lancement retiré, l'écran suivant
  // (connexion ou app) reflète déjà l'état résolu à ce moment-là.
  function armSplashTimeout() {
    setTimeout(function () { setState({ showSplash: false }); }, 3200);
  }

  // Safari iOS n'active la pseudo-classe :active au toucher que si un
  // gestionnaire d'événement tactile existe quelque part dans la page —
  // sans ça, tout le retour visuel au tap (.pressable:active, cf. styles.css)
  // ne se déclenche jamais sur iPhone, alors qu'il fonctionne normalement
  // partout ailleurs (souris, autres navigateurs mobiles).
  document.addEventListener('touchstart', function () {}, { passive: true });

  // Léger parallax sur le liseré tressé de la landing (.ldg-thread-divider,
  // cf. renderAboutScreen) : un seul listener global posé une fois pour
  // toutes (et non dans render(), qui tourne à chaque changement d'état) —
  // il retrouve les éléments à chaque défilement, ce qui reste correct même
  // après une reconstruction complète du DOM. Le déplacement se fait via
  // background-position (pas de transform), et reste borné à la taille d'un
  // motif (24px) : aucun risque de "bord" visible, quel que soit le défilement.
  // Écoute en phase de capture sur document (et non window.scroll) car le
  // défilement réel a lieu sur un conteneur interne (.about-standalone-screen
  // / .content), pas sur la fenêtre elle-même — un événement 'scroll' sur un
  // élément ne remonte pas jusqu'à window, seule la phase de capture l'attrape.
  if (!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
    var threadParallaxTicking = false;
    document.addEventListener('scroll', function (e) {
      if (threadParallaxTicking) return;
      threadParallaxTicking = true;
      requestAnimationFrame(function () {
        var dividers = document.querySelectorAll('.ldg-thread-divider');
        if (dividers.length) {
          var scrollTop = e.target === document ? window.scrollY : (e.target.scrollTop || 0);
          var offset = (scrollTop * 0.06) % 24;
          for (var i = 0; i < dividers.length; i++) dividers[i].style.backgroundPositionX = offset + 'px';
        }
        threadParallaxTicking = false;
      });
    }, { capture: true, passive: true });
  }

  document.addEventListener('DOMContentLoaded', function () {
    render();
    // N'amorce le minuteur de retrait de l'écran de lancement que s'il est
    // réellement affiché (transition explicite vers l'appli ou la page de
    // connexion, cf. defaultState) — au premier chargement, showSplash est
    // toujours false, donc rien à amorcer ici.
    if (state.showSplash) armSplashTimeout();
    if (state.joinToken) fetchJoinPreview();
    // Choix de mesure d'audience déjà connu (visite précédente) : on
    // recharge directement le script si accepté, sans jamais réafficher le
    // bandeau — celui-ci n'apparaît que quand analyticsConsent est encore
    // null (cf. render()).
    if (state.analyticsConsent === 'granted') loadCloudflareAnalytics();
    sb.auth.onAuthStateChange(function (event, session) {
      if (event === 'PASSWORD_RECOVERY') {
        setState({ passwordRecovery: true, loginError: null, newPasswordForm: { password: '' } });
        return;
      }
      if (session) {
        var alreadyLoaded = state.loggedIn && state.currentUserId === session.user.id;
        // is_anonymous distingue une session créée par signInAnonymously
        // (cf. performJoin) d'un vrai compte — sert à proposer "Créer un
        // compte" dans le menu plutôt qu'à traiter cette personne comme un
        // compte incomplet.
        setStateSilent({ loggedIn: true, currentUserId: session.user.id, loginError: null, isAnonymous: !!session.user.is_anonymous });
        if (!alreadyLoaded) {
          setStateSilent({ dataLoading: true });
          render();
          loadAppData();
        }
      } else {
        // Contrôle d'auth obsolète : cet évènement "pas de session" a
        // démarré avant qu'une session plus rapide ne s'établisse entre-
        // temps (essai sans compte via signInAnonymously, ou lien
        // d'invitation) et arrive après coup — l'appliquer quand même
        // écraserait tout l'état en cours et renverrait sur la landing en
        // pleine création de groupe, sans erreur visible ("bouton qui ne
        // mène nulle part"). Seul un vrai SIGNED_OUT doit déclencher la
        // réinitialisation complète ci-dessous ; tout le reste, si on est
        // déjà connecté, est ignoré.
        if (event !== 'SIGNED_OUT' && state.loggedIn) return;
        var theme = state.theme;
        // Ce même branchement (session absente) couvre deux cas bien
        // différents : (a) le tout premier contrôle d'auth au chargement de
        // la page, quand personne n'est encore connecté — l'écran de
        // lancement doit continuer de jouer normalement, son minuteur le
        // masquera en temps voulu — et (b) une vraie déconnexion depuis
        // l'app, où l'écran de lancement a déjà fini depuis longtemps et ne
        // doit surtout pas être remis à `true` par defaultState() (son
        // minuteur ne se redéclenche jamais après coup, l'app resterait
        // bloquée dessus indéfiniment). On ne force `showSplash` à `false`
        // que dans le cas (b), identifié via `state.loggedIn` AVANT ce
        // reset : s'il était vrai, on vient bien de se déconnecter.
        var wasLoggedIn = state.loggedIn;
        // Préserve aussi l'avancement d'un lien d'invitation en cours (cf.
        // fetchJoinPreview/performJoin) : ce contrôle d'auth initial arrive
        // souvent quelques dizaines de ms après le premier rendu, parfois
        // après que la preview du lien ait déjà été récupérée — sans ça,
        // defaultState() l'effacerait et l'écran resterait bloqué sur
        // "Chargement du lien d'invitation…" indéfiniment.
        // Une vraie déconnexion (b) repart sur la landing sans reprendre la
        // position enregistrée, et efface cette dernière — sinon une
        // connexion ultérieure dans le même onglet (même à un autre compte)
        // réafficherait l'écran de la session précédente. Le cas (a) reprend
        // la position normalement (cf. resumedNavPatch), comme au tout
        // premier chargement de la page.
        if (wasLoggedIn) clearNavState();
        state = Object.assign({}, defaultState(), {
          theme: theme, landingLang: state.landingLang, showSplash: wasLoggedIn ? false : state.showSplash,
          joinPreview: state.joinPreview, joinNameInput: state.joinNameInput,
          joinError: state.joinError, joinSubmitting: state.joinSubmitting,
          analyticsConsent: state.analyticsConsent, accountJustDeleted: state.accountJustDeleted,
          // cf. confirmSwitchAccount : atterrit directement sur le formulaire
          // de connexion plutôt que sur la landing, après un "Se connecter"
          // depuis un compte invité.
          showLoginForm: pendingLoginAfterSignOut,
        }, wasLoggedIn ? {} : resumedNavPatch());
        pendingLoginAfterSignOut = false;
        render();
      }
    });
  });
}());
