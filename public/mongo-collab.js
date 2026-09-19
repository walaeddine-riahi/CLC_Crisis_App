(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const els = {
    overlay: $('collabLoginOverlay'), form: $('collabLoginForm'), email: $('collabEmail'), password: $('collabPassword'), error: $('collabLoginError'),
    fab: $('collabFab'), dot: $('collabDot'), fabText: $('collabFabText'), panel: $('collabPanel'), status: $('collabStatusText'),
    user: $('collabUserName'), role: $('collabRole'), entity: $('collabEntity'), workspace: $('collabWorkspace'), last: $('collabLastSync'), users: $('collabUsers'),
    sync: $('collabSyncNow'), manageUsers: $('collabManageUsers'), signout: $('collabSignOut'), banner: $('collabBanner')
  };
  const ROLE_LABELS = { ADMIN: 'Administrateur', GROUP_CRISIS: 'Cellule Groupe', SITE_CLC: 'Cellule CLC', SITE_CF: 'Cellule CF', ACTION_OWNER: 'Responsable d’action', DG: 'Direction Générale', VIEWER: 'Lecture seule' };
  const WRITE_SECTIONS = {
    ADMIN: '*', GROUP_CRISIS: '*',
    SITE_CLC: ['actions', 'simpleChecklists', 'entityDecisions', 'terrainEvidence', 'terrainByZone', 'journal', 'logistics', 'scope', 'emergencyOverride', 'lastTerrainUpdate', 'meteo', 'autoWeather', 'multiWeather'],
    SITE_CF: ['actions', 'simpleChecklists', 'entityDecisions', 'terrainEvidence', 'terrainByZone', 'journal', 'scope', 'emergencyOverride', 'lastTerrainUpdate', 'meteo', 'autoWeather', 'multiWeather'],
    ACTION_OWNER: ['actions', 'journal'], DG: ['deployment', 'entityDecisions', 'journal', 'decisions', 'meta'], VIEWER: []
  };
  let profile = null, workspace = null, ready = false, syncing = false, syncTimer = null, pollTimer = null, presenceTimer = null;
  let lastSynced = {}, versions = {}, basePersist = null, latestSyncAt = null, lastPollAt = null;

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

  async function api(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(data.error || `Erreur HTTP ${response.status}`); error.status = response.status; error.data = data; throw error; }
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
  function updateIdentity() {
    els.user.textContent = profile?.displayName || profile?.email || '—'; els.role.textContent = ROLE_LABELS[profile?.role] || profile?.role || '—';
    els.entity.textContent = profile?.entity || 'Groupe'; els.workspace.textContent = workspace?.name || '—';
    if (els.manageUsers) els.manageUsers.style.display = profile?.role === 'ADMIN' ? '' : 'none';
    els.last.textContent = latestSyncAt ? new Date(latestSyncAt).toLocaleTimeString('fr-FR') : '—';
  }
  function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }
  function renderPresence(rows) {
    if (!rows.length) { els.users.innerHTML = '<div class="collab-muted">Aucun utilisateur détecté.</div>'; return; }
    els.users.innerHTML = rows.map(p => `<div class="collab-user"><span><b>${escapeHtml(p.displayName || p.email || 'Utilisateur')}</b><br><span class="collab-muted">${escapeHtml(ROLE_LABELS[p.role] || p.role || '')} ${p.entity ? '• ' + escapeHtml(p.entity) : ''}</span></span><span>${p.onlineAt ? new Date(p.onlineAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : ''}</span></div>`).join('');
  }
  function applyRows(rows) {
    for (const row of rows) { state[row.sectionKey] = clone(row.payload); versions[row.sectionKey] = Number(row.version || 0); lastSynced[row.sectionKey] = clone(row.payload); }
    state.version = '4.0'; basePersist?.(); renderAll(); latestSyncAt = new Date().toISOString(); updateIdentity();
  }

  async function bootstrap() {
    let data = await api('/api/collab/bootstrap');
    profile = data.user; workspace = data.workspace; updateIdentity();
    if (!data.sections.length) {
      if (!['ADMIN', 'GROUP_CRISIS'].includes(profile.role)) throw new Error('Situation centrale non initialisée. Un administrateur doit se connecter en premier.');
      await api('/api/collab/bootstrap', { method: 'POST', body: JSON.stringify({ initialState: state }) });
      data = await api('/api/collab/bootstrap');
    }
    lastSynced = {}; versions = {}; applyRows(data.sections); lastPollAt = new Date().toISOString();
  }

  async function syncSection(key, localValue) {
    if (!canWrite(key)) { state[key] = clone(lastSynced[key]); basePersist?.(); renderAll(); flash(`Votre rôle ne permet pas de modifier « ${key} ».`); return; }
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const row = await api('/api/collab/section', { method: 'PUT', body: JSON.stringify({ sectionKey: key, payload: localValue, baseVersion: versions[key] || 0 }) });
        state[key] = clone(row.payload); lastSynced[key] = clone(row.payload); versions[key] = Number(row.version); return;
      } catch (error) {
        if (error.status !== 409 || !error.data?.current) throw error;
        const remote = error.data.current;
        localValue = threeWay(lastSynced[key], localValue, remote.payload, [key]);
        lastSynced[key] = clone(remote.payload); versions[key] = Number(remote.version); state[key] = clone(localValue);
      }
    }
    throw new Error(`Conflit persistant sur ${key}.`);
  }
  async function syncChangedSections(force = false) {
    if (!ready || syncing || !navigator.onLine) return;
    const keys = Object.keys(state).filter(k => (force || !eq(state[k], lastSynced[k])) && canWrite(k));
    if (!keys.length) { setStatus('online', 'Synchronisé — aucun changement en attente.'); return; }
    syncing = true; setStatus('syncing', `${keys.length} section(s) en synchronisation…`);
    try {
      for (const key of keys) if (force || !eq(state[key], lastSynced[key])) await syncSection(key, state[key]);
      latestSyncAt = new Date().toISOString(); updateIdentity(); basePersist?.(); setStatus('online', 'Toutes les modifications sont synchronisées.');
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
      for (const row of data.sections) {
        if (Number(row.version) <= Number(versions[row.sectionKey] || 0)) continue;
        const key = row.sectionKey, remote = clone(row.payload), merged = threeWay(lastSynced[key], state[key], remote, [key]);
        lastSynced[key] = clone(remote); versions[key] = Number(row.version); state[key] = clone(merged); changed = true;
        if (!eq(merged, remote)) scheduleSync();
      }
      if (changed) { state.version = '4.0'; basePersist?.(); renderAll(); latestSyncAt = new Date().toISOString(); updateIdentity(); flash('Mise à jour reçue de la situation Groupe.'); }
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
    persist = function () { try { basePersist?.(); } catch (_) { } scheduleSync(); };
    clearInterval(pollTimer); clearInterval(presenceTimer); pollTimer = setInterval(pollRemote, 4000); presenceTimer = setInterval(heartbeat, 15000);
    await heartbeat(); scheduleSync();
  }
  async function stop() {
    ready = false; clearInterval(pollTimer); clearInterval(presenceTimer); els.overlay.classList.remove('hidden'); setStatus('offline', 'Déconnecté.');
  }
  async function restoreSession() {
    const session = await api('/api/auth/session');
    if (session.authenticated) await start(); else els.overlay.classList.remove('hidden');
  }

  async function createUser() {
    const email = prompt('E-mail du nouvel utilisateur :'); if (!email) return;
    const displayName = prompt('Nom et fonction :'); if (!displayName) return;
    const role = prompt('Rôle (ADMIN, GROUP_CRISIS, SITE_CLC, SITE_CF, ACTION_OWNER, DG, VIEWER) :', 'VIEWER'); if (!role) return;
    const entity = prompt('Entité :', 'Groupe') || 'Groupe';
    const password = prompt('Mot de passe initial (10 caractères minimum) :'); if (!password) return;
    try {
      await api('/api/admin/users', { method: 'POST', body: JSON.stringify({ email, displayName, role: role.trim().toUpperCase(), entity, password }) });
      flash(`Compte ${email} créé.`, 3500);
    } catch (error) { flash(error.message, 4000); }
  }

  async function init() {
    basePersist = typeof persist === 'function' ? persist : () => {};
    els.form.addEventListener('submit', async (event) => {
      event.preventDefault(); hideError(); setStatus('syncing', 'Authentification…');
      try {
        const result = await api('/api/auth/session', { method: 'POST', body: JSON.stringify({ email: els.email.value.trim(), password: els.password.value }) });
        if (result.bootstrapped) flash('Premier administrateur créé avec succès.', 4000);
        await start();
      } catch (error) { showError(error.message); setStatus('offline', 'Authentification requise.'); }
    });
    els.signout.onclick = async () => { await api('/api/auth/session', { method: 'DELETE' }); await stop(); };
    els.sync.onclick = () => syncChangedSections(true); els.manageUsers.onclick = createUser; els.fab.onclick = () => els.panel.classList.toggle('show');
    window.addEventListener('online', () => { setStatus('syncing', 'Connexion rétablie — synchronisation…'); pollRemote(); scheduleSync(); });
    window.addEventListener('offline', () => setStatus('offline', 'Hors connexion — les changements restent en local.'));
    try { await restoreSession(); } catch (error) { console.error(error); showError(error.message); els.overlay.classList.remove('hidden'); setStatus('offline', 'Connexion MongoDB indisponible.'); }
    window.CLC_COLLAB = { get status() { return { ready, syncing, user: profile, workspace, lastSync: latestSyncAt }; }, syncNow: () => syncChangedSections(true), signOut: async () => { await api('/api/auth/session', { method: 'DELETE' }); await stop(); } };
  }
  init();
})();
