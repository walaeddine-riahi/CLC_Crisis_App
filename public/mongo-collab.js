(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const els = {
    overlay: $('collabLoginOverlay'), form: $('collabLoginForm'), sessionCheck: $('collabSessionCheck'), email: $('collabEmail'), password: $('collabPassword'), error: $('collabLoginError'),
    fab: $('collabFab'), dot: $('collabDot'), fabText: $('collabFabText'), panel: $('collabPanel'), status: $('collabStatusText'),
    user: $('collabUserName'), role: $('collabRole'), entity: $('collabEntity'), workspace: $('collabWorkspace'), last: $('collabLastSync'), users: $('collabUsers'),
    sync: $('collabSyncNow'), manageUsers: $('collabManageUsers'), signout: $('collabSignOut'), banner: $('collabBanner'),
    adminNav: $('v17AdminNav'), adminHost: $('v17-admin')
  };
  const ROLE_LABELS = { ADMIN: 'Administrateur', GROUP_CRISIS: 'Cellule Groupe', SITE_CLC: 'Cellule CLC', SITE_CF: 'Cellule CF', ACTION_OWNER: 'Responsable d’action', DG: 'Direction Générale', VIEWER: 'Lecture seule' };
  const OPERATIONAL_ROLE_LABELS = { ADMIN: 'Administrateur', GROUP_CRISIS: 'Gestion des risques Groupe', SITE_CLC: 'Coordinateur crise local', SITE_CF: 'Coordinateur crise local', ACTION_OWNER: 'Responsable d’action', DG: 'Direction Générale', VIEWER: 'Lecture seule' };
  const LOCAL_ONLY_KEYS = new Set(['profile']);
  const app = window.CLC_APP_BRIDGE;
  const WRITE_SECTIONS = {
    ADMIN: '*', GROUP_CRISIS: '*',
    SITE_CLC: ['actions', 'simpleChecklists', 'entityDecisions', 'terrainEvidence', 'terrainByZone', 'journal', 'logistics', 'scope', 'emergencyOverride', 'lastTerrainUpdate', 'meteo', 'autoWeather', 'multiWeather'],
    SITE_CF: ['actions', 'simpleChecklists', 'entityDecisions', 'terrainEvidence', 'terrainByZone', 'journal', 'scope', 'emergencyOverride', 'lastTerrainUpdate', 'meteo', 'autoWeather', 'multiWeather'],
    ACTION_OWNER: ['actions', 'simpleChecklists', 'journal'], DG: ['crisis', 'deployment', 'entityDecisions', 'journal', 'decisions', 'meta'], VIEWER: []
  };
  let profile = null, workspace = null, ready = false, syncing = false, syncTimer = null, pollTimer = null, presenceTimer = null;
  let lastSynced = {}, versions = {}, latestSyncAt = null, lastPollAt = null;
  let adminState = { users: [], roles: [], actionCatalog: [], currentUserId: null, logs: [], pagination: { page: 1, pages: 1, total: 0 }, stats: { total: 0, last24h: 0, activeUsers24h: 0 }, filters: { eventType: '', search: '' }, loading: false, message: '', messageType: '' };

  const clone = (v) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const itemKey = (x) => x && typeof x === 'object' ? (x.id ?? x.code ?? x.key ?? x.name ?? x.object ?? x.action ?? x.item ?? x.label ?? null) : null;
  function threeWay(base, local, remote, path = []) {
    if (eq(local, base)) return clone(remote);
    if (eq(remote, base) || eq(local, remote)) return clone(local);
    if (Array.isArray(local) && Array.isArray(remote)) {
      const keyed = [...local, ...remote].filter(x => x && typeof x === 'object').every(x => itemKey(x) != null);
      const leaf = path[path.length - 1] || '';
      if (keyed) {
        const bm = new Map((Array.isArray(base) ? base : []).map(x => [String(itemKey(x)), x]));
        const lm = new Map(local.map(x => [String(itemKey(x)), x]));
        const rm = new Map(remote.map(x => [String(itemKey(x)), x]));
        const order = [];
        for (const x of local) order.push(String(itemKey(x)));
        for (const x of remote) { const k = String(itemKey(x)); if (!order.includes(k)) order.push(k); }
        return order.map(k => threeWay(bm.get(k), lm.get(k), rm.get(k), path.concat(k))).filter(v => v !== undefined);
      }
      if (['journal', 'terrainEvidence', 'history'].includes(leaf)) {
        const seen = new Set(), out = [];
        for (const x of [...local, ...remote]) { const k = JSON.stringify(x); if (!seen.has(k)) { seen.add(k); out.push(clone(x)); } }
        if (leaf !== 'history') out.sort((a, b) => String(b.time || b.updated || '').localeCompare(String(a.time || a.updated || '')));
        return out.slice(0, leaf === 'journal' ? 250 : 1000);
      }
      return clone(local);
    }
    const obj = (v) => v && typeof v === 'object' && !Array.isArray(v);
    if (obj(local) && obj(remote)) {
      const out = {}, keys = new Set([...Object.keys(obj(base) ? base : {}), ...Object.keys(local), ...Object.keys(remote)]);
      for (const k of keys) { const v = threeWay(obj(base) ? base[k] : undefined, local[k], remote[k], path.concat(k)); if (v !== undefined) out[k] = v; }
      return out;
    }
    return clone(local);
  }

  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  async function api(url, options = {}) {
    const requestUrl = new URL(url, window.location.origin).toString();
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetch(requestUrl, {
          ...options,
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
          cache: 'no-store'
        });
        break;
      } catch (error) {
        if (attempt === 1) {
          const networkError = new Error('Connexion au serveur interrompue. Vérifiez votre réseau, puis réessayez.');
          networkError.cause = error; throw networkError;
        }
        await wait(750);
      }
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const fallback = response.status >= 500
        ? 'Le service serveur est temporairement indisponible. Vérifiez la configuration MongoDB du déploiement.'
        : `Erreur HTTP ${response.status}`;
      const error = new Error(data.error || fallback); error.status = response.status; error.data = data; throw error;
    }
    return data;
  }
  function canWrite(section) { const allowed = WRITE_SECTIONS[profile?.role] ?? []; return allowed === '*' || allowed.includes(section); }
  function setStatus(kind, text) {
    els.dot.className = `collab-dot ${kind}`; els.status.textContent = text;
    els.fabText.textContent = kind === 'online' ? 'Synchronisé' : kind === 'syncing' ? 'Synchronisation…' : kind === 'offline' ? 'Hors connexion' : 'Temps réel';
  }
  function flash(text, ms = 2400) { els.banner.textContent = text; els.banner.classList.add('show'); clearTimeout(flash._t); flash._t = setTimeout(() => els.banner.classList.remove('show'), ms); }
  function showError(message) { els.error.textContent = message; els.error.classList.add('show'); }
  function hideError() { els.error.classList.remove('show'); }
  function showLoginForm() { els.sessionCheck.hidden = true; els.form.hidden = false; els.overlay.classList.remove('hidden'); }
  function updateIdentity() {
    window.CLC_AUTH_ROLE = profile?.role || 'VIEWER';
    window.CLC_AUTH_ENTITY = profile?.entity || '';
    window.CLC_AUTH_ACTION_ACCESS = Array.isArray(profile?.actionAccess) ? profile.actionAccess : [];
    document.documentElement.dataset.authRole = window.CLC_AUTH_ROLE;
    els.user.textContent = profile?.displayName || profile?.email || '—'; els.role.textContent = ROLE_LABELS[profile?.role] || profile?.role || '—';
    els.entity.textContent = profile?.entity || 'Groupe'; els.workspace.textContent = workspace?.name || '—';
    if (els.manageUsers) els.manageUsers.style.display = profile?.role === 'ADMIN' ? '' : 'none';
    if (els.adminNav) els.adminNav.hidden = profile?.role !== 'ADMIN';
    if (profile?.role !== 'ADMIN' && els.adminHost?.classList.contains('active')) document.querySelector('[data-v17="situation"]')?.click();
    els.last.textContent = latestSyncAt ? new Date(latestSyncAt).toLocaleTimeString('fr-FR') : '—';
  }
  function applyAccountIdentity(next) {
    if (!profile) return next;
    next.profile = {
      ...(next.profile || {}),
      role: OPERATIONAL_ROLE_LABELS[profile.role] || 'Lecture seule',
      name: profile.displayName || profile.email || 'Utilisateur',
    };
    return next;
  }
  function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }
  function renderPresence(rows) {
    if (!rows.length) { els.users.innerHTML = '<div class="collab-muted">Aucun utilisateur détecté.</div>'; return; }
    els.users.innerHTML = rows.map(p => `<div class="collab-user"><span><b>${escapeHtml(p.displayName || p.email || 'Utilisateur')}</b><br><span class="collab-muted">${escapeHtml(ROLE_LABELS[p.role] || p.role || '')} ${p.entity ? '• ' + escapeHtml(p.entity) : ''}</span></span><span>${p.onlineAt ? new Date(p.onlineAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : ''}</span></div>`).join('');
  }
  function applyRows(rows) {
    const next = clone(app.getState());
    for (const row of rows) {
      if (LOCAL_ONLY_KEYS.has(row.sectionKey)) continue;
      next[row.sectionKey] = clone(row.payload); versions[row.sectionKey] = Number(row.version || 0); lastSynced[row.sectionKey] = clone(row.payload);
    }
    applyAccountIdentity(next); next.version = '4.0'; app.replaceState(next, { notify: false, render: true }); latestSyncAt = new Date().toISOString(); updateIdentity();
  }

  async function bootstrap() {
    let data = await api('/api/collab/bootstrap');
    profile = data.user; workspace = data.workspace; updateIdentity();
    if (!data.sections.length) {
      if (profile.role !== 'ADMIN') throw new Error('Situation centrale non initialisée. Un administrateur doit se connecter en premier.');
      const initialState = clone(app.getState());
      for (const key of LOCAL_ONLY_KEYS) delete initialState[key];
      await api('/api/collab/bootstrap', { method: 'POST', body: JSON.stringify({ initialState }) });
      data = await api('/api/collab/bootstrap');
    }
    lastSynced = {}; versions = {}; applyRows(data.sections); lastPollAt = new Date().toISOString();
  }

  async function syncSection(key, localValue) {
    if (!canWrite(key)) { const next = app.getState(); next[key] = clone(lastSynced[key]); app.replaceState(next, { notify: false, render: true }); flash(`Votre rôle ne permet pas de modifier « ${key} ».`); return; }
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const row = await api('/api/collab/section', { method: 'PUT', body: JSON.stringify({ sectionKey: key, payload: localValue, baseVersion: versions[key] || 0 }) });
        const next = app.getState(); next[key] = clone(row.payload); app.replaceState(next, { notify: false, render: false }); lastSynced[key] = clone(row.payload); versions[key] = Number(row.version); return;
      } catch (error) {
        if (error.status !== 409 || !error.data?.current) throw error;
        const remote = error.data.current;
        localValue = threeWay(lastSynced[key], localValue, remote.payload, [key]);
        lastSynced[key] = clone(remote.payload); versions[key] = Number(remote.version); const next = app.getState(); next[key] = clone(localValue); app.replaceState(next, { notify: false, render: false });
      }
    }
    throw new Error(`Conflit persistant sur ${key}.`);
  }
  async function syncChangedSections(force = false) {
    if (!ready || syncing || !navigator.onLine) return;
    const current = app.getState();
    const keys = Object.keys(current).filter(k => !LOCAL_ONLY_KEYS.has(k) && (force || !eq(current[k], lastSynced[k])) && canWrite(k));
    if (!keys.length) { setStatus('online', 'Synchronisé — aucun changement en attente.'); return; }
    syncing = true; setStatus('syncing', `${keys.length} section(s) en synchronisation…`);
    try {
      for (const key of keys) if (force || !eq(app.getState()[key], lastSynced[key])) await syncSection(key, app.getState()[key]);
      latestSyncAt = new Date().toISOString(); updateIdentity(); app.persist({ notify: false }); setStatus('online', 'Toutes les modifications sont synchronisées.');
    } catch (error) { console.error(error); setStatus('offline', `Synchronisation interrompue : ${error.message}`); flash('Modifications conservées localement — nouvelle tentative automatique.', 3500); }
    finally { syncing = false; }
  }
  function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(() => syncChangedSections(false), 350); }

  async function pollRemote() {
    if (!ready || syncing || !navigator.onLine) return;
    try {
      const data = await api(`/api/collab/section${lastPollAt ? `?after=${encodeURIComponent(lastPollAt)}` : ''}`);
      lastPollAt = data.serverTime;
      let changed = false;
      const next = app.getState();
      for (const row of data.sections) {
        if (LOCAL_ONLY_KEYS.has(row.sectionKey)) continue;
        if (Number(row.version) <= Number(versions[row.sectionKey] || 0)) continue;
        const key = row.sectionKey, remote = clone(row.payload), merged = threeWay(lastSynced[key], next[key], remote, [key]);
        lastSynced[key] = clone(remote); versions[key] = Number(row.version); next[key] = clone(merged); changed = true;
        if (!eq(merged, remote)) scheduleSync();
      }
      if (changed) { applyAccountIdentity(next); next.version = '4.0'; app.replaceState(next, { notify: false, render: true }); latestSyncAt = new Date().toISOString(); updateIdentity(); flash('Mise à jour reçue de la situation Groupe.'); }
      setStatus('online', 'Connecté à la situation Groupe.');
    } catch (error) { console.warn('poll', error); setStatus('offline', 'Connexion centrale temporairement indisponible.'); }
  }
  async function heartbeat() {
    if (!ready) return;
    try { await api('/api/collab/presence', { method: 'POST', body: '{}' }); const data = await api('/api/collab/presence'); renderPresence(data.users || []); } catch (_) { }
  }
  async function start() {
    ready = false; setStatus('syncing', 'Connexion à MongoDB…'); await bootstrap();
    ready = true; els.overlay.classList.add('hidden'); setStatus('online', 'Synchronisé avec la base centrale MongoDB.');
    app.setPersistHook(scheduleSync);
    clearInterval(pollTimer); clearInterval(presenceTimer); pollTimer = setInterval(pollRemote, 4000); presenceTimer = setInterval(heartbeat, 15000);
    await heartbeat(); scheduleSync();
  }
  async function stop() {
    ready = false; app.setPersistHook(null); clearInterval(pollTimer); clearInterval(presenceTimer); showLoginForm(); setStatus('offline', 'Déconnecté.');
  }
  async function restoreSession() {
    const session = await api('/api/login');
    if (session.authenticated) await start(); else showLoginForm();
  }

  const adminDate = (value) => value ? new Date(value).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : 'Jamais';
  const adminEventLabels = { login: 'Connexion', login_failed: 'Échec de connexion', logout: 'Déconnexion', first_admin_created: 'Premier administrateur créé', user_created: 'Utilisateur créé', user_updated: 'Utilisateur modifié', sessions_revoked: 'Sessions révoquées', workspace_bootstrap: 'Initialisation plateforme', section_update: 'Donnée métier modifiée' };
  function adminLogDetail(log) {
    const d = log.details || {};
    if (log.eventType === 'section_update') return `Section ${log.sectionKey || '—'} • version ${d.version || '—'} • ${d.entity || ''}`;
    if (log.eventType === 'user_created') return `${d.email || log.target?.email || 'Compte'} • ${ROLE_LABELS[d.role] || d.role || ''}`;
    if (log.eventType === 'user_updated') return `${d.targetEmail || log.target?.email || 'Compte'} • champs : ${(d.fields || []).join(', ') || 'aucun'}${d.revokedSessions ? ' • sessions révoquées' : ''}`;
    if (log.eventType === 'sessions_revoked') return `${d.targetEmail || log.target?.email || 'Compte'} • toutes les sessions ont été fermées`;
    if (log.eventType === 'login_failed') return `${d.email || log.actor?.email || 'Compte inconnu'} • ${d.reason === 'inactive_account' ? 'compte désactivé' : 'identifiants incorrects'}`;
    if (log.eventType === 'workspace_bootstrap') return `${d.sections || 0} sections initialisées`;
    return log.target?.email ? `Compte concerné : ${log.target.email}` : 'Événement de plateforme';
  }
  function adminMessage(text, type = '') { adminState.message = text; adminState.messageType = type; renderAdminDashboard(); }
  function renderAdminDashboard() {
    if (!els.adminHost || profile?.role !== 'ADMIN') return;
    if (adminState.loading && !adminState.users.length) { els.adminHost.innerHTML = '<div class="v17-empty">Chargement du tableau de bord administrateur…</div>'; return; }
    const users = adminState.users || [], active = users.filter(u => u.active).length, admins = users.filter(u => u.active && u.role === 'ADMIN').length, connected = users.reduce((sum, u) => sum + Number(u.activeSessions || 0), 0);
    const availableRoles = adminState.roles?.length ? adminState.roles : Object.keys(ROLE_LABELS);
    const roleOptions = availableRoles.map(r => `<option value="${escapeHtml(r)}"${r === 'VIEWER' ? ' selected' : ''}>${escapeHtml(ROLE_LABELS[r] || r)}</option>`).join('');
    const actionEntities = ['CLC', 'SBC', 'Delta Plastic', 'CF', 'Boucharray', 'Atig'];
    const entityOptions = selected => [...new Set(['Groupe', ...actionEntities, selected].filter(Boolean))].map(entity => `<option value="${escapeHtml(entity)}"${entity === selected ? ' selected' : ''}>${escapeHtml(entity)}</option>`).join('');
    const actionCatalog = adminState.actionCatalog || [];
    const additionalAccess = user => {
      const selected = new Set(Array.isArray(user.actionAccess) ? user.actionAccess : []);
      return `<details class="admin-access"><summary>Actions supplémentaires en lecture (${selected.size})</summary><p>Ces autorisations s’ajoutent au rôle, à l’entité et au responsable du compte.</p><div class="admin-access-list">${actionCatalog.map(item => `<label><input type="checkbox" data-action-access value="${escapeHtml(item.ref)}"${selected.has(item.ref) ? ' checked' : ''}><span><b>${escapeHtml(item.entity)}</b> — ${escapeHtml(item.label)}<small>Responsable : ${escapeHtml(item.owner)}</small></span></label>`).join('') || '<span class="collab-muted">Aucune action disponible.</span>'}</div></details>`;
    };
    const eventOptions = Object.entries(adminEventLabels).map(([value, label]) => `<option value="${value}"${adminState.filters.eventType === value ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('');
    els.adminHost.innerHTML = `<div class="v17-head"><div><h2>Administration de la plateforme</h2><p>Gérer les comptes, les rôles, les accès et consulter la traçabilité technique et métier.</p></div><div class="v17-actions"><button class="v17-btn" id="adminRefresh">Actualiser</button></div></div>
      ${adminState.message ? `<div class="admin-message ${escapeHtml(adminState.messageType)}">${escapeHtml(adminState.message)}</div>` : ''}
      <div class="admin-kpis"><div class="admin-kpi"><span>Utilisateurs actifs</span><b>${active}/${users.length}</b></div><div class="admin-kpi"><span>Administrateurs</span><b>${admins}</b></div><div class="admin-kpi"><span>Sessions actives</span><b>${connected}</b></div><div class="admin-kpi"><span>Événements 24 h</span><b>${adminState.stats.last24h || 0}</b></div></div>
      <div class="admin-layout"><section class="admin-panel"><div class="admin-panel-head"><div><h3>Gestion des utilisateurs</h3><p>Créer, modifier, désactiver ou forcer la déconnexion d’un compte.</p></div></div>
        <form class="admin-create" id="adminCreateUser"><label>Nom / fonction<input name="displayName" required placeholder="Nom du responsable ou fonction"></label><label>E-mail<input name="email" type="email" required placeholder="prenom.nom@delice.tn"></label><label>Rôle<select name="role">${roleOptions}</select></label><label>Entité<select name="entity" required>${entityOptions('CLC')}</select></label><label class="full">Mot de passe initial<input name="password" type="password" minlength="10" required autocomplete="new-password" placeholder="10 caractères minimum"></label><button class="v17-btn primary full" type="submit">Créer le compte</button></form>
        <div class="admin-user-list">${users.map(u => `<article class="admin-user ${u.active ? '' : 'inactive'}" data-admin-user="${escapeHtml(u.id)}"><div class="admin-user-top"><div><b>${escapeHtml(u.displayName || u.email)}</b><small>${escapeHtml(u.email)}${u.id === adminState.currentUserId ? ' • Votre compte' : ''}</small></div><span class="admin-status ${u.active ? 'on' : 'off'}">${u.active ? 'ACTIF' : 'DÉSACTIVÉ'}</span></div><div class="admin-user-grid"><input data-field="displayName" value="${escapeHtml(u.displayName || '')}" aria-label="Nom"><select data-field="role" aria-label="Rôle">${availableRoles.map(r => `<option value="${escapeHtml(r)}"${u.role === r ? ' selected' : ''}>${escapeHtml(ROLE_LABELS[r] || r)}</option>`).join('')}</select><select data-field="entity" aria-label="Entité">${entityOptions(u.entity || 'Groupe')}</select></div>${additionalAccess(u)}<small>Dernière connexion : ${escapeHtml(adminDate(u.lastLoginAt))} • Sessions : ${u.activeSessions || 0}</small><div class="admin-user-actions"><button class="v17-mini" data-admin-action="save">Enregistrer</button><button class="v17-mini" data-admin-action="password">Réinitialiser le mot de passe</button><button class="v17-mini" data-admin-action="sessions" ${u.activeSessions ? '' : 'disabled'}>Déconnecter partout</button><button class="v17-mini" data-admin-action="toggle" ${u.id === adminState.currentUserId ? 'disabled' : ''}>${u.active ? 'Désactiver' : 'Réactiver'}</button></div></article>`).join('') || '<div class="v17-empty">Aucun utilisateur.</div>'}</div></section>
        <section class="admin-panel"><div class="admin-panel-head"><div><h3>Logs de la plateforme</h3><p>${adminState.stats.total || 0} événements tracés • ${adminState.stats.activeUsers24h || 0} utilisateur(s) actif(s) sur 24 h.</p></div></div><div class="admin-filter"><label>Type<select id="adminLogType"><option value="">Tous les événements</option>${eventOptions}</select></label><label>Recherche<input id="adminLogSearch" value="${escapeHtml(adminState.filters.search)}" placeholder="E-mail, section, événement"></label><button class="v17-btn" id="adminApplyLogs">Filtrer</button></div><div class="admin-log-list">${(adminState.logs || []).map(log => `<article class="admin-log ${log.eventType === 'login_failed' ? 'security' : ['user_updated', 'sessions_revoked'].includes(log.eventType) ? 'warn' : ''}"><div class="admin-log-top"><b>${escapeHtml(adminEventLabels[log.eventType] || log.eventType)}</b><small>${escapeHtml(adminDate(log.at))}</small></div><p><b>${escapeHtml(log.actor?.displayName || log.actor?.email || 'Système')}</b> — ${escapeHtml(adminLogDetail(log))}</p></article>`).join('') || '<div class="v17-empty">Aucun événement pour ces filtres.</div>'}</div><div class="admin-pagination"><button class="v17-mini" id="adminPrevLogs" ${adminState.pagination.page <= 1 ? 'disabled' : ''}>Précédent</button><span>Page ${adminState.pagination.page || 1}/${adminState.pagination.pages || 1}</span><button class="v17-mini" id="adminNextLogs" ${adminState.pagination.page >= adminState.pagination.pages ? 'disabled' : ''}>Suivant</button></div></section></div>`;
    bindAdminDashboard();
  }
  async function loadAdminDashboard(page = 1) {
    if (profile?.role !== 'ADMIN') return;
    adminState.loading = true; renderAdminDashboard();
    const query = new URLSearchParams({ page: String(page), limit: '30' });
    if (adminState.filters.eventType) query.set('eventType', adminState.filters.eventType);
    if (adminState.filters.search) query.set('search', adminState.filters.search);
    const [usersResult, logsResult] = await Promise.allSettled([api('/api/admin/users'), api(`/api/admin/logs?${query}`)]);
    const errors = [];
    if (usersResult.status === 'fulfilled') adminState = { ...adminState, ...usersResult.value };
    else errors.push(`Utilisateurs : ${usersResult.reason?.message || 'chargement impossible'}`);
    if (logsResult.status === 'fulfilled') adminState = { ...adminState, logs: logsResult.value.logs || [], pagination: logsResult.value.pagination, stats: logsResult.value.stats };
    else errors.push(`Logs : ${logsResult.reason?.message || 'chargement impossible'}`);
    adminState.loading = false;
    adminState.message = errors.join(' ');
    adminState.messageType = errors.length ? 'error' : '';
    renderAdminDashboard();
  }
  function openAdminDashboard() { if (profile?.role !== 'ADMIN') return; els.panel.classList.remove('show'); els.adminNav?.click(); loadAdminDashboard(1); }
  function bindAdminDashboard() {
    $('adminRefresh')?.addEventListener('click', () => loadAdminDashboard(adminState.pagination.page || 1));
    $('adminCreateUser')?.addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await api('/api/admin/users', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) }); adminState.message = 'Compte créé avec succès.'; adminState.messageType = 'success'; await loadAdminDashboard(1); } catch (error) { adminMessage(error.message, 'error'); } });
    els.adminHost.querySelectorAll('[data-admin-action]').forEach(button => button.addEventListener('click', async () => {
      const card = button.closest('[data-admin-user]'), id = card?.dataset.adminUser, user = adminState.users.find(u => u.id === id); if (!user) return;
      try {
        if (button.dataset.adminAction === 'save') await api('/api/admin/users', { method: 'PATCH', body: JSON.stringify({ id, displayName: card.querySelector('[data-field="displayName"]').value, role: card.querySelector('[data-field="role"]').value, entity: card.querySelector('[data-field="entity"]').value, actionAccess: [...card.querySelectorAll('[data-action-access]:checked')].map(input => input.value) }) });
        if (button.dataset.adminAction === 'password') { const password = prompt(`Nouveau mot de passe pour ${user.email} (10 caractères minimum) :`); if (!password) return; await api('/api/admin/users', { method: 'PATCH', body: JSON.stringify({ id, password }) }); }
        if (button.dataset.adminAction === 'sessions') { if (!confirm(`Déconnecter ${user.email} de tous les appareils ?`)) return; await api('/api/admin/users', { method: 'PATCH', body: JSON.stringify({ id, revokeSessions: true }) }); }
        if (button.dataset.adminAction === 'toggle') { if (!confirm(`${user.active ? 'Désactiver' : 'Réactiver'} le compte ${user.email} ?`)) return; await api('/api/admin/users', { method: 'PATCH', body: JSON.stringify({ id, active: !user.active }) }); }
        adminState.message = 'Modification enregistrée.'; adminState.messageType = 'success'; await loadAdminDashboard(adminState.pagination.page || 1);
      } catch (error) { adminMessage(error.message, 'error'); }
    }));
    $('adminApplyLogs')?.addEventListener('click', () => { adminState.filters = { eventType: $('adminLogType').value, search: $('adminLogSearch').value.trim() }; loadAdminDashboard(1); });
    $('adminLogSearch')?.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('adminApplyLogs').click(); } });
    $('adminPrevLogs')?.addEventListener('click', () => loadAdminDashboard(Math.max(1, adminState.pagination.page - 1)));
    $('adminNextLogs')?.addEventListener('click', () => loadAdminDashboard(Math.min(adminState.pagination.pages, adminState.pagination.page + 1)));
  }

  async function init() {
    if (!app) { showLoginForm(); showError('Le cockpit décisionnel n’est pas initialisé. Actualisez la page.'); setStatus('offline', 'Initialisation incomplète.'); return; }
    els.form.addEventListener('submit', async (event) => {
      event.preventDefault(); hideError(); setStatus('syncing', 'Authentification…');
      try {
        const result = await api('/api/login', { method: 'POST', body: JSON.stringify({ email: els.email.value.trim(), password: els.password.value }) });
        if (result.bootstrapped) flash('Premier administrateur créé avec succès.', 4000);
        await start();
      } catch (error) { showError(error.message); setStatus('offline', 'Authentification requise.'); }
    });
    els.signout.onclick = async () => { await api('/api/login', { method: 'DELETE' }); await stop(); };
    els.sync.onclick = () => syncChangedSections(true); els.manageUsers.onclick = openAdminDashboard; els.fab.onclick = () => els.panel.classList.toggle('show');
    els.adminNav?.addEventListener('click', () => { if (profile?.role === 'ADMIN' && !adminState.users.length) loadAdminDashboard(1); });
    window.addEventListener('online', () => { setStatus('syncing', 'Connexion rétablie — synchronisation…'); pollRemote(); scheduleSync(); });
    window.addEventListener('offline', () => setStatus('offline', 'Hors connexion — les changements restent en local.'));
    try { await restoreSession(); } catch (error) { console.error(error); showLoginForm(); showError(error.message); setStatus('offline', 'Connexion MongoDB indisponible.'); }
    window.CLC_COLLAB = { get status() { return { ready, syncing, user: profile, workspace, lastSync: latestSyncAt }; }, syncNow: () => syncChangedSections(true), openAdmin: openAdminDashboard, signOut: async () => { await api('/api/login', { method: 'DELETE' }); await stop(); } };
  }
  init();
})();
