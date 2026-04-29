import { TerminalManager } from './modules/terminal.js';
import { FileManager } from './modules/files.js';
import { PortScanner } from './modules/ports.js';
import { ResourceMonitor } from './modules/res-mon.js';
import { $, showToast } from './modules/utils.js';

let socket, terminals, files, ports, resMon;

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

  loadSystemInfo();
  setInterval(() => {
    loadSystemInfo();
    if (resMon.isOpen) resMon.poll();
  }, 5000);

  $('info-btn')?.addEventListener('click', () => {
    showToast('KS-SSH Next-Gen v1.1.0', 'info');
  });
}

function setupNavigation() {
  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.onclick = () => switchTab(btn.dataset.tab);
  });
}

function switchTab(tab) {
  const panels = document.querySelectorAll('.tab-panel');
  const items = document.querySelectorAll('.nav-item, .dock-item');

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
    setTimeout(() => terminals.refit(), 100);
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
    if ($('sys-host')) $('sys-host').textContent = d.hostname;
    if ($('sp-os')) $('sp-os').textContent = d.platform;
    if ($('sp-user')) $('sp-user').textContent = d.user;
  } catch {}
}

init();
