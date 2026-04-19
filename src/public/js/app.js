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

  // Load state
  const saved = JSON.parse(sessionStorage.getItem('ks-ssh-terms') || '[]');
  if (saved.length) saved.forEach(s => terminals.restore(s.id, s.num));
  else if ($('empty-new-term')) $('empty-new-term').onclick = () => terminals.create();

  loadSystemInfo();
  setInterval(() => {
    loadSystemInfo();
    if (resMon.isOpen) resMon.poll();
  }, 5000);
}

function setupNavigation() {
  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.onclick = () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
      document.querySelectorAll('.sidebar-nav-item, .bnav-item').forEach(b => b.classList.remove('active'));

      $(`tab-${tab}`).classList.remove('hidden');
      document.querySelectorAll(`[data-tab="${tab}"]`).forEach(b => b.classList.add('active'));

      if (tab === 'files') files.load();
      if (tab === 'ports') ports.load();
      if (tab === 'terminals') terminals.refit();
    };
  });

  const toggle = $('sidebar-toggle');
  if (toggle) {
    toggle.onclick = () => {
      $('sidebar').classList.toggle('collapsed');
      setTimeout(() => terminals.refit(), 300);
    };
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
  socket.on('terminal:reconnect:fail', ({ id }) => {
    const t = terminals.terminals.get(id);
    if (t) {
      t.term.writeln('\r\n\x1b[33m[Session expired — starting new shell]\x1b[0m\r\n');
      socket.emit('terminal:create', { id, cols: t.term.cols, rows: t.term.rows });
    }
  });
}

function setupModals() {
  const input = $('term-close-input');
  if (input) {
    input.oninput = () => {
      const ok = input.value === 'KS SSH';
      $('term-close-confirm').disabled = !ok;
    };
  }
  const confirmBtn = $('term-close-confirm');
  if (confirmBtn) {
    confirmBtn.onclick = () => {
      if (terminals.pendingClose) {
        terminals.close(terminals.pendingClose);
        $('term-close-modal').classList.add('hidden');
      }
    };
  }
  const closeBtn = $('term-close-modal-x');
  if (closeBtn) closeBtn.onclick = () => $('term-close-modal').classList.add('hidden');

  const cancelBtn = $('term-close-cancel');
  if (cancelBtn) cancelBtn.onclick = () => $('term-close-modal').classList.add('hidden');

  const emptyBtn = $('empty-new-term');
  if (emptyBtn) emptyBtn.onclick = () => terminals.create();
}

function setupPortPreview() {
  window.openPortPreview = (port) => {
    $('port-preview-badge').textContent = ':' + port;
    $('port-preview-url').textContent = `localhost:${port}`;
    $('port-preview-iframe').src = `/ksapi/proxy/${port}/`;
    $('port-preview-panel').classList.remove('hidden');
  };
  const closeBtn = $('port-preview-close');
  if (closeBtn) {
    closeBtn.onclick = () => {
      $('port-preview-panel').classList.add('hidden');
      $('port-preview-iframe').src = 'about:blank';
    };
  }
}

async function loadSystemInfo() {
  try {
    const res = await fetch('/ksapi/system');
    const d = await res.json();
    $('sys-host').textContent = d.hostname;
    $('sp-host').textContent = d.hostname;
    $('sp-os').textContent = d.platform;
    $('sp-user').textContent = d.user;
    $('sp-cpus').textContent = d.cpus;
  } catch {}
}

init();
