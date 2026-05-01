import { TerminalManager } from './modules/terminal.js';
import { FileManager } from './modules/files.js';
import { PortScanner } from './modules/ports.js';
import { ResourceMonitor } from './modules/res-mon.js';
import { $, showToast, fmtBytes } from './modules/utils.js';

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
  setupVPSInfo();

  // Initial tab
  switchTab('terminals');

  // HUD Update cycle
  updateHUD();
  setInterval(updateHUD, 1000);

  // Latency check
  setInterval(checkLatency, 2000);

  // Initial tunnel check
  fetchTunnelInfo();
  setInterval(fetchTunnelInfo, 30000);

  $('info-btn')?.addEventListener('click', () => {
    showToast('KS-SSH HUD MASTER v2.0.0', 'info');
  });
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
  resMon.poll();
}

function setupNavigation() {
  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.onclick = () => switchTab(btn.dataset.tab);
  });
}

function switchTab(tab) {
  const panels = document.querySelectorAll('.tab-panel');
  const items = document.querySelectorAll('.nav-item, .nav-link');

  panels.forEach(p => p.classList.add('hidden'));
  items.forEach(b => b.classList.remove('active'));

  const targetPanel = $(`tab-${tab}`);
  if (targetPanel) {
    targetPanel.classList.remove('hidden');
    document.querySelectorAll(`[data-tab="${tab}"]`).forEach(b => b.classList.add('active'));
  }

  if (tab === 'files') {
    files.load();
    // Ensure navigation state is correct if called manually
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
    document.querySelector(`.nav-link[data-tab="${tab}"]`)?.classList.add('active');
  }
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

async function loadSystemInfo() {
  try {
    const sRes = await fetch('/ksapi/system');
    const s = await sRes.json();

    const rRes = await fetch('/ksapi/resources');
    const r = await rRes.json();

    if ($('hdr-host-id')) $('hdr-host-id').textContent = s.hostname.substring(0, 12);
    if ($('hdr-ram-pct')) $('hdr-ram-pct').textContent = `${Math.round(r.ram.percent)}%`;

    if ($('sys-host')) $('sys-host').textContent = s.hostname;
    if ($('sys-os')) $('sys-os').textContent = `${s.platform}/${s.arch}`;
    if ($('sys-user')) $('sys-user').textContent = s.user;
    if ($('sys-cpus')) $('sys-cpus').textContent = s.cpus;
    if ($('sys-mem')) $('sys-mem').textContent = `${(r.ram.used).toFixed(1)} GB / ${(r.ram.total).toFixed(1)} GB`;

    // VPS Info Dropdown
    if ($('vps-cpu-model')) $('vps-cpu-model').textContent = r.cpu.model || 'N/A';
    if ($('vps-cpu-cores')) $('vps-cpu-cores').textContent = r.cpu.count;
    if ($('vps-ram-usage')) $('vps-ram-usage').textContent = `${r.ram.used.toFixed(1)}/${r.ram.total.toFixed(1)} GB`;
    if ($('vps-disk-usage')) $('vps-disk-usage').textContent = `${r.disk.used.toFixed(1)}/${r.disk.total.toFixed(1)} GB`;
    if ($('vps-ip')) $('vps-ip').textContent = s.ip;

    // Uptime
    const up = s.uptime;
    const days = Math.floor(up / 86400);
    const hours = Math.floor((up % 86400) / 3600);
    if ($('sys-uptime')) $('sys-uptime').textContent = `${days}d ${hours}h`;

    // Load
    if ($('sys-load')) $('sys-load').textContent = s.loadAvg.map(l => l.toFixed(2)).join(' ');

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
