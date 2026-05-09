import { $, showToast } from './utils.js';

export class TerminalManager {
  constructor(socket) {
    this.socket = socket;
    this.terminals = new Map();
    this.activeId = null;
    this.counter = 0;
    this.fontSize = 13;

    this._setupUI();
  }

  _setupUI() {
    $('empty-new-term')?.addEventListener('click', () => this.create());
    $('add-term-btn')?.addEventListener('click', () => this.create());
    $('t-clear-btn')?.addEventListener('click', () => this.clearActive());
    $('t-fit-btn')?.addEventListener('click', () => this.refit());
    $('t-download-btn')?.addEventListener('click', () => this.downloadActiveLog());
    $('t-font-inc')?.addEventListener('click', () => this.changeFontSize(1));
    $('t-font-dec')?.addEventListener('click', () => this.changeFontSize(-1));

    this._setupKeypad();
  }

  _setupKeypad() {
    this.modifiers = { ctrl: false, alt: false };
    document.querySelectorAll('.t-key').forEach(btn => {
      btn.onclick = (e) => {
        const key = btn.dataset.key;
        if (btn.classList.contains('key-toggle')) {
          this.modifiers[key] = !this.modifiers[key];
          btn.classList.toggle('active', this.modifiers[key]);
        } else {
          this.sendKey(key);
          // If we had modifiers active and it was a non-toggle key, maybe clear them?
          // Usually CTRL/ALT stay active until manually toggled off in mobile shells.
          // But for now let's just send the key.
        }
      };
    });
  }

  sendKey(key) {
    const t = this.terminals.get(this.activeId);
    if (!t) return;

    let code = '';
    switch (key) {
      case 'esc': code = '\x1b'; break;
      case 'tab': code = '\t'; break;
      case 'backspace': code = '\x7f'; break;
      case 'delete': code = '\x1b[3~'; break;
      case 'arrowup': code = '\x1b[A'; break;
      case 'arrowdown': code = '\x1b[B'; break;
      case 'arrowright': code = '\x1b[C'; break;
      case 'arrowleft': code = '\x1b[D'; break;
    }

    if (this.modifiers.ctrl || this.modifiers.alt) {
        // This is complex for all keys, but for basic ones:
        // Handled by xterm.js usually, but we are manually sending data.
        // For simplicity, if CTRL is on and it's a key like 'c' (not handled here yet), we'd need more.
        // The keypad only has special keys for now.
    }

    if (code) {
        let finalCode = code;
        // Basic modifier support for arrows etc could be added here if needed
        this.socket.emit('terminal:input', { id: this.activeId, data: finalCode });
    }

    t.term.focus();
  }

  create(data = {}) {
    const id = data.id || `term-${Date.now()}`;
    this.counter++;
    this._spawn({ id, num: this.counter, restore: false });
    return id;
  }

  restore(id, num) {
    if (num > this.counter) this.counter = num;
    this._spawn({ id, num, restore: true });
  }

  _spawn({ id, num, restore }) {
    const tabList = $('terminal-tabs-list');
    const tab = document.createElement('div');
    tab.className = 'hud-t-tab';
    tab.dataset.id = id;
    tab.innerHTML = `
      <span>${num}</span>
      <button class="hud-t-tab-close" style="background:none; border:none; color:inherit; cursor:pointer; margin-left:8px; font-size:14px; line-height:1;">&times;</button>
    `;
    tab.onclick = (e) => { if (!e.target.closest('.hud-t-tab-close')) this.activate(id); };
    tab.querySelector('.hud-t-tab-close').onclick = (e) => { e.stopPropagation(); this.confirmClose(id); };
    tabList.appendChild(tab);

    const area = $('terminals-area');
    const container = document.createElement('div');
    container.style.cssText = "position:absolute; inset:0; display:none;";
    container.className = 'terminal-instance';
    container.id = `ti-${id}`;

    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton-term';
    skeleton.innerHTML = `
        <div class="skeleton skeleton-line short"></div>
        <div class="skeleton skeleton-line mid"></div>
        <div class="skeleton skeleton-line"></div>
    `;
    container.appendChild(skeleton);
    area.appendChild(container);

    const term = new Terminal({
      cursorBlink: true,
      fontSize: this.fontSize,
      fontFamily: '"JetBrains Mono", monospace',
      theme: {
        background: 'transparent',
        foreground: '#00a2ff',
        cursor: '#00a2ff',
        selection: 'rgba(0, 162, 255, 0.3)',
        black: '#000000',
        brightBlack: '#666666'
      },
      allowProposedApi: true
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(container);

    term.onData(data => this.socket.emit('terminal:input', { id, data }));

    this.terminals.set(id, { term, fit, num, tab, container });

    $('terminals-empty').classList.add('hidden');
    $('terminal-toolbar').classList.remove('hidden');

    setTimeout(() => {
      skeleton.remove();
      fit.fit();
      if (restore) this.socket.emit('terminal:reconnect', { id, cols: term.cols, rows: term.rows });
      else this.socket.emit('terminal:create', { id, cols: term.cols, rows: term.rows });
    }, 1000); // 1s artificial delay to show skeleton

    this.activate(id);
    this._save();
  }

  activate(id) {
    if (this.activeId === id) return;
    this.activeId = id;

    this.terminals.forEach(t => {
      t.tab.classList.remove('active');
      t.container.style.display = 'none';
      t.container.classList.remove('active');
    });

    const t = this.terminals.get(id);
    if (!t) return;

    t.tab.classList.add('active');
    t.container.style.display = 'block';
    t.container.classList.add('active');
    $('t-session-name').textContent = `SESSION: ${t.num.toString().padStart(2, '0')} STATUS: ONLINE`;

    setTimeout(() => {
      t.fit.fit();
      t.term.focus();
    }, 50);
  }

  changeFontSize(delta) {
    this.fontSize = Math.max(8, Math.min(32, this.fontSize + delta));
    this.terminals.forEach(t => {
      t.term.options.fontSize = this.fontSize;
      setTimeout(() => t.fit.fit(), 20);
    });
  }

  clearActive() {
    const t = this.terminals.get(this.activeId);
    if (t) { t.term.clear(); showToast('HUD BUFFER CLEARED'); }
  }

  downloadActiveLog() {
    const t = this.terminals.get(this.activeId);
    if (!t) return;
    let content = "";
    const buffer = t.term.buffer.active;
    for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i);
        if (line) content += line.translateToString() + "\n";
    }
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `uplink-${t.num}-log.txt`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('LOG DOWNLOADED');
  }

  confirmClose(id) {
    this.pendingClose = id;
    $('term-close-modal').classList.remove('hidden');
    $('term-close-input').value = '';
    $('term-close-input').focus();
    $('term-close-confirm').disabled = true;
  }

  close(id) {
    const t = this.terminals.get(id);
    if (!t) return;
    this.socket.emit('terminal:kill', { id });
    t.term.dispose();
    t.tab.remove();
    t.container.remove();
    this.terminals.delete(id);
    this._save();
    if (this.activeId === id) {
      const keys = Array.from(this.terminals.keys());
      if (keys.length > 0) this.activate(keys[keys.length - 1]);
      else {
        this.activeId = null;
        $('terminals-empty').classList.remove('hidden');
        $('terminal-toolbar').classList.add('hidden');
      }
    }
  }

  refit() {
    if (this.activeId) {
      const t = this.terminals.get(this.activeId);
      if (t) {
        t.fit.fit();
        this.socket.emit('terminal:resize', { id: this.activeId, cols: t.term.cols, rows: t.term.rows });
      }
    }
  }

  _save() {
    const data = [...this.terminals.entries()].map(([id, t]) => ({ id, num: t.num }));
    sessionStorage.setItem('ks-ssh-terms', JSON.stringify(data));
  }
}
