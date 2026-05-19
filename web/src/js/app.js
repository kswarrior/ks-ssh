import { TerminalManager } from './modules/terminal.js';
import { FileManager } from './modules/files.js';
import { PortScanner } from './modules/ports.js';
import { ResourceMonitor } from './modules/res-mon.js';
import { $, showToast, fmtBytes } from './modules/utils.js';

let socket, terminals, files, ports, resMon;
let startTime = Date.now();

class WSSocket {
    constructor() {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.ws = new WebSocket(`${proto}//${window.location.host}/ws`);
        this.handlers = {};
        this.ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            if (this.handlers[msg.type]) {
                this.handlers[msg.type](msg);
            }
        };
    }
    on(type, handler) {
        this.handlers[type] = handler;
    }
    emit(type, data) {
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type, ...data }));
        } else if (this.ws.readyState === WebSocket.CONNECTING) {
            this.ws.addEventListener('open', () => {
                this.ws.send(JSON.stringify({ type, ...data }));
            }, { once: true });
        }
    }
}

function init() {
  socket = new WSSocket();

  try {
      terminals = new TerminalManager(socket);
      window.terminalManager = terminals;
  } catch (e) { console.error("Terminal init failed", e); }

  try {
      files = new FileManager();
      window.fileManager = files;
  } catch (e) { console.error("File manager init failed", e); }

  try {
      ports = new PortScanner();
      window.portScanner = ports;
  } catch (e) { console.error("Port scanner init failed", e); }

  setupNavigation();
  setupSocket();
  setupModals();
  setupPortPreview();
  setupVPSInfo();
  setupSettings();
  setupDefaultPath();

  try {
      switchTab('terminals');
  } catch (e) { console.error("Initial tab switch failed", e); }

  try {
      if (terminals) terminals.restoreSessions();
  } catch (e) { console.error("Session restoration failed", e); }

  try {
      updateHUD();
      setInterval(() => {
          try { updateHUD(); } catch (e) {}
      }, 1000);
  } catch (e) { console.error("HUD update cycle failed", e); }

  setInterval(() => {
      try { checkLatency(); } catch (e) {}
  }, 2000);

  setInterval(() => {
      try { fetchTunnelInfo(); } catch (e) {}
  }, 30000);
  try { fetchTunnelInfo(); } catch (e) {}

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
  if (!terminals) return;

  const count = terminals.terminals ? terminals.terminals.size : 0;
  const empty = $('terminals-empty');
  const header = $('terminal-header-area');
  const keypad = $('terminal-keypad');
  const sbar = $('terminal-secondary-bar');
  const cbar = $('terminal-custom-bar');

  if (empty) empty.classList.toggle('hidden', count > 0);
  if (header) header.classList.toggle('hidden', count === 0);
  if (keypad) keypad.classList.toggle('hidden', count === 0);
  if (sbar) sbar.classList.toggle('hidden', count === 0);
  if (cbar) cbar.classList.toggle('hidden', count === 0);

  loadSystemInfo();
}

function setupNavigation() {
  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.onclick = (e) => {
        e.preventDefault();
        switchTab(btn.dataset.tab);
    };
  });
}

function switchTab(tab) {
  console.log("Switching to tab:", tab);
  const panels = document.querySelectorAll('.tab-panel');
  const items = document.querySelectorAll('.nav-item, .nav-link, .dock-item');

  panels.forEach(p => {
      p.classList.add('hidden');
      p.style.display = 'none';
  });
  items.forEach(b => b.classList.remove('active'));

  const targetPanel = $(`tab-${tab}`);
  if (targetPanel) {
    targetPanel.classList.remove('hidden');
    targetPanel.style.display = 'flex';
    document.querySelectorAll(`[data-tab="${tab}"]`).forEach(b => b.classList.add('active'));
  }

  if (tab === 'files' && files) {
    files.load();
  }
  if (tab === 'ports' && ports) {
    ports.load();
  }
  if (tab === 'terminals' && terminals) {
    setTimeout(() => terminals.refit(), 50);
  }
}

function setupSocket() {
  socket.on('terminal:data', ({ id, data }) => {
    const t = terminals.terminals.get(id);
    if (t) {
        t.term.write(data);
        const buffer = t.term.buffer.active;
        if (buffer.baseY + t.term.rows - buffer.viewportY >= -1) {
            t.term.scrollToBottom();
        }
    }
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
  $('port-preview-refresh')?.addEventListener('click', () => {
    const iframe = $('port-preview-iframe');
    if (iframe) iframe.src = iframe.src;
  });
}

function setupDefaultPath() {
    const modal = $('default-path-modal');
    const input = $('mini-cli-input');
    const output = $('mini-cli-output');
    let currentCwd = '/root';

    window.openDefaultPathModal = () => {
        modal.classList.remove('hidden');
        if ($('def-path-manual')) {
            $('def-path-manual').value = localStorage.getItem('ks-ssh-default-cwd') || '/root';
            currentCwd = $('def-path-manual').value;
        }
        if (output) output.textContent = `Current: ${currentCwd}`;
    };

    input?.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
            const cmd = input.value;
            input.value = '';
            try {
                const res = await fetch('/ksapi/files/cmd', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cmd, cwd: currentCwd })
                });
                const d = await res.json();
                if (d.success) {
                    currentCwd = d.cwd;
                    output.textContent = d.output || `Current: ${currentCwd}`;
                    $('def-path-manual').value = currentCwd;
                } else {
                    output.textContent = `Error: ${d.error}`;
                }
            } catch (err) {
                output.textContent = `Failed: ${err.message}`;
            }
        }
    });

    $('def-path-confirm')?.addEventListener('click', () => {
        const path = $('def-path-manual').value;
        localStorage.setItem('ks-ssh-default-cwd', path);
        showToast(`DEFAULT PATH SET: ${path}`);
        modal.classList.add('hidden');
    });
}

function setupSettings() {
    const btn = $('settings-btn');
    const modal = $('settings-modal');
    if (!btn || !modal) return;

    btn.onclick = () => modal.classList.remove('hidden');

    let saved = null;
    try {
        saved = localStorage.getItem('ks-ssh-settings');
    } catch (e) {}

    let settings = saved ? JSON.parse(saved) : {
        color: '#00a2ff',
        fontSize: 13,
        opacity: 0.85,
        termText: '#00a2ff',
        termBg: '#000000',
        termCursor: '#00a2ff',
        cursorStyle: 'block',
        cursorBlink: true,
        filesSize: 13,
        filesColor: '#ffffff',
        portsSize: 13,
        portsColor: '#ffffff'
    };

    const apply = (s) => {
        document.documentElement.style.setProperty('--electric-blue', s.color);
        document.documentElement.style.setProperty('--glass', `rgba(0, 0, 0, ${s.opacity})`);

        document.documentElement.style.setProperty('--files-fs', `${s.filesSize}px`);
        document.documentElement.style.setProperty('--files-color', s.filesColor);
        document.documentElement.style.setProperty('--ports-fs', `${s.portsSize}px`);
        document.documentElement.style.setProperty('--ports-color', s.portsColor);

        if (terminals) {
            terminals.changeFontSize(s.fontSize - terminals.fontSize);
            terminals.updateTheme({
                foreground: s.termText,
                background: s.termBg === '#000000' ? 'transparent' : s.termBg,
                cursor: s.termCursor
            });
            terminals.updateOptions({
                cursorStyle: s.cursorStyle,
                cursorBlink: s.cursorBlink
            });
        }

        if ($('font-size-val')) $('font-size-val').textContent = `${s.fontSize}px`;
        if ($('opacity-val')) $('opacity-val').textContent = s.opacity;
        if ($('settings-font-size')) $('settings-font-size').value = s.fontSize;
        if ($('settings-opacity')) $('settings-opacity').value = s.opacity;

        if ($('settings-term-text')) $('settings-term-text').value = s.termText;
        if ($('settings-term-bg')) $('settings-term-bg').value = s.termBg;
        if ($('settings-term-cursor')) $('settings-term-cursor').value = s.termCursor;
        if ($('settings-cursor-style')) $('settings-cursor-style').value = s.cursorStyle;
        if ($('settings-cursor-blink')) $('settings-cursor-blink').checked = s.cursorBlink;

        if ($('settings-files-size')) $('settings-files-size').value = s.filesSize;
        if ($('files-size-val')) $('files-size-val').textContent = `${s.filesSize}px`;
        if ($('settings-files-color')) $('settings-files-color').value = s.filesColor;

        if ($('settings-ports-size')) $('settings-ports-size').value = s.portsSize;
        if ($('ports-size-val')) $('ports-size-val').textContent = `${s.portsSize}px`;
        if ($('settings-ports-color')) $('settings-ports-color').value = s.portsColor;

        document.querySelectorAll('.color-swatch').forEach(sw => {
            sw.classList.toggle('active', sw.dataset.color === s.color);
            sw.style.border = sw.dataset.color === s.color ? '2px solid #fff' : 'none';
        });

        try {
            localStorage.setItem('ks-ssh-settings', JSON.stringify(s));
        } catch (e) {}
    };

    if ($('settings-font-size')) $('settings-font-size').oninput = (e) => { settings.fontSize = parseInt(e.target.value); apply(settings); };
    if ($('settings-opacity')) $('settings-opacity').oninput = (e) => { settings.opacity = parseFloat(e.target.value); apply(settings); };

    if ($('settings-term-text')) $('settings-term-text').oninput = (e) => { settings.termText = e.target.value; apply(settings); };
    if ($('settings-term-bg')) $('settings-term-bg').oninput = (e) => { settings.termBg = e.target.value; apply(settings); };
    if ($('settings-term-cursor')) $('settings-term-cursor').oninput = (e) => { settings.termCursor = e.target.value; apply(settings); };
    if ($('settings-cursor-style')) $('settings-cursor-style').onchange = (e) => { settings.cursorStyle = e.target.value; apply(settings); };
    if ($('settings-cursor-blink')) $('settings-cursor-blink').onchange = (e) => { settings.cursorBlink = e.target.checked; apply(settings); };

    if ($('settings-files-size')) $('settings-files-size').oninput = (e) => { settings.filesSize = parseInt(e.target.value); apply(settings); };
    if ($('settings-files-color')) $('settings-files-color').oninput = (e) => { settings.filesColor = e.target.value; apply(settings); };

    if ($('settings-ports-size')) $('settings-ports-size').oninput = (e) => { settings.portsSize = parseInt(e.target.value); apply(settings); };
    if ($('settings-ports-color')) $('settings-ports-color').oninput = (e) => { settings.portsColor = e.target.value; apply(settings); };

    document.querySelectorAll('.color-swatch').forEach(sw => {
        sw.onclick = () => { settings.color = sw.dataset.color; apply(settings); };
    });

    apply(settings);
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

const updateEl = (id, text) => {
    const el = $(id);
    if (el) el.textContent = text;
};

async function loadSystemInfo() {
  try {
    const sRes = await fetch('/ksapi/system');
    const s = await sRes.json();

    const rRes = await fetch('/ksapi/resources');
    const r = await rRes.json();

    updateEl('hdr-ram-pct', `${Math.round(r.ram.percent)}%`);

    const logoEl = $('vps-logo');
    if (logoEl) logoEl.textContent = s.logo || '\u{1F427}';

    updateEl('nf-user', s.user);
    updateEl('nf-host', s.hostname);
    updateEl('nf-os', s.osName);
    updateEl('nf-platform', `${s.platform} ${s.arch}`);
    updateEl('nf-kernel', s.kernel);
    updateEl('nf-packages', s.packages);
    updateEl('nf-shell', s.shell);
    updateEl('nf-cpu', `${r.cpu.model} (${r.cpu.count})`);
    updateEl('nf-mem', `${r.ram.used.toFixed(1)}GB / ${r.ram.total.toFixed(1)}GB`);
    updateEl('nf-ip', s.ip);

    const up = s.uptime;
    const days = Math.floor(up / 86400);
    const hours = Math.floor((up % 86400) / 3600);
    const mins = Math.floor((up % 3600) / 60);
    const uptimeEl = $('nf-uptime');
    if (uptimeEl) {
        let utStr = '';
        if (days > 0) utStr += `${days} days, `;
        if (hours > 0) utStr += `${hours} hours, `;
        utStr += `${mins} mins`;
        uptimeEl.textContent = utStr;
    }
  } catch (err) {
      console.error('HUD update error:', err);
  }
}

async function fetchTunnelInfo() {
  try {
    const res = await fetch('/ksapi/tunnel');
    const d = await res.json();
  } catch {}
}

function checkSecurity() {
    const official = 'ssh.ksw.workers.dev';
    let isAuthorized = false;

    if (window.location.hostname === official ||
        window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1' ||
        window.location.hostname.includes('devbox')) {
        isAuthorized = true;
    }

    try {
        if (window.top && window.top.location.hostname === official) {
            isAuthorized = true;
        }
    } catch (e) {
        try {
            if (document.referrer && new URL(document.referrer).hostname === official) {
                isAuthorized = true;
            }
        } catch (e2) {}
    }

    if (!isAuthorized) {
        const overlay = document.createElement('div');
        overlay.className = 'security-lock';
        overlay.style.display = 'flex';
        overlay.innerHTML = `
            <div class="lock-content">
                <div class="lock-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                        <line x1="12" y1="9" x2="12" y2="13"></line>
                        <line x1="12" y1="17" x2="12.01" y2="17"></line>
                    </svg>
                </div>
                <h1 class="lock-title">UNAUTHORIZED DOMAIN</h1>
                <p class="lock-text">This HUD is running on an insecure or unauthorized mirror. To protect your data and credentials, please use the official terminal.</p>
                <div class="lock-action">
                    <a href="https://ssh.ksw.workers.dev/" class="btn-primary">ACCESS OFFICIAL HUD</a>
                </div>
                <div class="lock-footer">
                    \u{00A9}\u{FE0F} KS Warrior
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
    } else {
        const app = $('app');
        if (app) app.style.display = 'grid';
    }
}

window.switchTab = switchTab;

window.addEventListener('DOMContentLoaded', () => {
    try {
        checkSecurity();
        init();
    } catch (e) {
        console.error("FATAL INITIALIZATION ERROR", e);
        const app = $('app');
        if (app) app.style.display = 'grid';
    }
});
