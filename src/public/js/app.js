import { TerminalManager } from './modules/terminal.js';
import { FileManager } from './modules/files.js';
import { PortScanner } from './modules/ports.js';
import { ResourceMonitor } from './modules/res-mon.js';
import { $, showToast } from './modules/utils.js';

let socket, terminals, files, ports, resMon;
let startTime = Date.now();

function init() {
  socket = io();
  terminals = new TerminalManager(socket);
  files = new FileManager();
  ports = new PortScanner();
  resMon = new ResourceMonitor();

  setupNavigation();
  setupSocket();
  setupModals();
  setupPortPreview();

  // Initial tab
  switchTab('terminals');

  // HUD Update cycle
  updateHUD();
  setInterval(updateHUD, 1000);

  // Initial tunnel check
  fetchTunnelInfo();
  setInterval(fetchTunnelInfo, 30000);

  $('info-btn')?.addEventListener('click', () => {
    showToast('KS-SSH HUD MASTER v2.0.0', 'info');
  });
}

function updateHUD() {
  // Uptime
  const diff = Date.now() - startTime;
  const h = Math.floor(diff / 3600000).toString().padStart(2, '0');
  const m = Math.floor((diff % 3600000) / 60000).toString().padStart(2, '0');
  const s = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0');
  if ($('hud-uptime')) $('hud-uptime').textContent = `${h}:${m}:${s}`;

  // Active Sessions
  if ($('hud-session-count')) {
      const count = terminals.terminals.size;
      $('hud-session-count').textContent = `${count} ${count === 1 ? 'SESSION' : 'SESSIONS'} ACTIVE`;
  }

  loadSystemInfo();
  if (resMon.isOpen) resMon.poll();
}

function setupNavigation() {
  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.onclick = () => switchTab(btn.dataset.tab);
  });
}

function switchTab(tab) {
  const panels = document.querySelectorAll('.tab-panel');
  const items = document.querySelectorAll('.hud-nav-item');

  panels.forEach(p => p.classList.add('hidden'));
  items.forEach(b => b.classList.remove('active'));

  const targetPanel = $(`tab-${tab}`);
  if (targetPanel) {
    targetPanel.classList.remove('hidden');
    document.querySelectorAll(`[data-tab="${tab}"]`).forEach(b => b.classList.add('active'));
  }

  if (tab === 'files') files.load();
  if (tab === 'ports') ports.load();
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
}

async function loadSystemInfo() {
  try {
    const res = await fetch('/ksapi/system');
    const d = await res.json();
    if ($('sys-host')) $('sys-host').textContent = d.hostname.toUpperCase();
  } catch {}
}

async function fetchTunnelInfo() {
  try {
    const res = await fetch('/ksapi/tunnel');
    const d = await res.json();
    if (d.active && d.token) {
      $('tunnel-info-stat').style.display = 'flex';
      $('hud-tunnel-token').textContent = d.token.toUpperCase();
      $('hud-tunnel-token').onclick = () => {
        navigator.clipboard.writeText(d.url);
        showToast('TUNNEL URL COPIED');
      };
    } else {
      $('tunnel-info-stat').style.display = 'none';
    }
  } catch {}
}

init();
