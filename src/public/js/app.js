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
  setupKeyboardBar();

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
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
      document.querySelectorAll('.sidebar-nav-item, .bnav-item').forEach(b => b.classList.remove('active'));

      $(`tab-${tab}`).classList.remove('hidden');
      document.querySelectorAll(`[data-tab="${tab}"]`).forEach(b => b.classList.add('active'));

      if (tab === 'files') files.load();
      if (tab === 'ports') ports.load();
      if (tab === 'terminals') terminals.refit();
    };
  });

  $('sidebar-toggle').onclick = () => {
    $('sidebar').classList.toggle('collapsed');
    setTimeout(() => terminals.refit(), 300);
  };
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
  socket.on('tunnel:url', (data) => {
    showToast('Tunnel Connected!', 'success');
  });
}

function setupModals() {
  $('term-close-input').oninput = () => {
    const ok = $('term-close-input').value === 'KS SSH';
    $('term-close-confirm').disabled = !ok;
  };
  $('term-close-confirm').onclick = () => {
    if (terminals.pendingClose) {
      terminals.close(terminals.pendingClose);
      $('term-close-modal').classList.add('hidden');
    }
  };
  $('term-close-modal-x').onclick = () => $('term-close-modal').classList.add('hidden');
  $('term-close-cancel').onclick = () => $('term-close-modal').classList.add('hidden');

  $('empty-new-term').onclick = () => terminals.create();
}

function setupPortPreview() {
  window.openPortPreview = (port) => {
    $('port-preview-badge').textContent = ':' + port;
    $('port-preview-url').textContent = `localhost:${port}`;
    $('port-preview-iframe').src = `/ksapi/proxy/${port}/`;
    $('port-preview-panel').classList.remove('hidden');
  };
  $('port-preview-close').onclick = () => {
    $('port-preview-panel').classList.add('hidden');
    $('port-preview-iframe').src = 'about:blank';
  };
}

function setupKeyboardBar() {
  const kbdKeys = [
    { label: 'ESC', key: '\x1b' }, { label: 'TAB', key: '\t' },
    { label: 'CTRL', key: 'CTRL', id: 'kbd-ctrl' }, { label: 'ALT', key: 'ALT', id: 'kbd-alt' },
    { label: '↑', key: '\x1b[A' }, { label: '↓', key: '\x1b[B' },
    { label: '←', key: '\x1b[D' }, { label: '→', key: '\x1b[C' }
  ];

  const bar = document.createElement('div');
  bar.className = 'mobile-kbd-bar';
  kbdKeys.forEach(k => {
    const b = document.createElement('button');
    b.className = 'kbd-key';
    b.textContent = k.label;
    if (k.id) b.id = k.id;
    b.onclick = () => terminals.sendKbdKey(k.key);
    bar.appendChild(b);
  });

  // Insert into terminals area (will be managed by TerminalManager in future refactor)
  // For now, simple injection if terminals wrapper exists
  const target = qs('.terminal-wrapper');
  if (target) target.insertBefore(bar, target.querySelector('.terminal-body'));
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
