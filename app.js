// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Full Real Backend API Client
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const CONFIG = {
  API_BASE: '', // Current origin
  ADMIN_TOKEN: 'default_dev_token', // Ensure this matches Railway environment
};

const state = {
  scripts: [], userbots: [], subscriptions: [], admins: [],
  broadcastHistory: [], logEntries: [], securityEvents: [],
  botLocked: false, logsPaused: false
};

// --- Fetch Utility ---
async function apiFetch(path, opts = {}) {
  try {
    const headers = { 'Authorization': 'Bearer ' + CONFIG.ADMIN_TOKEN, ...(opts.headers || {}) };
    if (!(opts.body instanceof FormData) && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${CONFIG.API_BASE}${path}`, { ...opts, headers });
    if (!res.ok) throw new Error((await res.json().catch(()=>({}))).detail || `HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if(!e.message.includes("404")) toast(e.message, 'error');
    return null;
  }
}

// --- Data Synchronization (Polling) ---
async function fetchAllData() {
  const data = await apiFetch('/api/dashboard');
  if (!data) return;
  
  Object.assign(state, {
    scripts: data.scripts, userbots: data.userbots, subscriptions: data.subscriptions,
    admins: data.admins, broadcastHistory: data.broadcasts, logEntries: data.logs,
    securityEvents: data.security, botLocked: data.locked
  });

  renderScripts(); renderFiles(); renderUserbots(); renderSubs(); renderAdmins();
  renderBroadcastHistory(); renderSecurityLog(); renderMainLog();

  // Lock UI Update
  const banner = document.getElementById('lock-banner');
  const lockBtn = document.getElementById('lock-btn');
  if(banner) banner.style.display = state.botLocked ? 'flex' : 'none';
  if(lockBtn) { lockBtn.textContent = state.botLocked ? '🔓 Unlock Bot' : '🔒 Lock Bot'; lockBtn.className = state.botLocked ? 'btn btn-success' : 'btn btn-danger'; }

  // Stats Update
  if(document.getElementById('cpu-bar')) document.getElementById('cpu-bar').style.width = data.stats.cpu + '%';
  if(document.getElementById('cpu-val')) document.getElementById('cpu-val').textContent = Math.round(data.stats.cpu) + '%';
  if(document.getElementById('mem-bar')) document.getElementById('mem-bar').style.width = data.stats.mem + '%';
  if(document.getElementById('mem-val')) document.getElementById('mem-val').textContent = Math.round(data.stats.mem) + '%';
  
  if(document.getElementById('uptime-display')) {
    const s = data.stats.uptime, h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sc = s%60;
    document.getElementById('uptime-display').textContent = [h,m,sc].map(x=>String(x).padStart(2,'0')).join(':');
  }
}

// --- Bot Management (Scripts) ---
window.handleFileSelect = function(input, isMain=false) {
  if (input.files[0]) (isMain ? document.getElementById('upload-zone-sub') : document.getElementById('file-name-display')).textContent = '📄 ' + input.files[0].name;
};
window.handleDrop = function(e) {
  e.preventDefault();
  document.getElementById('main-drop-zone').classList.remove('drag-over');
  if (e.dataTransfer.files[0]) {
    document.getElementById('upload-zone-sub').textContent = '📄 ' + e.dataTransfer.files[0].name;
    document.getElementById('main-file-picker').files = e.dataTransfer.files;
  }
};
window.uploadScript = async function(run = true) {
  const fileInput = document.getElementById('main-file-picker') || document.getElementById('file-picker');
  if (!fileInput.files[0]) return toast('Please select a file', 'error');

  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  
  const cb = document.getElementById('main-auto-install') || document.getElementById('auto-install');
  if(cb) formData.append('auto_install', cb.checked ? "true" : "false");

  const res = await apiFetch('/api/upload', { method: 'POST', body: formData });
  if (res && res.status === 'success') {
    toast(`Uploaded successfully`, 'success');
    closeModal('upload-modal');
    if (run) setTimeout(async () => { await fetchAllData(); const s = state.scripts.find(x=>x.name===fileInput.files[0].name); if(s) startScript(state.scripts.indexOf(s)); }, 500);
    else fetchAllData();
  }
};
window.startScript = async function(i) { await apiFetch(`/api/scripts/${state.scripts[i].id}/start`, { method: 'POST' }); fetchAllData(); toast('Starting...', 'info'); };
window.stopScript = async function(i) { await apiFetch(`/api/scripts/${state.scripts[i].id}/stop`, { method: 'POST' }); fetchAllData(); toast('Stopped', 'warn'); };
window.deleteScript = async function(i) {
  if (state.scripts[i].status === 'running') return toast('Stop first', 'error');
  if (await apiFetch(`/api/scripts/${state.scripts[i].id}`, { method: 'DELETE' })) { toast('Deleted', 'info'); fetchAllData(); }
};
window.runAllScripts = function() { state.scripts.forEach((s, i) => { if (s.status !== 'running') startScript(i); }); };

// --- Userbot Auth Flow ---
const loginFlow = { phone: '', pendingId: null };
window.loginSendCode = async function(resend = false) {
  const p = document.getElementById('login-phone').value.trim() || loginFlow.phone;
  if (p.length < 7) return toast('Invalid phone', 'error');
  loginFlow.phone = p;
  
  const btn = document.getElementById('btn-send-code'); if (btn) { btn.textContent = 'Sending…'; btn.disabled = true; }
  const res = await apiFetch('/api/userbot/login/send_code', { method: 'POST', body: JSON.stringify({ phone: p }) });
  if (btn) { btn.textContent = 'Send Code'; btn.disabled = false; }
  
  if (res) { loginFlow.pendingId = res.pending_id; document.getElementById('login-phone-echo').textContent = p; showLoginStep('code'); document.querySelector('.otp-box').focus(); if(resend) toast('Resent','info'); }
};
window.loginVerifyCode = async function() {
  const c = Array.from(document.querySelectorAll('.otp-box')).map(b => b.value).join('');
  if (c.length < 5) return toast('Enter full code', 'error');
  const res = await apiFetch('/api/userbot/login/verify_code', { method: 'POST', body: JSON.stringify({ pending_id: loginFlow.pendingId, code: c }) });
  if (res && res.status === 'needs_2fa') showLoginStep('2fa'); else if (res) { showLoginStep('done'); fetchAllData(); }
};
window.loginVerify2fa = async function() {
  const p = document.getElementById('login-2fa-pass').value;
  if (!p) return toast('Enter password', 'error');
  const res = await apiFetch('/api/userbot/login/verify_password', { method: 'POST', body: JSON.stringify({ pending_id: loginFlow.pendingId, password: p }) });
  if (res) { showLoginStep('done'); fetchAllData(); }
};
window.logoutUserbot = async function(i) {
  if (confirm(`Log out ${state.userbots[i].phone}?`) && await apiFetch(`/api/userbot/accounts/${state.userbots[i].uid}/${state.userbots[i].slot}`, { method: 'DELETE' })) { toast('Logged out', 'info'); fetchAllData(); }
};
window.startUserbot = async function(i) { toast("Starting userbot...", "info"); if(!state.userbots[i].uid) return; await apiFetch(`/api/userbot/accounts/${state.userbots[i].uid}/${state.userbots[i].slot}/start`, {method: 'POST'}); await fetchAllData(); };
window.stopUserbot = async function(i, restart=false) { toast(`${restart ? "Restarting" : "Stopping"} userbot...`, "warn"); if(!state.userbots[i].uid) return; await apiFetch(`/api/userbot/accounts/${state.userbots[i].uid}/${state.userbots[i].slot}/${restart ? 'restart' : 'stop'}`, {method: 'POST'}); await fetchAllData(); };

// --- Admin Controls ---
window.addSubscription = async function() {
  const uid = parseInt(document.getElementById('sub-uid').value), days = parseInt(document.getElementById('sub-days').value);
  if (!uid || !days) return toast('Invalid', 'error');
  if (await apiFetch('/api/subs', { method: 'POST', body: JSON.stringify({ uid, days }) })) { toast('Sub activated', 'success'); closeModal('sub-modal'); fetchAllData(); }
};
window.extendSub = async function(i) { if (await apiFetch(`/api/subs/${state.subscriptions[i].uid}/extend`, { method: 'POST' })) { toast('Extended +30d', 'success'); fetchAllData(); } };
window.removeSub = async function(i) { if (await apiFetch(`/api/subs/${state.subscriptions[i].uid}`, { method: 'DELETE' })) { toast('Removed', 'info'); fetchAllData(); } };
window.checkSubModal = function() {
  const uid = prompt('Enter User ID to check:'); if (!uid) return;
  const found = state.subscriptions.find(s => String(s.uid) === uid);
  if (found) toast(`User ${uid}: ${found.daysLeft > 0 ? found.daysLeft + ' days left' : 'Expired'}`, found.daysLeft > 0 ? 'success' : 'error');
  else toast(`No subscription found for ${uid}`, 'warn');
};
window.addAdmin = async function() {
  const uid = parseInt(document.getElementById('admin-uid').value);
  if (uid && await apiFetch('/api/admins', { method: 'POST', body: JSON.stringify({ uid }) })) { toast('Admin Added', 'success'); closeModal('admin-modal'); fetchAllData(); }
};
window.removeAdmin = async function(i) { if (await apiFetch(`/api/admins/${state.admins[i].uid}`, { method: 'DELETE' })) { toast('Admin removed', 'info'); fetchAllData(); } };
window.sendBroadcast = async function() {
  const msg = document.getElementById('broadcast-msg').value, target = document.getElementById('broadcast-target').value;
  if (!msg) return toast('Empty message', 'error');
  if (await apiFetch('/api/broadcast', { method: 'POST', body: JSON.stringify({ msg, target }) })) { toast('Broadcast sent', 'success'); document.getElementById('broadcast-msg').value=''; fetchAllData(); }
};
window.toggleBotLock = async function() { if (await apiFetch('/api/lock', { method: 'POST' })) fetchAllData(); };
window.sendCmd = async function() {
  const cmd = document.getElementById('cmd-input').value.trim();
  if (!cmd) return;
  if (await apiFetch('/api/command', { method: 'POST', body: JSON.stringify({ cmd }) })) { document.getElementById('cmd-log').innerHTML += `<div class="log-info">[${ts()}] $ ${cmd}</div>`; document.getElementById('cmd-input').value = ''; }
};
window.quickCmd = function(c) { document.getElementById('cmd-input').value = c; window.sendCmd(); };
window.clearLogs = async function() { if (await apiFetch('/api/logs/clear', { method: 'POST' })) { state.logEntries = []; document.getElementById('main-log').innerHTML = ''; toast('Cleared', 'info'); } };

// --- UI Renderers ---
function ts() { return new Date().toTimeString().slice(0, 8); }
function toast(msg, type = 'info') {
  const ic = { success: '✅', error: '❌', warn: '⚠️', info: '💡' }, col = { success: 'var(--success)', error: 'var(--danger)', warn: 'var(--warn)', info: 'var(--accent2)' };
  const t = document.createElement('div'); t.className = 'toast'; t.style.borderColor = col[type]; t.innerHTML = `<span class="toast-icon">${ic[type]}</span><span>${msg}</span>`;
  document.getElementById('toast-container').appendChild(t); setTimeout(() => t.remove(), 3500);
}

function renderScripts() {
  const l = document.getElementById('script-list'); if (!l) return;
  const running = state.scripts.filter(s => s.status === 'running');
  document.getElementById('nav-running-count').textContent = document.getElementById('stat-running').textContent = running.length;
  document.getElementById('stat-files').textContent = document.getElementById('nav-file-count').textContent = state.scripts.length;
  document.getElementById('running-count-label').textContent = running.length + " active";
  if (!state.scripts.length) { l.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-dim)">No scripts deployed.</div>`; return; }
  l.innerHTML = state.scripts.map((s, i) => `<div class="script-item"><div class="script-status-dot ${s.status === 'running' ? 'dot-running' : 'dot-stopped'}"></div><div class="script-info"><div class="script-name">${s.name}</div><div class="script-meta">${(s.type || 'PY').toUpperCase()} • ID: ${s.id} • ${s.status === 'running' ? 'PID: ' + (s.pid||'sys') : 'Stopped'}</div></div><div class="script-actions">${s.status !== 'running' ? `<button class="btn-icon run" onclick="startScript(${i})">▶</button>` : `<button class="btn-icon stop" onclick="stopScript(${i})">■</button>`}<button class="btn-icon del" onclick="deleteScript(${i})">🗑</button></div></div>`).join('');
}
function renderFiles() {
  const tb = document.getElementById('files-tbody'); if (!tb) return;
  tb.innerHTML = state.scripts.map((s, i) => `<tr><td style="font-family:monospace;font-size:13px">${s.name}</td><td><span class="tag" style="background:rgba(79,172,254,0.12);color:var(--accent2)">${(s.type || 'py').toUpperCase()}</span></td><td style="font-size:12px;color:var(--text-dim)">${s.user || 'Owner'}</td><td><span class="tag ${s.status === 'running' ? 'tag-active' : 'tag-expired'}">${s.status}</span></td><td style="font-family:monospace;font-size:12px">${s.pid || '—'}</td><td><div style="display:flex;gap:6px">${s.status !== 'running' ? `<button class="btn btn-success" style="font-size:11px;padding:5px 10px" onclick="startScript(${i})">▶ Start</button>` : `<button class="btn btn-danger" style="font-size:11px;padding:5px 10px" onclick="stopScript(${i})">■ Stop</button>`}<button class="btn btn-secondary" style="font-size:11px;padding:5px 10px" onclick="deleteScript(${i})">🗑</button></div></td></tr>`).join('');
}
function renderUserbots() {
  const l = document.getElementById('userbot-list'); if (!l) return;
  document.getElementById('nav-userbot-count').textContent = document.getElementById('ub-stat-total').textContent = state.userbots.length;
  document.getElementById('ub-stat-running').textContent = state.userbots.filter(u => u.status === 'running').length;
  document.getElementById('ub-stat-cmds').textContent = state.userbots.reduce((a,u) => a+(u.cmds||0), 0);
  if (!state.userbots.length) { l.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-dim)">No active accounts.</div>`; return; }
  l.innerHTML = state.userbots.map((u, i) => `<div class="userbot-card"><div class="userbot-avatar">${(u.name||'U')[0].toUpperCase()}</div><div class="userbot-info"><div class="userbot-phone">${u.phone}</div><div class="userbot-meta"><span class="script-status-dot ${u.status==='running'?'dot-running':'dot-stopped'}" style="display:inline-block;width:7px;height:7px;margin-right:5px"></span>${u.status === 'running' ? 'Online' : 'Stopped'} • ${u.cmds||0} commands</div></div><div class="userbot-actions">${u.status !== 'running' ? `<button class="btn-icon run" onclick="startUserbot(${i})">▶</button>` : `<button class="btn-icon stop" onclick="stopUserbot(${i},true)">↻</button><button class="btn-icon stop" onclick="stopUserbot(${i})">■</button>`}<button class="btn-icon del" onclick="logoutUserbot(${i})">🗑</button></div></div>`).join('');
}
function renderSubs() {
  const tb = document.getElementById('sub-tbody'); if (!tb) return;
  document.getElementById('stat-subs').textContent = state.subscriptions.length;
  tb.innerHTML = state.subscriptions.map((s,i) => `<tr><td style="font-family:monospace;font-size:13px">${s.uid}</td><td><span class="tag tag-active" style="${s.daysLeft<=0?'background:rgba(255,77,109,0.12);color:var(--danger);border-color:rgba(255,77,109,0.25)':''}">${s.plan}</span></td><td style="font-size:12px">${s.expiry}</td><td style="font-size:13px;font-weight:600;color:${s.daysLeft<=0?'var(--danger)':s.daysLeft<=7?'var(--warn)':'var(--success)'}">${s.daysLeft>0?s.daysLeft+' days':'Expired'}</td><td><span class="tag ${s.daysLeft>0?'tag-active':'tag-expired'}">${s.daysLeft>0?'Active':'Expired'}</span></td><td><div style="display:flex;gap:6px"><button class="btn btn-secondary" style="font-size:11px;padding:5px 10px" onclick="extendSub(${i})">+30d</button><button class="btn btn-danger" style="font-size:11px;padding:5px 10px" onclick="removeSub(${i})">Remove</button></div></td></tr>`).join('');
}
function renderAdmins() {
  const tb = document.getElementById('admin-tbody'); if (!tb) return;
  tb.innerHTML = state.admins.map((a,i) => `<tr><td style="font-family:monospace;font-size:13px">${a.uid}</td><td>${a.username}</td><td><span class="tag ${a.role==='owner'?'tag-owner':'tag-admin'}">${a.role==='owner'?'👑 Owner':'🛡️ Admin'}</span></td><td style="font-size:12px;color:var(--text-dim)">${a.since}</td><td>${a.role!=='owner'?`<button class="btn btn-danger" style="font-size:11px;padding:5px 10px" onclick="removeAdmin(${i})">Remove</button>`:'<span style="font-size:12px;color:var(--text-muted)">Owner</span>'}</td></tr>`).join('');
}
function renderBroadcastHistory() {
  const el = document.getElementById('broadcast-history'); if (!el) return;
  if (!state.broadcastHistory.length) { el.innerHTML = '<div style="font-size:13px;color:var(--text-dim);text-align:center;padding:20px">No broadcasts yet</div>'; return; }
  el.innerHTML = state.broadcastHistory.map(b => `<div class="script-item" style="flex-direction:column;align-items:flex-start"><div style="font-size:12px;color:var(--text-dim);margin-bottom:4px">${b.time} • ${b.target} (${b.count} users)</div><div style="font-size:13px;word-break:break-word">${b.msg}</div></div>`).join('');
}
function renderSecurityLog() {
  const el = document.getElementById('security-log'); if (!el) return;
  const cls = { error:'log-error', success:'log-success', warn:'log-warn', info:'log-info' };
  el.innerHTML = state.securityEvents.map(e => `<div class="${cls[e.level] || 'log-info'}">[${e.time}] [${e.t}] ${e.msg}</div>`).join('');
  el.scrollTop = el.scrollHeight;
}
function renderMainLog() {
  if (state.logsPaused) return;
  const els = [document.getElementById('main-log'), document.getElementById('activity-log')];
  els.forEach(el => {
    if (!el) return;
    el.innerHTML = state.logEntries.map(e => `<div class="${e.cls || 'log-info'}">[${e.time}] ${e.msg}</div>`).join('');
    el.scrollTop = el.scrollHeight;
  });
}
window.pauseLogs = function() { state.logsPaused = !state.logsPaused; document.getElementById('pause-btn').textContent = state.logsPaused ? '▶ Resume' : '⏸ Pause'; document.getElementById('live-indicator').textContent = state.logsPaused ? '⏸ PAUSED' : '● LIVE'; };
window.filterLog = function(type) {
  const el = document.getElementById('main-log');
  if (!el) return;
  const filtered = type === 'all' ? state.logEntries : state.logEntries.filter(e => e.level === type);
  el.innerHTML = filtered.map(e => `<div class="${e.cls}">[${e.time}] ${e.msg}</div>`).join('');
};

// --- App Control ---
window.showApp = function() { document.getElementById('site-view').style.display = 'none'; document.getElementById('app-view').style.display = 'block'; };
window.showSite = function() { document.getElementById('app-view').style.display = 'none'; document.getElementById('site-view').style.display = 'block'; };
window.openModal = function(id) { document.getElementById(id).classList.add('open'); };
window.closeModal = function(id) { document.getElementById(id).classList.remove('open'); };
window.nav = function(page, el) { document.querySelectorAll('.page').forEach(p => p.classList.remove('active')); document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active')); document.getElementById('page-' + page).classList.add('active'); if (el) el.classList.add('active'); };
window.showLoginStep = function(step) {
  ['phone','code','2fa','done'].forEach(s => document.getElementById('login-' + s + '-step').style.display = (s === step) ? 'block' : 'none');
  const stepIdx = { phone: 1, code: 2, '2fa': 3, done: 3 }[step];
  [1,2,3].forEach(n => { const e = document.getElementById('lstep-' + n); if(e) { e.classList.toggle('active', n === stepIdx); e.classList.toggle('done', n < stepIdx); } });
};
window.resetLoginFlow = function() { loginFlow.phone = ''; loginFlow.pendingId = null; document.getElementById('login-phone').value = ''; document.querySelectorAll('.otp-box').forEach(b => { b.value = ''; b.classList.remove('filled') }); showLoginStep('phone'); };

function init() {
  fetchAllData();
  setInterval(fetchAllData, 3000); 
  
  const boxes = Array.from(document.querySelectorAll('.otp-box'));
  boxes.forEach((box, idx) => {
    box.addEventListener('input', () => { box.value = box.value.replace(/[^0-9]/g,'').slice(0,1); box.classList.toggle('filled', !!box.value); if (box.value && boxes[idx+1]) boxes[idx+1].focus(); });
    box.addEventListener('keydown', (e) => { if (e.key === 'Backspace' && !box.value && boxes[idx-1]) boxes[idx-1].focus(); });
    box.addEventListener('paste', (e) => {
      const txt = (e.clipboardData.getData('text') || '').replace(/[^0-9]/g,''); if (txt.length > 1) {
        e.preventDefault(); txt.split('').slice(0,boxes.length).forEach((ch,i) => { boxes[i].value = ch; boxes[i].classList.add('filled'); }); boxes[Math.min(txt.length,boxes.length)-1].focus();
      }
    });
  });

  if (location.hash === '#dashboard') showApp(); else showSite();
}
document.addEventListener('DOMContentLoaded', init);
document.querySelectorAll('.modal-overlay').forEach(ov => { ov.addEventListener('click', e => { if (e.target === ov) ov.classList.remove('open'); }); });
