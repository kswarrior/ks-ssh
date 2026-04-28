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
      const panels = document.querySelectorAll('.tab-panel');
      const items = document.querySelectorAll('.sidebar-nav-item, .bnav-item');

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
    };
  });

  const toggle = $('sidebar-toggle');
  if (toggle) {
    toggle.onclick = () => {
      $('sidebar').classList.toggle('collapsed');
      // Optimistic refit: don't wait too long
      setTimeout(() => terminals.refit(), 100);
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
    if ($('sys-host')) $('sys-host').textContent = d.hostname;
    if ($('sp-host')) $('sp-host').textContent = d.hostname;
    if ($('sp-os')) $('sp-os').textContent = d.platform;
    if ($('sp-user')) $('sp-user').textContent = d.user;
    if ($('sp-cpus')) $('sp-cpus').textContent = d.cpus;
  } catch {}
}

init();
