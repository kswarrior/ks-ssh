import { TerminalManager } from './modules/terminal.js';
import { FileManager } from './modules/files.js';
import { PortScanner } from './modules/ports.js';
import { ResourceMonitor } from './modules/res-mon.js';
import { ProcessManager } from './modules/processes.js';
import { $, showToast, fmtBytes, esc } from './modules/utils.js';

let socket, terminals, files, ports, processes, resMon;
let startTime = Date.now();

function init() {
  socket = io();
  window.terminals = terminals = new TerminalManager(socket);
  files = new FileManager();
  ports = new PortScanner();
  window.processes = processes = new ProcessManager();
  window.files = files;
  window.ports = ports;
  // resMon = new ResourceMonitor(); // Disabled as stats are now integrated

  setupNavigation();
  setupSidePane();
  setupSocket();
  setupModals();
  setupPortPreview();
  setupVPSInfo();
  setupThemes();

  // Initial tab
  setTimeout(() => {
      console.log('INIT SWITCH');
      switchTab('terminals');
  }, 100);

  // HUD Update cycle
  updateHUD();
  setInterval(updateHUD, 1000);

  // Latency check
  setInterval(checkLatency, 2000);

  // Initial tunnel check
  fetchTunnelInfo();
  setInterval(fetchTunnelInfo, 30000);

  setupCommandPalette();

  $('info-btn')?.addEventListener('click', () => {
    showToast('KS-SSH HUD MASTER v2.0.0', 'info');
  });
}

function setupCommandPalette() {
    const palette = $('cmd-palette');
    const input = $('cmd-input');
    const results = $('cmd-results');

    const commands = [
        { name: 'Terminal: New session', action: () => terminals.create(), keys: 'Ctrl+Shift+N' },
        { name: 'Files: Refresh list', action: () => files.load(), keys: 'Ctrl+R' },
        { name: 'Network: Scan ports', action: () => ports.load() },
        { name: 'Processes: Refresh tasks', action: () => processes.load() },
        { name: 'Go to Terminal', action: () => switchTab('terminals') },
        { name: 'Go to Files', action: () => switchTab('files') },
        { name: 'Go to Ports', action: () => switchTab('ports') },
        { name: 'Go to Tasks', action: () => switchTab('processes') },
        { name: 'HUD: Toggle VPS Info', action: () => $('vps-info-dropdown').classList.toggle('hidden') },
    ];

    window.addEventListener('keydown', (e) => {
        // Command Palette (Ctrl+K)
        if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
            e.preventDefault();
            palette.classList.remove('hidden');
            input.value = '';
            input.focus();
            renderResults('');
        }

        // Sidebar Toggle (Ctrl+B)
        if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
            e.preventDefault();
            toggleSidePane();
        }

        // New Terminal (Ctrl+Shift+T)
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 't') {
            e.preventDefault();
            terminals.create();
            switchTab('terminals');
        }

        if (e.key === 'Escape') palette.classList.add('hidden');
    });

    input.oninput = (e) => renderResults(e.target.value);

    function renderResults(query) {
        const filtered = query
            ? commands.filter(c => c.name.toLowerCase().includes(query.toLowerCase()))
            : commands;

        results.innerHTML = filtered.map(c => `
            <div class="cmd-item" style="padding:10px 16px; border-radius:4px; cursor:pointer; display:flex; justify-content:space-between; align-items:center; transition:0.2s;" onmouseover="this.style.background='var(--night-700)'" onmouseout="this.style.background='transparent'">
                <div style="font-size:13px; font-weight:600; color:var(--text-pure);">${c.name}</div>
                ${c.keys ? `<div style="font-size:10px; font-family:var(--font-mono); color:var(--text-dim); background:var(--night-900); padding:2px 6px; border-radius:4px;">${c.keys}</div>` : ''}
            </div>
        `).join('');

        results.querySelectorAll('.cmd-item').forEach((el, i) => {
            el.onclick = () => {
                filtered[i].action();
                palette.classList.add('hidden');
            };
        });
    }
}

async function checkLatency() {
    const start = Date.now();
    try {
        await fetch('/ksapi/ping');
        const lat = Date.now() - start;
        if ($('hdr-latency')) $('hdr-latency').textContent = `${lat}ms`;
    } catch {
        if ($('hdr-latency')) $('hdr-latency').textContent = `--ms`;
    }
}

function updateHUD() {
  // Active Sessions
  const count = terminals.terminals.size;
  const empty = $('terminals-empty');
  const tabs = $('terminal-tabs-container');
  if (empty) empty.classList.toggle('hidden', count > 0);
  if (tabs) tabs.classList.toggle('hidden', count === 0);

  loadSystemInfo();
}

function setupNavigation() {
  document.querySelectorAll('[data-tab], [data-side-tab]').forEach(btn => {
    btn.onclick = () => {
        if (btn.dataset.tab) switchTab(btn.dataset.tab);
        if (btn.dataset.sideTab) switchSideTab(btn.dataset.sideTab);
    };
  });

  $('mobile-more-btn')?.addEventListener('click', () => {
      // Toggle side pane as overlay on mobile
      toggleSidePane();
  });
}

function setupSidePane() {
    const btn = $('split-view-btn');
    const pane = $('hud-secondary-pane');
    if (!btn || !pane) return;

    btn.onclick = () => toggleSidePane();

    document.querySelectorAll('.side-nav-btn').forEach(btn => {
        btn.onclick = () => switchSideTab(btn.dataset.sideTab);
    });

    const resizer = $('hud-resizer');

    // Draggable Logic
    let isResizing = false;
    resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        resizer.classList.add('active');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    });

    window.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const width = window.innerWidth - e.clientX;
        const constrainedWidth = Math.max(200, Math.min(window.innerWidth * 0.7, width));
        pane.style.width = constrainedWidth + 'px';
        localStorage.setItem('ks-ssh-sidepane-width', constrainedWidth);
    });

    window.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            resizer.classList.remove('active');
            document.body.style.cursor = 'default';
            document.body.style.userSelect = 'auto';
            terminals.refit();
        }
    });

    // Touch Support
    resizer.addEventListener('touchstart', (e) => {
        isResizing = true;
        resizer.classList.add('active');
    });
    window.addEventListener('touchmove', (e) => {
        if (!isResizing) return;
        const width = window.innerWidth - e.touches[0].clientX;
        const constrainedWidth = Math.max(200, Math.min(window.innerWidth * 0.9, width));
        pane.style.width = constrainedWidth + 'px';
    });
    window.addEventListener('touchend', () => {
        if (isResizing) {
            isResizing = false;
            resizer.classList.remove('active');
            terminals.refit();
        }
    });

    // Restore state
    const saved = localStorage.getItem('ks-ssh-sidepane');
    const savedWidth = localStorage.getItem('ks-ssh-sidepane-width');
    if (savedWidth) pane.style.width = savedWidth + 'px';

    if (saved === 'open') {
        pane.classList.remove('hidden');
        resizer.classList.remove('hidden');
        const activeTab = localStorage.getItem('ks-ssh-sidetab') || 'files';
        switchSideTab(activeTab);
    }
}

function toggleSidePane(force) {
    const pane = $('hud-secondary-pane');
    const resizer = $('hud-resizer');

    if (force === true) {
        pane.classList.remove('hidden');
        resizer.classList.remove('hidden');
    } else if (force === false) {
        pane.classList.add('hidden');
        resizer.classList.add('hidden');
    } else {
        pane.classList.toggle('hidden');
        resizer.classList.toggle('hidden');
    }

    const nowOpen = !pane.classList.contains('hidden');
    localStorage.setItem('ks-ssh-sidepane', nowOpen ? 'open' : 'closed');

    if (nowOpen) {
        const activeTab = localStorage.getItem('ks-ssh-sidetab') || 'files';
        switchSideTab(activeTab);
    }

    setTimeout(() => terminals.refit(), 120);
}

function switchSideTab(tab) {
    const activePrimary = document.querySelector('.nav-link.active')?.dataset.tab;
    if (tab === activePrimary) {
        showToast('TAB ALREADY ACTIVE IN PRIMARY VIEW', 'info');
        return;
    }

    document.querySelectorAll('.side-nav-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.sideTab === tab);
    });
    localStorage.setItem('ks-ssh-sidetab', tab);

    const container = $('side-pane-container');

    // Move existing content back to primary before switching
    const currentInSide = container.firstElementChild;
    if (currentInSide) {
        document.querySelector('.primary-workspace').appendChild(currentInSide);
        currentInSide.classList.add('hidden');
    }

    container.innerHTML = '';

    const original = $(`tab-${tab}`);
    if (original) {
        container.appendChild(original);
        original.classList.remove('hidden');

        if (tab === 'files') files.load();
        if (tab === 'ports') ports.load();
        if (tab === 'processes') processes.load();
        if (tab === 'terminals') setTimeout(() => terminals.refit(), 50);
    }
}

window.switchTab = switchTab;
function switchTab(tab) {
  const panels = document.querySelectorAll('.tab-panel');
  const items = document.querySelectorAll('.nav-item, .nav-link, .dock-item');

  console.log('Switching to tab:', tab);

  // If tab is currently in side pane, we must move it back to primary workspace
  const sideContainer = $('side-pane-container');
  const primaryWorkspace = document.querySelector('.primary-workspace');
  const targetPanel = $(`tab-${tab}`);

  if (targetPanel && sideContainer.contains(targetPanel)) {
      primaryWorkspace.appendChild(targetPanel);
  }

  panels.forEach(p => p.classList.add('hidden'));
  items.forEach(b => b.classList.remove('active'));

  if (targetPanel) {
    targetPanel.classList.remove('hidden');
    document.querySelectorAll(`[data-tab="${tab}"]`).forEach(b => b.classList.add('active'));
  }
  if (tab === 'ports') ports.load();
  if (tab === 'processes') processes.load();
  if (tab === 'terminals') {
    setTimeout(() => terminals.refit(), 50);
  }
}

function setupSocket() {
  socket.on('terminal:data', ({ id, data }) => {
    const t = terminals.terminals.get(id);
    if (t) t.term.write(data);
  });
  socket.on('terminal:replay', ({ id, buffer }) => {
    const t = terminals.terminals.get(id);
    if (t) t.term.write(buffer);
  });

  // Restore terminals from session storage
  const saved = sessionStorage.getItem('ks-ssh-terms');
  if (saved) {
    try {
      const data = JSON.parse(saved);
      data.forEach(d => terminals._spawn({ id: d.id, num: d.num, name: d.name, restore: true }));
    } catch {}
  }
}

function setupModals() {
  const input = $('term-close-input');
  if (input) {
    input.oninput = () => {
        $('term-close-confirm').disabled = input.value !== 'KS SSH';
    };
  }
  $('term-close-confirm')?.addEventListener('click', () => {
      if (terminals.pendingClose) {
          terminals.close(terminals.pendingClose);
          $('term-close-modal').classList.add('hidden');
      }
  });
  document.querySelectorAll('.modal-close, #term-close-cancel').forEach(b => {
      b.onclick = () => $('term-close-modal').classList.add('hidden');
  });
}

function setupPortPreview() {
  window.openPortPreview = (port) => {
    $('port-preview-badge').textContent = ':' + port;
    $('port-preview-url').textContent = `localhost:${port}`;
    $('port-preview-iframe').src = `/ksapi/proxy/${port}/`;
    $('port-preview-panel').classList.remove('hidden');
  };
  $('port-preview-close')?.addEventListener('click', () => {
    $('port-preview-panel').classList.add('hidden');
    $('port-preview-iframe').src = 'about:blank';
  });
  $('port-preview-refresh')?.addEventListener('click', () => {
    const src = $('port-preview-iframe').src;
    $('port-preview-iframe').src = 'about:blank';
    setTimeout(() => { $('port-preview-iframe').src = src; }, 50);
  });
  $('port-preview-pop')?.addEventListener('click', () => {
    window.open($('port-preview-iframe').src, '_blank');
  });
}

function setupVPSInfo() {
    const btn = $('vps-info-btn');
    const menu = $('vps-info-dropdown');

    if (btn && menu) {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.classList.toggle('hidden');
        });

        document.addEventListener('click', () => {
            menu.classList.add('hidden');
        });

        menu.addEventListener('click', (e) => e.stopPropagation());
    }
}

function setupThemes() {
    const btn = $('theme-btn');
    const menu = $('theme-dropdown');
    if (!btn || !menu) return;

    btn.onclick = (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); };
    document.addEventListener('click', () => menu.classList.add('hidden'));

    const themes = {
        default: { blue: '#0099ff', glow: 'rgba(0,153,255,0.3)' },
        emerald: { blue: '#10b981', glow: 'rgba(16,185,129,0.3)' },
        ruby: { blue: '#ef4444', glow: 'rgba(239,68,68,0.3)' },
        gold: { blue: '#f59e0b', glow: 'rgba(245,158,11,0.3)' }
    };

    document.querySelectorAll('.theme-opt').forEach(opt => {
        opt.onclick = () => {
            const t = themes[opt.dataset.theme];
            document.documentElement.style.setProperty('--electric-blue', t.blue);
            document.documentElement.style.setProperty('--electric-blue-glow', t.glow);
            showToast(`THEME: ${opt.textContent.toUpperCase()}`);
            localStorage.setItem('ks-ssh-theme', opt.dataset.theme);
        };
    });

    const saved = localStorage.getItem('ks-ssh-theme');
    if (saved && themes[saved]) {
        const t = themes[saved];
        document.documentElement.style.setProperty('--electric-blue', t.blue);
        document.documentElement.style.setProperty('--electric-blue-glow', t.glow);
    }
}

function updateEl(id, text, styleProp = 'textContent') {
    const el = $(id);
    if (el) {
        if (styleProp === 'style.width') el.style.width = text;
        else el[styleProp] = text;
    }
}

async function loadSystemInfo() {
  try {
    const sRes = await fetch('/ksapi/system');
    const s = await sRes.json();

    const rRes = await fetch('/ksapi/resources');
    const r = await rRes.json();

    updateEl('hdr-host-id', s.hostname.substring(0, 12));
    updateEl('hdr-ram-pct', `${Math.round(r.ram.percent)}%`);

    updateEl('sys-host', s.hostname);
    updateEl('sys-os', `${s.platform}/${s.arch}`);
    updateEl('sys-user', s.user);
    updateEl('sys-cpus', s.cpus);
    updateEl('sys-mem', `${(r.ram.used).toFixed(1)} GB / ${(r.ram.total).toFixed(1)} GB`);

    // VPS Info
    updateEl('vps-logo', s.logo || '\u{1F427}');
    updateEl('nf-user', s.user);
    updateEl('nf-host', s.hostname);
    updateEl('nf-os', s.osName);
    updateEl('nf-platform', `${s.platform} ${s.arch}`);
    updateEl('nf-kernel', s.kernel);
    updateEl('nf-packages', s.packages);
    updateEl('nf-shell', s.shell);
    updateEl('nf-cpu', `${r.cpu.model} (${r.cpu.count})`);
    updateEl('nf-mem', `${r.ram.used.toFixed(1)}GB / ${r.ram.total.toFixed(1)}GB`);
    updateEl('nf-mem-bar', `${r.ram.percent}%`, 'style.width');

    updateEl('nf-disk', `${r.disk.used.toFixed(1)}GB / ${r.disk.total.toFixed(1)}GB`);
    updateEl('nf-disk-bar', `${r.disk.percent}%`, 'style.width');

    updateEl('nf-ip', s.ip);

    // Uptime Calculation
    const up = s.uptime;
    const days = Math.floor(up / 86400);
    const hours = Math.floor((up % 86400) / 3600);
    const mins = Math.floor((up % 3600) / 60);
    let utStr = '';
    if (days > 0) utStr += `${days} days, `;
    if (hours > 0) utStr += `${hours} hours, `;
    utStr += `${mins} mins`;

    updateEl('nf-uptime', utStr);

    // Per-core CPU
    const coreList = $('nf-cpu-cores-list');
    if (coreList && r.cpu.cores) {
        coreList.innerHTML = r.cpu.cores.map((pct, i) => `
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:2px;">
                <div style="font-size:9px; color:var(--text-dim); width:35px; font-family:var(--font-mono);">CORE${i}</div>
                <div style="flex:1; height:3px; background:var(--night-700); border-radius:2px; overflow:hidden;">
                    <div style="width:${pct}%; height:100%; background:var(--text-blue); box-shadow: 0 0 4px var(--electric-blue-glow);"></div>
                </div>
                <div style="font-size:9px; color:var(--text-main); width:25px; text-align:right;">${Math.round(pct)}%</div>
            </div>
        `).join('');
    }

    updateEl('sys-load', s.loadAvg.map(l => l.toFixed(2)).join(' '));

  } catch (err) {
      console.error('HUD update error:', err);
  }
}

async function fetchTunnelInfo() {
  try {
    const res = await fetch('/ksapi/tunnel');
    const d = await res.json();
    if (d.active && d.token) {
      // Could show in footer or somewhere else
    }
  } catch {}
}

init();
