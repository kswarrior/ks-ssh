'use strict';

const API = '';
const terminals = new Map();
let activeTermId = null;
let currentFilePath = null;
let tunnelData = null;
let selectMode = false;
let pendingRename = null;
let pendingDelete = null;
let pendingEditor = null;
let activeDropdown = null;
let socket = null;
let termCounter = 0;
let ctrlActive = false;
let altActive  = false;

const SESS_KEY     = 'ks-ssh-terms';
const LOG_MAX      = 524288;  // 512 KB client-side log cap
const LOG_TRIM     = 262144;  // trim to 256 KB

function saveSessions() {
  try {
    const arr = [...terminals.entries()].map(([id, t]) => ({ id, num: t.num }));
    sessionStorage.setItem(SESS_KEY, JSON.stringify(arr));
  } catch {}
}

function loadSessions() {
  try { return JSON.parse(sessionStorage.getItem(SESS_KEY) || '[]'); } catch { return []; }
}

const $ = (id) => document.getElementById(id);
const qs = (sel, ctx = document) => ctx.querySelector(sel);

// ===== BOOT =====
window.addEventListener('load', () => {
  connectSocket();
  setupSidebar();
  setupTabs();
  setupInfoPanel();
  setupSettings();
  setupCustomBtns();
  setupModals();
  setupContextMenu();
  setupResourceMonitor();
  setupPortPreview();
  loadSystemInfo();
  setInterval(loadSystemInfo, 20000);
  startPing();
  startResourcePolling();

  $('empty-new-term').onclick = () => createTerminal();

  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    if (activeDropdown && !e.target.closest('.file-menu-wrap')) closeDropdown();
  });
});

// ===== INPUT BATCHING (high-ping optimisation) =====
let _inputQueue = '';
let _inputTimer = null;
const INPUT_BATCH_MS = 10; // flush regular chars every 10ms

function flushInputQueue(id) {
  if (!_inputQueue || !id) return;
  socket.emit('terminal:input', { id, data: _inputQueue });
  _inputQueue = '';
  _inputTimer = null;
}

function sendBatchedInput(id, data) {
  // Control chars / escape sequences → send immediately (timing-sensitive)
  if (data.length > 1 || data.charCodeAt(0) < 32) {
    if (_inputTimer) { clearTimeout(_inputTimer); flushInputQueue(id); }
    socket.emit('terminal:input', { id, data });
    return;
  }
  // Printable chars: queue and flush after batch window
  _inputQueue += data;
  if (_inputTimer) clearTimeout(_inputTimer);
  _inputTimer = setTimeout(() => flushInputQueue(id), INPUT_BATCH_MS);
}

// ===== SOCKET =====
function connectSocket() {
  socket = io({
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity,
    timeout: 30000,
    transports: ['websocket', 'polling'],
  });

  // Reconnect when tab/app regains focus (critical for mobile)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && socket && !socket.connected) {
      socket.connect();
    }
  });

  socket.on('disconnect', () => setConnStatus(false));

  socket.on('terminal:data', ({ id, data }) => {
    const t = terminals.get(id);
    if (!t) return;
    t.xterm.write(data);
    t.log += data;
    if (t.log.length > LOG_MAX) t.log = t.log.slice(-LOG_TRIM);
  });

  socket.on('terminal:exit', ({ id }) => {
    const t = terminals.get(id);
    if (t) t.xterm.writeln('\r\n\x1b[33m[Process exited]\x1b[0m');
  });

  socket.on('terminal:error', ({ error }) => showToast('Terminal error: ' + error, 'error'));

  // Session restore: server replays buffered output
  socket.on('terminal:replay', ({ id, buffer }) => {
    const t = terminals.get(id);
    if (!t || !buffer) return;
    t.xterm.write(buffer);
    t.log = buffer;
    showToast(`Terminal ${t.num} restored`, 'success');
  });

  // Session restore failed → start fresh shell in existing UI
  socket.on('terminal:reconnect:fail', ({ id }) => {
    const t = terminals.get(id);
    if (!t) return;
    t.xterm.writeln('\r\n\x1b[33m[Session expired — starting new shell]\x1b[0m\r\n');
    socket.emit('terminal:create', { id, cols: t.xterm.cols, rows: t.xterm.rows });
    showToast(`Terminal ${t.num}: new session started`, 'info');
  });

  socket.on('tunnel:url', (data) => { tunnelData = data; updateInfoPanel(); });

  socket.on('connect', async () => {
    setConnStatus(true);
    try {
      const r = await fetch(`${API}/ksapi/tunnel`);
      const d = await r.json();
      if (d.active) { tunnelData = d; updateInfoPanel(); }
    } catch {}

    // Attempt to restore previously open terminals
    const saved = loadSessions();
    if (saved.length > 0) {
      for (const { id, num } of saved) {
        if (!terminals.has(id)) {
          // Rebuild the terminal UI then ask server if PTY still alive
          restoreTerminal(id, num);
        } else {
          // UI already exists (e.g. hot-reload), just reconnect
          const t = terminals.get(id);
          socket.emit('terminal:reconnect', { id, cols: t.xterm.cols, rows: t.xterm.rows });
        }
      }
    }
  });
}

function setConnStatus(connected) {
  // conn-status element removed; no-op kept for socket event compatibility
}

// ===== PING =====
const PING_LEVELS = {
  ok:   { color: '#10b981', layers: [1, 1, 1] },
  warn: { color: '#f59e0b', layers: [1, 1, 0.15] },
  bad:  { color: '#ef4444', layers: [1, 0.15, 0.15] },
  off:  { color: '#4a5568', layers: [0.15, 0.15, 0.15] },
};

function setPingSignal(level) {
  const cfg = PING_LEVELS[level];
  const icon = $('pingIcon');
  if (!icon) return;
  icon.style.color = cfg.color;
  $('pingLayer1').setAttribute('opacity', cfg.layers[0]);
  $('pingLayer2').setAttribute('opacity', cfg.layers[1]);
  $('pingLayer3').setAttribute('opacity', cfg.layers[2]);
  $('pingDot').setAttribute('opacity', cfg.layers[0]);
}

function startPing() {
  const measure = async () => {
    const t0 = Date.now();
    try {
      await fetch(`${API}/ksapi/ping`);
      const ms = Date.now() - t0;
      const el = $('ping-display');
      el.textContent = ms + 'ms';
      const level = ms < 100 ? 'ok' : ms < 300 ? 'warn' : 'bad';
      el.className = level;
      setPingSignal(level);
    } catch {
      $('ping-display').textContent = '--';
      $('ping-display').className = 'bad';
      setPingSignal('off');
    }
  };
  measure();
  setInterval(measure, 5000);
}

// ===== RESOURCE MONITOR =====
function setupResourceMonitor() {
  const btn = $('res-mon-btn');
  const dropdown = $('res-dropdown');
  let open = false;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    open = !open;
    if (open) {
      dropdown.classList.remove('hidden');
      btn.classList.add('active');
      fetchResources();
    } else {
      dropdown.classList.add('hidden');
      btn.classList.remove('active');
    }
  });

  document.addEventListener('click', (e) => {
    if (open && !$('res-mon-wrap').contains(e.target)) {
      open = false;
      dropdown.classList.add('hidden');
      btn.classList.remove('active');
    }
  });
}

function resBarColor(pct) {
  if (pct > 90) return '#ef4444';
  if (pct > 70) return '#f59e0b';
  return null; // use default gradient color per metric
}

function updateResIcon(ram, cpu, disk) {
  const maxH = 17, baseY = 21;
  const set = (id, pct) => {
    const el = $(id);
    if (!el) return;
    const h = (pct / 100) * maxH;
    el.setAttribute('height', h.toFixed(1));
    el.setAttribute('y', (baseY - h).toFixed(1));
  };
  set('rm-ram-fill', ram);
  set('rm-cpu-fill', cpu);
  set('rm-disk-fill', disk);
}

async function fetchResources() {
  try {
    const r = await fetch(`${API}/ksapi/resources`);
    const d = await r.json();
    if (d.error) return;

    $('rm-ram-label').textContent = `${d.ram.used.toFixed(1)} / ${d.ram.total.toFixed(1)} GB (${Math.round(d.ram.percent)}%)`;
    $('rm-cpu-label').textContent = `${Math.round(d.cpu.percent)}%`;
    $('rm-disk-label').textContent = `${d.disk.used.toFixed(1)} / ${d.disk.total.toFixed(1)} GB (${Math.round(d.disk.percent)}%)`;

    const setBar = (barId, pct, defaultColor) => {
      const el = $(barId); if (!el) return;
      el.style.width = Math.min(pct, 100) + '%';
      el.style.background = resBarColor(pct) || defaultColor;
    };
    setBar('rm-ram-bar', d.ram.percent, '#22c55e');
    setBar('rm-cpu-bar', d.cpu.percent, '#3b82f6');
    setBar('rm-disk-bar', d.disk.percent, '#a855f7');

    // CPU model name
    if (d.cpu.model) {
      const modelEl = $('rm-cpu-model');
      if (modelEl) modelEl.textContent = d.cpu.model;
    }

    // Per-core usage bars
    if (d.cpu.cores && d.cpu.cores.length > 0) {
      const container = $('rm-cores-container');
      if (container) {
        // Build or update core items
        if (container.children.length !== d.cpu.cores.length) {
          container.innerHTML = '';
          d.cpu.cores.forEach((_, i) => {
            const item = document.createElement('div');
            item.className = 'rm-core-item';
            item.innerHTML = `<span class="rm-core-label">C${i}</span><div class="rm-core-track"><div class="rm-core-fill" id="rm-core-fill-${i}"></div></div><span class="rm-core-pct" id="rm-core-pct-${i}">0%</span>`;
            container.appendChild(item);
          });
        }
        d.cpu.cores.forEach((pct, i) => {
          const fill = $(`rm-core-fill-${i}`);
          const label = $(`rm-core-pct-${i}`);
          if (fill) fill.style.height = Math.min(pct, 100) + '%';
          if (label) label.textContent = Math.round(pct) + '%';
        });
      }
    }

    // Network I/O
    if (d.network) {
      const fmtBytes = (b) => b > 1073741824 ? (b/1073741824).toFixed(1)+'GB' : b > 1048576 ? (b/1048576).toFixed(1)+'MB' : b > 1024 ? (b/1024).toFixed(1)+'KB' : b+'B';
      const netIn = $('rm-net-in'), netOut = $('rm-net-out'), netLabel = $('rm-net-label');
      if (netIn) netIn.textContent = fmtBytes(d.network.in);
      if (netOut) netOut.textContent = fmtBytes(d.network.out);
      if (netLabel) netLabel.textContent = fmtBytes(d.network.in + d.network.out);
    }

    // Temperature
    if (d.temp !== null && d.temp !== undefined) {
      const tempSec = $('rm-temp-section');
      if (tempSec) tempSec.classList.remove('hidden');
      const tempLabel = $('rm-temp-label');
      if (tempLabel) tempLabel.textContent = d.temp.toFixed(1) + '°C';
      setBar('rm-temp-bar', (d.temp / 100) * 100, '#f97316');
    }

    updateResIcon(d.ram.percent, d.cpu.percent, d.disk.percent);
  } catch {}
}

function startResourcePolling() {
  fetchResources();
  setInterval(fetchResources, 4000);
}

// ===== INFO PANEL =====
function setupInfoPanel() {
  $('info-btn').onclick = () => {
    const panel = $('info-panel');
    const overlay = $('info-overlay');
    const isOpen = !panel.classList.contains('hidden');
    if (isOpen) { panel.classList.add('hidden'); overlay.classList.add('hidden'); $('info-btn').classList.remove('active'); }
    else { panel.classList.remove('hidden'); overlay.classList.remove('hidden'); $('info-btn').classList.add('active'); updateInfoPanel(); }
  };
  $('info-overlay').onclick = closeInfoPanel;
  $('info-panel-close').onclick = closeInfoPanel;
}

function closeInfoPanel() {
  $('info-panel').classList.add('hidden');
  $('info-overlay').classList.add('hidden');
  $('info-btn').classList.remove('active');
}

function updateInfoPanel() {
  const body = $('info-panel-body');
  if (!tunnelData || !tunnelData.url) {
    body.innerHTML = `<div class="info-no-tunnel">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="36" height="36" style="color:var(--text-muted)"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      <p>Tunnel not yet connected…</p>
    </div>`;
    return;
  }
  const { url, shareUrl, subdomain } = tunnelData;
  const token = subdomain || url.replace('https://', '').replace('.trycloudflare.com', '');
  body.innerHTML = `
    <div class="info-field">
      <div class="info-label">Token</div>
      <div class="info-val-row">
        <span class="info-val">${token}</span>
        <button class="info-copy-btn" onclick="copyText('${token}', this)" title="Copy token">Copy</button>
      </div>
    </div>
    <div class="info-field">
      <div class="info-label">Share URL</div>
      <div class="info-val-row">
        <a class="info-link" href="${shareUrl}" target="_blank" rel="noopener">${shareUrl}</a>
        <button class="info-copy-btn" onclick="copyText('${shareUrl}', this)" title="Copy">Copy</button>
      </div>
      <button class="info-open-btn" onclick="window.open('${shareUrl}','_blank')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        Open Share Page
      </button>
    </div>
    `;
}

window.copyText = async (text, btn) => {
  try { await navigator.clipboard.writeText(text); const orig = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => (btn.textContent = orig), 1500); }
  catch { showToast('Copy failed', 'error'); }
};

// ===== SIDEBAR =====
function setupSidebar() {
  const sidebar = $('sidebar');
  let collapsed = window.innerWidth < 768;
  if (collapsed) sidebar.classList.add('collapsed');
  $('sidebar-toggle').addEventListener('click', () => {
    collapsed = !collapsed;
    sidebar.classList.toggle('collapsed', collapsed);
    setTimeout(() => refitActiveTerminal(), 220);
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth < 768 && !collapsed) { collapsed = true; sidebar.classList.add('collapsed'); }
  });
}

function refitActiveTerminal() {
  if (!activeTermId) return;
  const t = terminals.get(activeTermId);
  if (t) { try { t.fitAddon.fit(); socket.emit('terminal:resize', { id: activeTermId, cols: t.xterm.cols, rows: t.xterm.rows }); } catch {} }
}

// ===== TABS =====
function setupTabs() {
  document.querySelectorAll('.sidebar-nav-item[data-tab], .bnav-item[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  $('files-refresh-btn').onclick = () => loadFiles(currentFilePath);
  $('ports-refresh-btn').onclick = loadPorts;
  $('file-upload-btn').onclick = () => $('file-upload-input').click();
  $('file-upload-input').onchange = handleFileUpload;
  $('mkdir-btn').onclick = handleMkdir;
  $('url-upload-btn').onclick = () => $('url-upload-modal').classList.remove('hidden');
  $('select-toggle-btn').onclick = toggleSelectMode;
  $('bulk-cancel').onclick = () => { exitSelectMode(); };
  $('bulk-select-all').onclick = () => {
    const checks = $('files-list').querySelectorAll('.file-check');
    const allChecked = [...checks].every(c => c.checked);
    checks.forEach(c => { c.checked = !allChecked; c.closest('.file-item-row').classList.toggle('selected', !allChecked); });
    updateBulkBar();
  };
  $('bulk-delete').onclick = bulkDelete;
  $('bulk-zip').onclick = bulkZip;
}

function switchTab(tab) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.sidebar-nav-item').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.bnav-item[data-tab]').forEach(b => b.classList.remove('active'));
  $('tab-' + tab).classList.remove('hidden');
  qs(`.sidebar-nav-item[data-tab="${tab}"]`)?.classList.add('active');
  qs(`.bnav-item[data-tab="${tab}"]`)?.classList.add('active');
  if (tab === 'files') loadFiles(currentFilePath || '/');
  else if (tab === 'ports') loadPorts();
  else if (tab === 'terminals') setTimeout(refitActiveTerminal, 30);
}

// ===== SYSTEM INFO =====
async function loadSystemInfo() {
  try {
    const res = await fetch(`${API}/ksapi/system`);
    const d = await res.json();
    $('sys-host').textContent = d.hostname;
    $('sys-mem').textContent = Math.round(d.memory.used / d.memory.total * 100) + '% RAM';
    $('sp-host').textContent = d.hostname;
    $('sp-os').textContent = `${d.platform}/${d.arch}`;
    $('sp-user').textContent = d.user;
    $('sp-cpus').textContent = d.cpus;
    $('sp-mem-detail').textContent = `${fmt(d.memory.used)} / ${fmt(d.memory.total)}`;
    $('sp-uptime').textContent = fmtUptime(d.uptime);
    $('sp-load').textContent = d.loadAvg.map(l => l.toFixed(2)).join(' ');
    if (!currentFilePath) currentFilePath = d.home;
  } catch {}
}

// ===== TERMINALS =====
const TERM_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;

// Internal helper — creates the xterm+tab+container for a terminal id/num.
// If restore=true it emits terminal:reconnect instead of terminal:create.
function _spawnTerminal({ id, num, restore = false }) {
  const { tabBar, body } = getOrCreateTerminalLayout();

  const tab = document.createElement('div');
  tab.className = 'term-tab';
  tab.dataset.termId = id;
  tab.innerHTML = `
    <span class="term-tab-icon">${TERM_SVG}</span>
    <span class="term-tab-num">${num}</span>
    <button class="term-tab-close" title="Close">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="10" height="10"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>`;
  tab.addEventListener('click', (e) => { if (!e.target.closest('.term-tab-close')) activateTerminal(id); });
  tab.querySelector('.term-tab-close').addEventListener('click', (e) => { e.stopPropagation(); openTermCloseConfirm(id); });
  tabBar.insertBefore(tab, tabBar.querySelector('.new-tab-btn'));

  const container = document.createElement('div');
  container.className = 'terminal-container';
  container.id = 'tc-' + id;
  body.appendChild(container);

  const xterm = new Terminal(getTerminalOptions(loadSettings()));
  const fitAddon = new FitAddon.FitAddon();
  xterm.loadAddon(fitAddon);
  xterm.open(container);

  // Mobile: copy on text selection end
  xterm.onSelectionChange(() => {
    const sel = xterm.getSelection();
    if (sel && sel.length > 0) {
      navigator.clipboard.writeText(sel).catch(() => {});
    }
  });

  xterm.onData(data => {
    let out = data;
    if (ctrlActive && data.length === 1) {
      out = String.fromCharCode(data.charCodeAt(0) & 0x1f);
      ctrlActive = false;
      updateKbdModifiers();
    } else if (altActive && data.length === 1) {
      out = '\x1b' + data;
      altActive = false;
      updateKbdModifiers();
    }
    sendBatchedInput(id, out);
  });

  // Long-press → context menu (touch devices)
  let pressTimer = null, pressX = 0, pressY = 0;
  container.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    pressX = e.clientX; pressY = e.clientY;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      showTermCtxMenu(pressX, pressY, id);
    }, 600);
  });
  const cancelPress = (e) => {
    if (!pressTimer) return;
    if (e.type === 'pointermove' && Math.abs(e.clientX - pressX) < 10 && Math.abs(e.clientY - pressY) < 10) return;
    clearTimeout(pressTimer); pressTimer = null;
  };
  container.addEventListener('pointermove', cancelPress);
  container.addEventListener('pointerup',   cancelPress);
  container.addEventListener('pointercancel', cancelPress);

  const entry = { xterm, fitAddon, num, tab, container, log: '' };
  terminals.set(id, entry);
  $('terminals-empty').style.display = 'none';

  setTimeout(() => {
    try {
      fitAddon.fit();
      if (restore) {
        socket.emit('terminal:reconnect', { id, cols: xterm.cols, rows: xterm.rows });
      } else {
        socket.emit('terminal:create', { id, cols: xterm.cols, rows: xterm.rows });
      }
    } catch {}
  }, 60);

  activateTerminal(id);
  saveSessions();
  return id;
}

function createTerminal() {
  termCounter++;
  return _spawnTerminal({ id: 'term-' + Date.now(), num: termCounter, restore: false });
}

function restoreTerminal(id, num) {
  if (num > termCounter) termCounter = num;
  return _spawnTerminal({ id, num, restore: true });
}

function getOrCreateTerminalLayout() {
  let wrapper = qs('.terminal-wrapper', $('terminals-area'));
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.className = 'terminal-wrapper active';

    const tabBar = document.createElement('div');
    tabBar.className = 'terminal-tab-bar';

    const newBtn = document.createElement('button');
    newBtn.className = 'new-tab-btn';
    newBtn.title = 'New terminal';
    newBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="13" height="13"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
    newBtn.onclick = createTerminal;
    tabBar.appendChild(newBtn);

    const dlBtn = document.createElement('button');
    dlBtn.className = 'new-tab-btn term-dl-btn';
    dlBtn.title = 'Download terminal log';
    dlBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
    dlBtn.onclick = () => downloadTerminalLog(activeTermId);
    tabBar.appendChild(dlBtn);

    const body = document.createElement('div');
    body.className = 'terminal-body';

    const ro = new ResizeObserver(() => refitActiveTerminal());
    ro.observe(body);

    const kbdBar = buildKeyboardBar();

    wrapper.appendChild(tabBar);
    wrapper.appendChild(kbdBar);
    wrapper.appendChild(body);
    // Insert wrapper BEFORE the custom buttons bar so it stays at the bottom
    const customBar = $('custom-btns-bar');
    if (customBar) $('terminals-area').insertBefore(wrapper, customBar);
    else $('terminals-area').appendChild(wrapper);
  }
  return { tabBar: qs('.terminal-tab-bar', wrapper), body: qs('.terminal-body', wrapper) };
}

function activateTerminal(id) {
  activeTermId = id;
  document.querySelectorAll('.term-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.terminal-container').forEach(c => c.classList.remove('active'));
  const t = terminals.get(id);
  if (!t) return;
  t.tab.classList.add('active');
  t.container.classList.add('active');
  setTimeout(() => {
    try { t.fitAddon.fit(); socket.emit('terminal:resize', { id, cols: t.xterm.cols, rows: t.xterm.rows }); t.xterm.focus(); } catch {}
  }, 20);
}

let pendingTermClose = null;

function openTermCloseConfirm(id) {
  pendingTermClose = id;
  $('term-close-input').value = '';
  $('term-close-confirm').disabled = true;
  $('term-close-input').classList.remove('valid');
  $('term-close-modal').classList.remove('hidden');
  setTimeout(() => $('term-close-input').focus(), 80);
}

function closeTerminal(id) {
  const t = terminals.get(id);
  if (!t) return;
  socket.emit('terminal:kill', { id });
  t.xterm.dispose();
  t.tab.remove();
  t.container.remove();
  terminals.delete(id);
  saveSessions();
  if (activeTermId === id) {
    const remaining = [...terminals.keys()];
    if (remaining.length) activateTerminal(remaining[remaining.length - 1]);
    else { activeTermId = null; $('terminals-empty').style.display = ''; qs('.terminal-wrapper', $('terminals-area'))?.remove(); }
  }
}

// ===== TERMINAL LOG DOWNLOAD =====
function downloadTerminalLog(id) {
  const t = terminals.get(id);
  if (!t || !t.log) return showToast('No log data yet', 'info');
  const clean = t.log.replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, '');
  const blob = new Blob([clean], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `terminal-${t.num}-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.log`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ===== CONTEXT MENU =====
function showTermCtxMenu(x, y, id) {
  const menu = $('term-ctx-menu');
  menu.dataset.termId = id;
  menu.classList.remove('hidden');
  const mw = 176, mh = 180;
  const left = Math.min(x, window.innerWidth  - mw - 8);
  const top  = Math.min(y, window.innerHeight - mh - 8);
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.top  = Math.max(8, top)  + 'px';
}
function hideTermCtxMenu() { $('term-ctx-menu').classList.add('hidden'); }

function setupContextMenu() {
  $('ctx-copy').onclick = () => {
    const t = terminals.get($('term-ctx-menu').dataset.termId);
    if (t) { const s = t.xterm.getSelection(); if (s) navigator.clipboard.writeText(s).catch(() => {}); }
    hideTermCtxMenu();
  };
  $('ctx-paste').onclick = async () => {
    const id = $('term-ctx-menu').dataset.termId;
    hideTermCtxMenu();
    try { const txt = await navigator.clipboard.readText(); if (txt && id) socket.emit('terminal:input', { id, data: txt }); } catch {}
  };
  $('ctx-selectall').onclick = () => {
    const t = terminals.get($('term-ctx-menu').dataset.termId);
    if (t) t.xterm.selectAll();
    hideTermCtxMenu();
  };
  $('ctx-download').onclick = () => {
    downloadTerminalLog($('term-ctx-menu').dataset.termId);
    hideTermCtxMenu();
  };
  document.addEventListener('pointerdown', (e) => {
    if (!$('term-ctx-menu').classList.contains('hidden') && !e.target.closest('#term-ctx-menu'))
      hideTermCtxMenu();
  }, true);
}

// ===== SETTINGS =====
const SETTINGS_KEY = 'ks-ssh-settings';
const DEFAULT_SETTINGS = {
  termFontSize: 13,
  termFontFamily: '"JetBrains Mono","Fira Code",Consolas,monospace',
  termBg: '#000000',
  termFg: '#e2e8f0',
  termCursor: 'block',
  termBlink: true,
  termScrollback: 5000,
  portFontSize: 13,
  portFontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
  filesFontSize: 13,
  filesFontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
  kbdHeight: 46,
};

function loadSettings() {
  try { return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch { return { ...DEFAULT_SETTINGS }; }
}

function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
}

function applySettings(s) {
  // Apply to all open terminals
  terminals.forEach(t => {
    try {
      t.xterm.options.fontSize      = s.termFontSize;
      t.xterm.options.fontFamily    = s.termFontFamily;
      t.xterm.options.cursorStyle   = s.termCursor;
      t.xterm.options.cursorBlink   = s.termBlink;
      t.xterm.options.scrollback    = s.termScrollback;
      t.xterm.options.theme = Object.assign({}, t.xterm.options.theme, { background: s.termBg, foreground: s.termFg });
      t.fitAddon.fit();
    } catch {}
  });
  // Apply separate Ports and Files CSS custom properties
  const r = document.documentElement;
  r.style.setProperty('--port-font-size', (s.portFontSize || 13) + 'px');
  r.style.setProperty('--port-font-family', s.portFontFamily || DEFAULT_SETTINGS.portFontFamily);
  r.style.setProperty('--files-font-size', (s.filesFontSize || 13) + 'px');
  r.style.setProperty('--files-font-family', s.filesFontFamily || DEFAULT_SETTINGS.filesFontFamily);
  // Apply keyboard bar height
  document.querySelectorAll('.mobile-kbd-bar').forEach(b => { b.style.height = s.kbdHeight + 'px'; });
}

function getTerminalOptions(s) {
  return {
    cursorBlink: s.termBlink,
    fontSize: s.termFontSize,
    fontFamily: s.termFontFamily,
    cursorStyle: s.termCursor,
    scrollback: s.termScrollback,
    theme: {
      background: s.termBg, foreground: s.termFg, cursor: '#0080ff',
      black:'#0a0e1a', red:'#f43f5e', green:'#22c55e', yellow:'#fbbf24',
      blue:'#4da6ff', magenta:'#a78bfa', cyan:'#00d4ff', white: s.termFg,
      brightBlack:'#4a5568', brightRed:'#fb7185', brightGreen:'#4ade80',
      brightYellow:'#fde68a', brightBlue:'#7dd3fc', brightMagenta:'#c4b5fd',
      brightCyan:'#67e8f9', brightWhite:'#f1f5f9',
    },
  };
}

function setupSettings() {
  const s = loadSettings();

  // Populate controls
  const setVal = (id, val) => { const el = $(id); if (el) el.value = val; };
  const setChk = (id, val) => { const el = $(id); if (el) el.checked = val; };
  setVal('s-term-size',    s.termFontSize);
  setVal('s-term-family',  s.termFontFamily);
  setVal('s-term-bg',      s.termBg);
  setVal('s-term-fg',      s.termFg);
  setVal('s-term-cursor',  s.termCursor);
  setChk('s-term-blink',   s.termBlink);
  setVal('s-scrollback',   s.termScrollback);
  setVal('s-port-size',    s.portFontSize);
  setVal('s-port-family',  s.portFontFamily);
  setVal('s-files-size',   s.filesFontSize);
  setVal('s-files-family', s.filesFontFamily);
  setVal('s-kbd-size',     s.kbdHeight);
  $('s-term-size-val').textContent  = s.termFontSize;
  $('s-scrollback-val').textContent = s.termScrollback;
  $('s-port-size-val').textContent  = s.portFontSize;
  $('s-files-size-val').textContent = s.filesFontSize;

  // Apply on open
  applySettings(s);

  // Open / close
  const panel = $('settings-panel'), overlay = $('settings-overlay');
  const openPanel  = () => { panel.classList.remove('hidden'); overlay.classList.remove('hidden'); };
  const closePanel = () => { panel.classList.add('hidden');    overlay.classList.add('hidden'); };
  $('settings-btn').onclick         = openPanel;
  $('settings-panel-close').onclick = closePanel;
  overlay.onclick                   = closePanel;

  // Live update helper
  const onChange = () => {
    const cur = {
      termFontSize:   +$('s-term-size').value,
      termFontFamily: $('s-term-family').value,
      termBg:         $('s-term-bg').value,
      termFg:         $('s-term-fg').value,
      termCursor:     $('s-term-cursor').value,
      termBlink:      $('s-term-blink').checked,
      termScrollback: +$('s-scrollback').value,
      portFontSize:   +$('s-port-size').value,
      portFontFamily: $('s-port-family').value,
      filesFontSize:  +$('s-files-size').value,
      filesFontFamily:$('s-files-family').value,
      kbdHeight:      +$('s-kbd-size').value,
    };
    $('s-term-size-val').textContent  = cur.termFontSize;
    $('s-scrollback-val').textContent = cur.termScrollback;
    $('s-port-size-val').textContent  = cur.portFontSize;
    $('s-files-size-val').textContent = cur.filesFontSize;
    saveSettings(cur);
    applySettings(cur);
  };

  ['s-term-size','s-term-family','s-term-bg','s-term-fg','s-term-cursor',
   's-term-blink','s-scrollback','s-port-size','s-port-family',
   's-files-size','s-files-family','s-kbd-size']
    .forEach(id => { const el = $(id); if (el) el.addEventListener('input', onChange); });

  // Reset
  $('settings-reset').onclick = () => {
    saveSettings(DEFAULT_SETTINGS);
    setupSettings(); // re-populate and re-apply
  };
}

// ===== CUSTOM BUTTONS =====
const CUSTOM_BTNS_KEY = 'ks-ssh-custom-btns';
let customBtns = [];
let _editingBtnId = null;
let _pillMenuEl   = null;
let _timeCheckIv  = null;

function loadCustomBtns() {
  try { customBtns = JSON.parse(localStorage.getItem(CUSTOM_BTNS_KEY) || '[]'); }
  catch { customBtns = []; }
}
function saveCustomBtns() {
  try { localStorage.setItem(CUSTOM_BTNS_KEY, JSON.stringify(customBtns)); } catch {}
}
function genBtnId() {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

function fmtRunWhenLabel(runWhen) {
  if (!runWhen || runWhen === 'click') return null;
  if (runWhen.startsWith('delay:')) return runWhen.slice(6) + 's';
  if (runWhen.startsWith('time:'))  return runWhen.slice(5);
  return null;
}

function runCustomBtn(btn) {
  if (!activeTermId) { showToast('No active terminal', 'warn'); return; }
  const code = btn.code.endsWith('\n') ? btn.code : btn.code + '\n';

  if (!btn.runWhen || btn.runWhen === 'click') {
    sendBatchedInput(activeTermId, code);

  } else if (btn.runWhen.startsWith('delay:')) {
    const secs = Math.max(1, parseInt(btn.runWhen.slice(6), 10) || 5);
    const pillEl = document.querySelector(`.custom-pill[data-id="${btn.id}"]`);
    let rem = secs;

    const nameEl = pillEl?.querySelector('.custom-pill-name');
    if (pillEl) pillEl.classList.add('running');
    const tick = () => { if (nameEl) nameEl.textContent = rem + 's…'; rem--; };
    tick();
    const iv = setInterval(() => {
      if (rem < 0) {
        clearInterval(iv);
        sendBatchedInput(activeTermId, code);
        if (pillEl) {
          pillEl.classList.remove('running');
          if (nameEl) nameEl.textContent = btn.name;
        }
      } else { tick(); }
    }, 1000);

  } else if (btn.runWhen.startsWith('time:')) {
    // Manual trigger of a scheduled button
    sendBatchedInput(activeTermId, code);
    showToast('Ran "' + btn.name + '"', 'info');
  }
}

function startTimeScheduler() {
  if (_timeCheckIv) clearInterval(_timeCheckIv);
  _timeCheckIv = setInterval(() => {
    if (!activeTermId) return;
    const now  = new Date();
    const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    customBtns.forEach(btn => {
      if (btn.runWhen === 'time:' + hhmm) {
        const code = btn.code.endsWith('\n') ? btn.code : btn.code + '\n';
        sendBatchedInput(activeTermId, code);
        showToast('Scheduled: ran "' + btn.name + '"', 'info');
      }
    });
  }, 30000);
}

function closePillMenu() {
  if (_pillMenuEl) { _pillMenuEl.remove(); _pillMenuEl = null; }
}

function showPillMenu(e, btn) {
  closePillMenu();
  const menu = document.createElement('div');
  menu.className = 'file-dropdown';
  menu.style.cssText = 'position:fixed;z-index:700;width:130px';
  menu.innerHTML = `
    <button id="pm-edit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Edit</button>
    <div class="dd-sep"></div>
    <button id="pm-delete" class="danger"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg> Delete</button>`;
  const r = e.target.getBoundingClientRect();
  menu.style.top  = Math.min(r.bottom + 4, window.innerHeight - 85) + 'px';
  menu.style.left = Math.min(r.left, window.innerWidth - 140) + 'px';
  document.body.appendChild(menu);
  _pillMenuEl = menu;
  menu.querySelector('#pm-edit').onclick   = () => { closePillMenu(); openCustomBtnDialog(btn); };
  menu.querySelector('#pm-delete').onclick = () => {
    closePillMenu();
    customBtns = customBtns.filter(b => b.id !== btn.id);
    saveCustomBtns(); renderCustomBtns();
  };
  setTimeout(() => document.addEventListener('click', closePillMenu, { once: true }), 0);
}

function renderCustomBtns() {
  const list = $('custom-btns-list');
  if (!list) return;
  list.innerHTML = '';
  if (customBtns.length === 0) {
    list.innerHTML = '<span class="custom-btns-empty">No buttons yet — press + to add one</span>';
    return;
  }
  customBtns.forEach(btn => {
    const isDelay = btn.runWhen?.startsWith('delay:');
    const isTime  = btn.runWhen?.startsWith('time:');
    const label   = fmtRunWhenLabel(btn.runWhen);
    const pill = document.createElement('div');
    pill.className = 'custom-pill' + (isDelay ? ' pill-delay' : '') + (isTime ? ' pill-time' : '');
    pill.dataset.id = btn.id;

    let tagHtml = '';
    if (label) {
      const icon = isDelay
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="9" height="9"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="9" height="9"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;
      tagHtml = `<span class="custom-pill-tag">${icon}${label}</span>`;
    }

    pill.innerHTML = `
      <span class="custom-pill-name">${btn.name}</span>
      ${tagHtml}
      <button class="custom-pill-menu" title="Edit / Delete">&#8942;</button>`;

    pill.addEventListener('click', (e) => {
      if (e.target.closest('.custom-pill-menu')) return;
      runCustomBtn(btn);
    });
    pill.querySelector('.custom-pill-menu').addEventListener('click', (e) => {
      e.stopPropagation();
      showPillMenu(e, btn);
    });
    list.appendChild(pill);
  });
}

function updateRunWhenUI() {
  const val = $('cb-run-when').value;
  $('cb-delay-row').classList.toggle('hidden', val !== 'delay');
  $('cb-time-row').classList.toggle('hidden',  val !== 'time');
}

function openCustomBtnDialog(existing) {
  _editingBtnId = existing ? existing.id : null;
  $('custom-btn-modal-title').textContent = existing ? 'Edit Button' : 'Add Custom Button';
  $('cb-name').value = existing?.name || '';
  $('cb-code').value = existing?.code || '';
  const rw = existing?.runWhen || 'click';
  if (rw.startsWith('delay:')) {
    $('cb-run-when').value = 'delay'; $('cb-delay').value = rw.slice(6);
  } else if (rw.startsWith('time:')) {
    $('cb-run-when').value = 'time'; $('cb-time').value = rw.slice(5);
  } else {
    $('cb-run-when').value = 'click';
  }
  updateRunWhenUI();
  $('custom-btn-overlay').classList.remove('hidden');
  setTimeout(() => $('cb-name').focus(), 60);
}

function saveCustomBtnDialog() {
  const name = $('cb-name').value.trim();
  const code = $('cb-code').value;
  if (!name)       { $('cb-name').focus(); showToast('Enter a button name', 'warn'); return; }
  if (!code.trim()){ $('cb-code').focus(); showToast('Enter a command',     'warn'); return; }

  const sel = $('cb-run-when').value;
  let runWhen = 'click';
  if (sel === 'delay') runWhen = 'delay:' + ($('cb-delay').value || 5);
  else if (sel === 'time') runWhen = 'time:' + ($('cb-time').value || '08:00');

  if (_editingBtnId) {
    const idx = customBtns.findIndex(b => b.id === _editingBtnId);
    if (idx !== -1) customBtns[idx] = { ...customBtns[idx], name, code, runWhen };
  } else {
    customBtns.push({ id: genBtnId(), name, code, runWhen });
  }
  saveCustomBtns(); renderCustomBtns();
  $('custom-btn-overlay').classList.add('hidden');
}

function openBulkDialog() {
  $('bulk-btn-text').value = '';
  $('bulk-btn-overlay').classList.remove('hidden');
  setTimeout(() => $('bulk-btn-text').focus(), 60);
}

function saveBulkDialog() {
  const lines = $('bulk-btn-text').value.split('\n').map(l => l.trim()).filter(Boolean);
  let added = 0;
  lines.forEach(line => {
    const parts = line.split('|').map(p => p.trim());
    if (parts.length < 2) return;
    const [name, code, rwRaw = 'click'] = parts;
    if (!name || !code) return;
    let runWhen = 'click';
    if (/^delay:\d+$/.test(rwRaw))           runWhen = rwRaw;
    else if (/^time:\d{1,2}:\d{2}$/.test(rwRaw)) runWhen = rwRaw;
    customBtns.push({ id: genBtnId(), name, code, runWhen });
    added++;
  });
  saveCustomBtns(); renderCustomBtns();
  $('bulk-btn-overlay').classList.add('hidden');
  showToast('Added ' + added + ' button' + (added !== 1 ? 's' : ''), 'success');
}

function setupCustomBtns() {
  loadCustomBtns();
  renderCustomBtns();
  startTimeScheduler();

  // Bar buttons
  $('custom-btn-add').onclick  = () => openCustomBtnDialog(null);
  $('custom-btn-bulk').onclick = openBulkDialog;

  // Add/edit dialog
  $('cb-run-when').addEventListener('change', updateRunWhenUI);
  $('custom-btn-modal-close').onclick   = () => $('custom-btn-overlay').classList.add('hidden');
  $('custom-btn-modal-cancel').onclick  = () => $('custom-btn-overlay').classList.add('hidden');
  $('custom-btn-modal-save').onclick    = saveCustomBtnDialog;
  $('custom-btn-overlay').onclick = (e) => { if (e.target === $('custom-btn-overlay')) $('custom-btn-overlay').classList.add('hidden'); };

  // Enter key in name field → focus code
  $('cb-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('cb-code').focus(); } });
  // Ctrl+Enter in code → save
  $('cb-code').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveCustomBtnDialog(); } });

  // Bulk dialog
  $('bulk-btn-modal-close').onclick = () => $('bulk-btn-overlay').classList.add('hidden');
  $('bulk-btn-cancel').onclick      = () => $('bulk-btn-overlay').classList.add('hidden');
  $('bulk-btn-save').onclick        = saveBulkDialog;
  $('bulk-btn-overlay').onclick = (e) => { if (e.target === $('bulk-btn-overlay')) $('bulk-btn-overlay').classList.add('hidden'); };
}

// ===== MOBILE KEYBOARD BAR =====
function buildKeyboardBar() {
  const bar = document.createElement('div');
  bar.className = 'mobile-kbd-bar';

  const keys = [
    { label: 'ESC',  key: '\x1b',    cls: 'mod' },
    { label: 'TAB',  key: '\t',      cls: '' },
    { label: 'BKSP', key: '\x7f',    cls: '' },
    { label: 'DEL',  key: '\x1b[3~', cls: '' },
    { sep: true },
    { label: 'CTRL', key: 'CTRL',    cls: 'mod', id: 'kbd-ctrl' },
    { label: 'ALT',  key: 'ALT',     cls: 'mod', id: 'kbd-alt' },
    { sep: true },
    { label: '↑',    key: '\x1b[A',  cls: 'nav' },
    { label: '↓',    key: '\x1b[B',  cls: 'nav' },
    { label: '←',    key: '\x1b[D',  cls: 'nav' },
    { label: '→',    key: '\x1b[C',  cls: 'nav' },
    { sep: true },
    { label: 'Home', key: '\x1b[H',  cls: '' },
    { label: 'End',  key: '\x1b[F',  cls: '' },
    { label: 'PgUp', key: '\x1b[5~', cls: '' },
    { label: 'PgDn', key: '\x1b[6~', cls: '' },
    { sep: true },
    { label: 'F1',   key: '\x1bOP',  cls: 'fn' },
    { label: 'F2',   key: '\x1bOQ',  cls: 'fn' },
    { label: 'F3',   key: '\x1bOR',  cls: 'fn' },
    { label: 'F4',   key: '\x1bOS',  cls: 'fn' },
    { label: 'F5',   key: '\x1b[15~',cls: 'fn' },
    { label: 'F6',   key: '\x1b[17~',cls: 'fn' },
    { label: 'F7',   key: '\x1b[18~',cls: 'fn' },
    { label: 'F8',   key: '\x1b[19~',cls: 'fn' },
    { label: 'F9',   key: '\x1b[20~',cls: 'fn' },
    { label: 'F10',  key: '\x1b[21~',cls: 'fn' },
    { label: 'F11',  key: '\x1b[23~',cls: 'fn' },
    { label: 'F12',  key: '\x1b[24~',cls: 'fn' },
    { sep: true },
    { label: '|',  key: '|',   cls: '' },
    { label: '~',  key: '~',   cls: '' },
    { label: '/',  key: '/',   cls: '' },
    { label: '-',  key: '-',   cls: '' },
    { label: '_',  key: '_',   cls: '' },
    { label: '\\', key: '\\',  cls: '' },
    { label: '`',  key: '`',   cls: '' },
    { label: '^',  key: '^',   cls: '' },
    { label: '&',  key: '&',   cls: '' },
    { label: '*',  key: '*',   cls: '' },
    { label: ';',  key: ';',   cls: '' },
    { label: ':',  key: ':',   cls: '' },
    { label: '=',  key: '=',   cls: '' },
    { label: '+',  key: '+',   cls: '' },
    { label: '#',  key: '#',   cls: '' },
    { label: '$',  key: '$',   cls: '' },
    { label: '@',  key: '@',   cls: '' },
    { label: '!',  key: '!',   cls: '' },
    { label: '?',  key: '?',   cls: '' },
    { label: '%',  key: '%',   cls: '' },
    { label: "'",  key: "'",   cls: '' },
    { label: '"',  key: '"',   cls: '' },
    { label: '(',  key: '(',   cls: '' },
    { label: ')',  key: ')',   cls: '' },
    { label: '[',  key: '[',   cls: '' },
    { label: ']',  key: ']',   cls: '' },
    { label: '{',  key: '{',   cls: '' },
    { label: '}',  key: '}',   cls: '' },
    { label: '<',  key: '<',   cls: '' },
    { label: '>',  key: '>',   cls: '' },
  ];

  keys.forEach(k => {
    if (k.sep) {
      const sep = document.createElement('div');
      sep.className = 'kbd-sep';
      bar.appendChild(sep);
      return;
    }
    const btn = document.createElement('button');
    btn.className = 'kbd-key' + (k.cls ? ' ' + k.cls : '');
    btn.textContent = k.label;
    if (k.id) btn.id = k.id;
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); sendKbdKey(k.key); });
    bar.appendChild(btn);
  });

  return bar;
}

function sendKbdKey(key) {
  if (!activeTermId) return;
  const t = terminals.get(activeTermId);
  if (!t) return;

  if (key === 'CTRL') {
    ctrlActive = !ctrlActive;
    if (ctrlActive) altActive = false;
    updateKbdModifiers();
    return;
  }
  if (key === 'ALT') {
    altActive = !altActive;
    if (altActive) ctrlActive = false;
    updateKbdModifiers();
    return;
  }

  let data = key;
  if (ctrlActive) {
    if (key.length === 1)        data = String.fromCharCode(key.charCodeAt(0) & 0x1f);
    else if (key === '\x1b[A')   data = '\x1b[1;5A';
    else if (key === '\x1b[B')   data = '\x1b[1;5B';
    else if (key === '\x1b[C')   data = '\x1b[1;5C';
    else if (key === '\x1b[D')   data = '\x1b[1;5D';
    ctrlActive = false;
    updateKbdModifiers();
  } else if (altActive) {
    data = '\x1b' + key;
    altActive = false;
    updateKbdModifiers();
  }

  sendBatchedInput(activeTermId, data);
  try { t.xterm.focus(); } catch {}
}

function updateKbdModifiers() {
  const cb = $('kbd-ctrl'), ab = $('kbd-alt');
  if (cb) cb.classList.toggle('on', ctrlActive);
  if (ab) ab.classList.toggle('on', altActive);
}

// ===== FILES =====
async function loadFiles(dirPath) {
  $('files-list').innerHTML = '<div class="loading-files">Loading…</div>';
  exitSelectMode();
  try {
    const res = await fetch(`${API}/ksapi/files?path=${encodeURIComponent(dirPath || '/')}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    currentFilePath = data.path;
    $('current-path').textContent = data.path;
    renderBreadcrumb(data.path);
    renderFileList(data);
  } catch (err) {
    $('files-list').innerHTML = `<div class="loading-files" style="color:var(--red)">Error: ${err.message}</div>`;
  }
}

function renderBreadcrumb(filePath) {
  const bc = $('breadcrumb');
  bc.innerHTML = '';
  const parts = filePath.split('/').filter(Boolean);
  const paths = ['/'];
  parts.forEach(p => paths.push(paths[paths.length - 1].replace(/\/$/, '') + '/' + p));
  paths.forEach((p, i) => {
    const seg = parts[i - 1] || '/';
    const el = document.createElement('span');
    el.className = 'bc-item' + (i === paths.length - 1 ? ' current' : '');
    el.textContent = seg === '/' ? '/ root' : seg;
    if (i < paths.length - 1) el.onclick = () => loadFiles(p);
    bc.appendChild(el);
    if (i < paths.length - 1) { const sep = document.createElement('span'); sep.className = 'bc-sep'; sep.textContent = '/'; bc.appendChild(sep); }
  });
}

function getFileIcon(file) {
  if (file.isDirectory) return `<svg viewBox="0 0 24 24" fill="#f59e0b" width="18" height="18"><path d="M10 4H2a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>`;
  const c = {'.js':'#f59e0b','.ts':'#3b82f6','.jsx':'#06b6d4','.tsx':'#06b6d4','.py':'#10b981','.rb':'#ef4444','.go':'#00d4ff','.rs':'#f97316','.html':'#f97316','.css':'#3b82f6','.json':'#f59e0b','.md':'#94a3b8','.sh':'#10b981','.bash':'#10b981','.env':'#ef4444','.log':'#64748b','.zip':'#a855f7','.tar':'#a855f7','.gz':'#a855f7','.jpg':'#ec4899','.jpeg':'#ec4899','.png':'#ec4899','.gif':'#ec4899','.svg':'#ec4899','.pdf':'#ef4444','.sql':'#00d4ff','.db':'#00d4ff'};
  const color = c[file.ext] || '#64748b';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.5" width="18" height="18"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
}

const TEXT_EXTS = new Set(['.txt','.js','.ts','.jsx','.tsx','.py','.rb','.go','.rs','.html','.css','.json','.yaml','.yml','.md','.sh','.bash','.env','.xml','.sql','.c','.cpp','.h','.java','.log','.conf','.ini','.toml','.php','.cs','.swift','.kt','.lua','.r','.m','.nginx','.htaccess','.vue','.dart','.zig']);

function fmtRelTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60)   return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60)   return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24)   return h + 'h ago';
  const d = Math.floor(h / 24);
  if (d < 7)    return d + 'd ago';
  const w = Math.floor(d / 7);
  if (w < 5)    return w + 'w ago';
  const mo = Math.floor(d / 30);
  if (mo < 12)  return mo + 'mo ago';
  return Math.floor(d / 365) + 'y ago';
}

function renderFileList(data) {
  const list = $('files-list');
  if (selectMode) list.classList.add('select-mode');
  list.innerHTML = '';

  if (data.parent && data.path !== '/') {
    const up = document.createElement('div');
    up.className = 'file-item-row file-up-row';
    up.style.cursor = 'pointer';
    up.innerHTML = `
      <span></span>
      <span class="file-icon-svg"><svg viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5" width="18" height="18"><polyline points="15 18 9 12 15 6"/></svg></span>
      <div class="file-info"><div class="file-name">..</div><div class="file-meta">Parent directory</div></div>
      <div class="file-size-col"></div>
      <div></div>`;
    up.onclick = () => loadFiles(data.parent);
    list.appendChild(up);
  }

  data.files.forEach(file => {
    const isText = TEXT_EXTS.has(file.ext) || (!file.ext && !file.isDirectory);
    const row = document.createElement('div');
    row.className = 'file-item-row';
    if (file.isDirectory) row.style.cursor = 'pointer';

    // Checkbox
    const checkWrap = document.createElement('span');
    checkWrap.onclick = (e) => e.stopPropagation();
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'file-check';
    check.dataset.path = file.path;
    check.onchange = () => { row.classList.toggle('selected', check.checked); updateBulkBar(); };
    checkWrap.appendChild(check);
    row.appendChild(checkWrap);

    // Icon
    const iconEl = document.createElement('span');
    iconEl.className = 'file-icon-svg';
    iconEl.innerHTML = getFileIcon(file);
    row.appendChild(iconEl);

    // Info (name + meta)
    const infoEl = document.createElement('div');
    infoEl.className = 'file-info';
    const relTime = fmtRelTime(file.modified);
    const extBadge = (!file.isDirectory && file.ext) ? `<span class="file-ext-badge">${file.ext.replace('.', '')}</span>` : '';
    infoEl.innerHTML = `<div class="file-name" title="${file.name}">${file.name}${extBadge}</div><div class="file-meta">${relTime}</div>`;
    row.appendChild(infoEl);

    // Size column
    const sizeEl = document.createElement('div');
    sizeEl.className = 'file-size-col';
    sizeEl.textContent = file.isDirectory ? '—' : fmt(file.size);
    row.appendChild(sizeEl);

    // 3-dot menu
    const menuWrap = document.createElement('div');
    menuWrap.className = 'file-menu-wrap';
    menuWrap.onclick = (e) => e.stopPropagation();
    const menuBtn = document.createElement('button');
    menuBtn.className = 'file-menu-btn';
    menuBtn.innerHTML = '&#8942;';
    menuBtn.title = 'Actions';
    menuBtn.onclick = (e) => { e.stopPropagation(); openDropdown(menuBtn, file, isText); };
    menuWrap.appendChild(menuBtn);
    row.appendChild(menuWrap);

    if (file.isDirectory) {
      row.addEventListener('click', (e) => {
        if (!e.target.closest('.file-menu-wrap') && !e.target.closest('.file-check')) loadFiles(file.path);
      });
    }
    list.appendChild(row);
  });

  // Empty state
  if (data.files.length === 0 && !(data.parent && data.path !== '/')) {
    const empty = document.createElement('div');
    empty.className = 'files-empty-state';
    empty.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" width="40" height="40"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg><span>Empty directory</span>`;
    list.appendChild(empty);
  }
}

function openDropdown(btn, file, isText) {
  closeDropdown();
  const rect = btn.getBoundingClientRect();
  const dd = document.createElement('div');
  dd.className = 'file-dropdown';
  dd.style.top = rect.bottom + 4 + 'px';
  dd.style.left = (rect.right - 140) + 'px';

  const items = [];
  if (isText) items.push({ label: 'Edit', icon: '✏️', action: () => openFileEditor(file) });
  items.push({ label: 'Download', icon: '⬇️', action: () => downloadFile(file.path) });
  items.push({ label: 'Zip', icon: '📦', action: () => zipSingle(file) });
  items.push({ sep: true });
  items.push({ label: 'Rename', icon: '📝', action: () => openRenameModal('Rename', file.name, async (newName) => {
    const r = await fetch(`${API}/ksapi/files/rename`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ oldPath: file.path, newName }) });
    const d = await r.json();
    if (d.success) { showToast('Renamed', 'success'); loadFiles(currentFilePath); } else showToast(d.error, 'error');
  }) });
  items.push({ label: 'Delete', icon: '🗑️', danger: true, action: () => openConfirmModal(`Delete "${file.name}"?`, async () => {
    const r = await fetch(`${API}/ksapi/files/delete`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ filePath: file.path }) });
    const d = await r.json();
    if (d.success) { showToast('Deleted', 'success'); loadFiles(currentFilePath); } else showToast(d.error, 'error');
  }) });

  items.forEach(item => {
    if (item.sep) { const s = document.createElement('div'); s.className = 'dd-sep'; dd.appendChild(s); return; }
    const btn2 = document.createElement('button');
    if (item.danger) btn2.className = 'danger';
    btn2.innerHTML = `<span>${item.icon}</span><span>${item.label}</span>`;
    btn2.onclick = () => { closeDropdown(); item.action(); };
    dd.appendChild(btn2);
  });

  document.body.appendChild(dd);
  activeDropdown = dd;

  // Ensure dropdown stays in viewport
  setTimeout(() => {
    const r = dd.getBoundingClientRect();
    if (r.right > window.innerWidth) dd.style.left = (window.innerWidth - r.width - 8) + 'px';
    if (r.bottom > window.innerHeight) dd.style.top = (rect.top - r.height - 4) + 'px';
  }, 0);
}

function closeDropdown() {
  if (activeDropdown) { activeDropdown.remove(); activeDropdown = null; }
}

async function zipSingle(file) {
  showToast(`Zipping ${file.name}…`, 'info');
  try {
    const res = await fetch(`${API}/ksapi/files/zip`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ paths:[file.path], outputDir:currentFilePath, outputName:file.name + '.zip' }) });
    const d = await res.json();
    if (d.success) { showToast(`Created ${d.name}`, 'success'); loadFiles(currentFilePath); } else showToast(d.error, 'error');
  } catch (err) { showToast(err.message, 'error'); }
}

function downloadFile(filePath) {
  const a = document.createElement('a');
  a.href = `${API}/ksapi/files/download?path=${encodeURIComponent(filePath)}`;
  a.download = '';
  a.click();
}

async function handleFileUpload() {
  const input = $('file-upload-input');
  if (!input.files.length) return;
  const fd = new FormData();
  for (const f of input.files) fd.append('files', f);
  try {
    const res = await fetch(`${API}/ksapi/files/upload?path=${encodeURIComponent(currentFilePath)}`, { method:'POST', body:fd });
    const d = await res.json();
    if (d.success) { showToast(`Uploaded ${d.count} file(s)`, 'success'); loadFiles(currentFilePath); }
  } catch (err) { showToast(err.message, 'error'); }
  input.value = '';
}

async function handleMkdir() {
  openRenameModal('New Folder Name', '', async (name) => {
    if (!name) return;
    const res = await fetch(`${API}/ksapi/files/mkdir`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ dirPath: currentFilePath.replace(/\/$/, '') + '/' + name }) });
    const d = await res.json();
    if (d.success) { showToast('Folder created', 'success'); loadFiles(currentFilePath); } else showToast(d.error, 'error');
  });
}

function getEditorMode(ext) {
  const map = {
    '.js':'javascript','.ts':'javascript','.jsx':'javascript','.tsx':'javascript',
    '.json':{name:'javascript',json:true},
    '.html':'htmlmixed','.htm':'htmlmixed',
    '.css':'css','.scss':'css','.less':'css',
    '.py':'python',
    '.sh':'shell','.bash':'shell','.zsh':'shell',
    '.md':'markdown',
    '.xml':'xml','.svg':'xml',
    '.sql':'text/x-sql',
    '.yaml':'yaml','.yml':'yaml',
  };
  return map[ext] || 'text/plain';
}

async function openFileEditor(file) {
  try {
    const res = await fetch(`${API}/ksapi/files/read?path=${encodeURIComponent(file.path)}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    $('editor-modal-title').textContent = 'Edit: ' + file.name;
    pendingEditor = file.path;
    $('editor-modal').classList.remove('hidden');

    // Destroy old CodeMirror instance if any
    if (window._cmEditor) { try { window._cmEditor.toTextArea(); } catch {} window._cmEditor = null; }

    // Use CodeMirror if available, else fallback to textarea
    if (window.CodeMirror) {
      $('file-editor').value = '';
      setTimeout(() => {
        window._cmEditor = CodeMirror.fromTextArea($('file-editor'), {
          mode: getEditorMode(file.ext),
          theme: 'dracula',
          lineNumbers: true,
          matchBrackets: true,
          autoCloseBrackets: true,
          tabSize: 2,
          indentWithTabs: false,
          lineWrapping: true,
          extraKeys: { 'Ctrl-S': () => $('editor-save').click() },
        });
        window._cmEditor.setValue(data.content || '');
        window._cmEditor.refresh();
        window._cmEditor.focus();
      }, 60);
    } else {
      $('file-editor').value = data.content || '';
      setTimeout(() => $('file-editor').focus(), 50);
    }
  } catch (err) { showToast('Cannot open: ' + err.message, 'error'); }
}

// Multi-select
function toggleSelectMode() {
  selectMode = !selectMode;
  const list = $('files-list');
  list.classList.toggle('select-mode', selectMode);
  $('select-toggle-btn').style.color = selectMode ? 'var(--blue-light)' : '';
  updateBulkBar();
  if (!selectMode) {
    list.querySelectorAll('.file-check').forEach(c => { c.checked = false; c.closest('.file-item-row').classList.remove('selected'); });
    $('bulk-bar').classList.add('hidden');
  }
}

function exitSelectMode() {
  if (!selectMode) return;
  selectMode = false;
  $('files-list').classList.remove('select-mode');
  $('select-toggle-btn').style.color = '';
  $('bulk-bar').classList.add('hidden');
  $('files-list').querySelectorAll('.file-check').forEach(c => { c.checked = false; c.closest('.file-item-row').classList.remove('selected'); });
}

function getSelectedPaths() {
  return [...$('files-list').querySelectorAll('.file-check:checked')].map(c => c.dataset.path);
}

function updateBulkBar() {
  const paths = getSelectedPaths();
  if (selectMode || paths.length > 0) {
    $('bulk-bar').classList.remove('hidden');
    $('bulk-count').textContent = paths.length + ' selected';
  } else {
    $('bulk-bar').classList.add('hidden');
  }
}

async function bulkDelete() {
  const paths = getSelectedPaths();
  if (!paths.length) return showToast('No items selected', 'info');
  openConfirmModal(`Delete ${paths.length} item(s)? This cannot be undone.`, async () => {
    const res = await fetch(`${API}/ksapi/files/delete`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ filePaths: paths }) });
    const d = await res.json();
    if (d.success) { showToast(`Deleted ${paths.length} item(s)`, 'success'); exitSelectMode(); loadFiles(currentFilePath); } else showToast(d.error, 'error');
  });
}

async function bulkZip() {
  const paths = getSelectedPaths();
  if (!paths.length) return showToast('No items selected', 'info');
  showToast(`Zipping ${paths.length} item(s)…`, 'info');
  try {
    const res = await fetch(`${API}/ksapi/files/zip`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ paths, outputDir: currentFilePath }) });
    const d = await res.json();
    if (d.success) { showToast(`Created ${d.name}`, 'success'); exitSelectMode(); loadFiles(currentFilePath); } else showToast(d.error, 'error');
  } catch (err) { showToast(err.message, 'error'); }
}

// ===== PORTS =====
async function loadPorts() {
  $('ports-list').innerHTML = '<div class="loading-ports">Scanning…</div>';
  $('ports-count').textContent = '…';
  try {
    const res = await fetch(`${API}/ksapi/ports`);
    const data = await res.json();
    const ports = data.ports || [];
    $('ports-count').textContent = ports.length;

    if (!ports.length) {
      $('ports-list').innerHTML = `<div class="ports-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="44" height="44" style="color:var(--text-muted)"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><line x1="21.17" y1="8" x2="12" y2="8"/><line x1="3.95" y1="6.06" x2="8.54" y2="14"/><line x1="10.88" y1="21.94" x2="15.46" y2="14"/></svg>
        <div style="font-weight:600;color:var(--text-secondary)">No listening ports found</div>
        <div style="font-size:11px;color:var(--text-muted)">Start a server and click Refresh</div>
      </div>`;
      return;
    }

    $('ports-list').innerHTML = '';
    const table = document.createElement('table');
    table.className = 'ports-table';
    table.innerHTML = `<thead><tr><th>Port</th><th>Process</th><th>Address</th><th>Visibility</th><th>Action</th></tr></thead><tbody id="ports-tbody"></tbody>`;
    $('ports-list').appendChild(table);
    const tbody = $('ports-tbody');
    ports.forEach(p => {
      const isAll = p.address === '0.0.0.0';
      const tr = document.createElement('tr');
      tr.className = 'port-row';
      tr.innerHTML = `
        <td><span class="port-num-badge">:${p.port}</span></td>
        <td><span class="port-proc">${p.process}</span></td>
        <td><code class="port-addr-code">${p.address}</code></td>
        <td><span class="port-vis-badge ${isAll ? 'public' : 'local'}">${isAll ? 'Public' : 'Local'}</span></td>
        <td><button class="port-open-btn" onclick="openPortPreview(${p.port})">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><rect x="2" y="3" width="20" height="14" rx="2"/><polyline points="8 21 12 17 16 21"/></svg>
          Preview
        </button></td>`;
      tbody.appendChild(tr);
    });
  } catch (err) {
    $('ports-list').innerHTML = `<div class="loading-ports" style="color:var(--red)">Error: ${err.message}</div>`;
  }
}

// ===== PORT PREVIEW =====
let activePreviewPort = null;

window.openPortPreview = function(port) {
  activePreviewPort = port;
  const proxyUrl = `${API}/ksapi/proxy/${port}/`;
  $('port-preview-badge').textContent = ':' + port;
  $('port-preview-url').textContent = `localhost:${port}`;
  $('port-preview-iframe').src = proxyUrl;
  $('port-preview-panel').classList.remove('hidden');
};

function setupPortPreview() {
  $('port-preview-close').onclick = () => {
    $('port-preview-panel').classList.add('hidden');
    $('port-preview-iframe').src = 'about:blank';
    activePreviewPort = null;
  };
  $('port-preview-reload').onclick = () => {
    if (activePreviewPort) $('port-preview-iframe').src = `${API}/ksapi/proxy/${activePreviewPort}/`;
  };
  $('port-preview-popout').onclick = () => {
    if (activePreviewPort) window.open(`${API}/ksapi/proxy/${activePreviewPort}/`, '_blank');
  };
}

// ===== MODALS =====
function setupModals() {
  // Rename/mkdir
  $('rename-modal-close').onclick = $('rename-cancel').onclick = () => $('rename-modal').classList.add('hidden');
  $('rename-confirm').onclick = () => {
    const val = $('rename-input').value.trim();
    if (val && pendingRename) { pendingRename(val); pendingRename = null; }
    $('rename-modal').classList.add('hidden');
  };
  $('rename-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('rename-confirm').click(); if (e.key === 'Escape') $('rename-modal').classList.add('hidden'); });

  // Confirm delete
  $('confirm-modal-close').onclick = $('confirm-cancel').onclick = () => $('confirm-modal').classList.add('hidden');
  $('confirm-delete').onclick = () => { if (pendingDelete) { pendingDelete(); pendingDelete = null; } $('confirm-modal').classList.add('hidden'); };

  // File editor
  const closeEditor = () => {
    $('editor-modal').classList.add('hidden');
    if (window._cmEditor) { try { window._cmEditor.toTextArea(); } catch {} window._cmEditor = null; }
  };
  $('editor-modal-close').onclick = $('editor-cancel').onclick = closeEditor;
  $('editor-save').onclick = async () => {
    if (!pendingEditor) return;
    const content = window._cmEditor ? window._cmEditor.getValue() : $('file-editor').value;
    const res = await fetch(`${API}/ksapi/files/write`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ filePath: pendingEditor, content }) });
    const d = await res.json();
    if (d.success) { showToast('Saved', 'success'); closeEditor(); } else showToast(d.error, 'error');
  };

  // Terminal close confirmation
  const hideTermCloseModal = () => {
    $('term-close-modal').classList.add('hidden');
    $('term-close-input').value = '';
    $('term-close-confirm').disabled = true;
    $('term-close-input').classList.remove('valid');
    pendingTermClose = null;
  };
  $('term-close-modal-x').onclick = $('term-close-cancel').onclick = hideTermCloseModal;
  $('term-close-input').addEventListener('input', () => {
    const ok = $('term-close-input').value === 'KS SSH';
    $('term-close-confirm').disabled = !ok;
    $('term-close-input').classList.toggle('valid', ok);
  });
  $('term-close-confirm').onclick = () => {
    if (pendingTermClose !== null) { closeTerminal(pendingTermClose); }
    hideTermCloseModal();
  };

  // URL upload
  $('url-modal-close').onclick = $('url-modal-cancel').onclick = () => $('url-upload-modal').classList.add('hidden');
  $('url-modal-confirm').onclick = async () => {
    const url = $('url-upload-input').value.trim();
    const name = $('url-upload-name').value.trim();
    if (!url) return showToast('Please enter a URL', 'error');
    $('url-upload-modal').classList.add('hidden');
    showToast('Downloading from URL…', 'info');
    try {
      const res = await fetch(`${API}/ksapi/files/upload-url`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ url, destDir: currentFilePath, filename: name || undefined }) });
      const d = await res.json();
      if (d.success) { showToast(`Downloaded: ${d.name}`, 'success'); loadFiles(currentFilePath); } else showToast(d.error, 'error');
    } catch (err) { showToast(err.message, 'error'); }
    $('url-upload-input').value = '';
    $('url-upload-name').value = '';
  };

  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach(ov => {
    ov.addEventListener('click', e => { if (e.target === ov) ov.classList.add('hidden'); });
  });
}

function openRenameModal(title, currentValue, callback) {
  $('rename-modal-title').textContent = title;
  $('rename-input').value = currentValue;
  pendingRename = callback;
  $('rename-modal').classList.remove('hidden');
  setTimeout(() => { $('rename-input').focus(); $('rename-input').select(); }, 50);
}

function openConfirmModal(msg, callback) {
  $('confirm-msg').textContent = msg;
  pendingDelete = callback;
  $('confirm-modal').classList.remove('hidden');
}

// ===== TOASTS =====
function showToast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${{success:'✅',error:'❌',info:'ℹ️'}[type]||'ℹ️'}</span><span>${msg}</span>`;
  $('toast-container').appendChild(t);
  setTimeout(() => { t.style.transition = 'all .3s ease'; t.style.opacity = '0'; t.style.transform = 'translateX(100%)'; setTimeout(() => t.remove(), 300); }, 3000);
}

// ===== HELPERS =====
function fmt(bytes) {
  if (!bytes) return '0 B';
  const k = 1024, s = ['B','KB','MB','GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + s[i];
}

function fmtUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
