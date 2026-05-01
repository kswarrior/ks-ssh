import { $, showToast } from './utils.js';

export class TerminalManager {
  constructor(socket) {
    this.socket = socket;
    this.terminals = new Map();
    this.activeId = null;
    this.splitActive = false;
    this.counter = 0;
    this.fontSize = 13;
    this.ctrlActive = false;
    this.altActive = false;

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
    $('t-rename-btn')?.addEventListener('click', () => this.renameActive());
    $('t-kill-all')?.addEventListener('click', () => this.killAll());
    $('t-split-btn')?.addEventListener('click', () => this.toggleSplit());
    $('t-session-name')?.addEventListener('click', () => this.renameActive());

    window.addEventListener('keydown', (e) => {
      if (e.altKey && e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key) - 1;
        const keys = Array.from(this.terminals.keys());
        if (keys[idx]) this.activate(keys[idx]);
      }
    });

    // Mobile Keys
    document.querySelectorAll('.kbd-key').forEach(btn => {
        btn.onclick = (e) => {
            e.preventDefault();
            this.handleVirtualKey(btn.dataset.key);
        };
    });

    if (window.innerWidth <= 768) {
        $('mobile-kbd-bar').style.display = 'flex';
    }
  }

  handleVirtualKey(key) {
    if (!this.activeId) return;
    const id = this.activeId;

    let data = null;
    switch(key) {
        case 'CTRL':
            this.ctrlActive = !this.ctrlActive;
            document.querySelector('.kbd-key[data-key="CTRL"]').classList.toggle('active', this.ctrlActive);
            return;
        case 'ALT':
            this.altActive = !this.altActive;
            document.querySelector('.kbd-key[data-key="ALT"]').classList.toggle('active', this.altActive);
            return;
        case 'TAB': data = '\t'; break;
        case 'ESC': data = '\x1b'; break;
        case 'UP': data = '\x1b[A'; break;
        case 'DOWN': data = '\x1b[B'; break;
        case 'LEFT': data = '\x1b[D'; break;
        case 'RIGHT': data = '\x1b[C'; break;
    }

    if (data) this.socket.emit('terminal:input', { id, data });
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

  _spawn({ id, num, restore, name }) {
    const tabList = $('terminal-tabs-list');
    const tab = document.createElement('div');
    tab.className = 'hud-t-tab';
    tab.dataset.id = id;
    const displayName = name || num;
    tab.innerHTML = `
      <span class="tab-label">${displayName}</span>
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
        foreground: '#06b6d4',
        cursor: '#06b6d4',
        selection: 'rgba(6, 182, 212, 0.3)'
      },
      allowProposedApi: true
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(container);

    term.onData(data => {
        if (this.ctrlActive) {
            // CTRL + Key logic
            const code = data.charCodeAt(0);
            if (code >= 97 && code <= 122) { // a-z
                data = String.fromCharCode(code - 96);
            }
            this.ctrlActive = false;
            document.querySelector('.kbd-key[data-key="CTRL"]').classList.remove('active');
        }
        if (this.altActive) {
            data = '\x1b' + data;
            this.altActive = false;
            document.querySelector('.kbd-key[data-key="ALT"]').classList.remove('active');
        }
        this.socket.emit('terminal:input', { id, data });
    });

    this.terminals.set(id, { term, fit, num, name: displayName, tab, container });

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
    if (this.activeId === id && !this.splitActive) return;
    this.activeId = id;

    if (!this.splitActive) {
        this.terminals.forEach(t => {
            t.tab.classList.remove('active');
            t.container.style.display = 'none';
            t.container.style.width = '100%';
            t.container.style.left = '0';
            t.container.classList.remove('active');
        });
    } else {
        // Handle split logic: Active is always right if 2+ exist
        const keys = Array.from(this.terminals.keys());
        if (keys.length >= 2) {
            const leftId = keys[0];
            const rightId = id;
            this.terminals.forEach((t, tid) => {
                t.tab.classList.remove('active');
                if (tid === leftId) {
                    t.container.style.display = 'block';
                    t.container.style.width = '50%';
                    t.container.style.left = '0';
                    t.container.style.borderRight = '1px solid var(--glass-border)';
                } else if (tid === rightId) {
                    t.tab.classList.add('active');
                    t.container.style.display = 'block';
                    t.container.style.width = '50%';
                    t.container.style.left = '50%';
                    t.container.style.borderRight = 'none';
                } else {
                    t.container.style.display = 'none';
                }
            });
        }
    }

    const t = this.terminals.get(id);
    if (!t) return;

    if (!this.splitActive) {
        t.tab.classList.add('active');
        t.container.style.display = 'block';
    }

    t.container.classList.add('active');
    const displayNum = t.num.toString().padStart(2, '0');
    $('t-session-name').textContent = `${t.name === t.num ? 'SESSION' : t.name.toUpperCase()}: ${displayNum} [ONLINE] ${this.splitActive ? '(SPLIT)' : ''}`;

    setTimeout(() => {
      this.terminals.forEach(termObj => { if (termObj.container.style.display === 'block') termObj.fit.fit(); });
      t.term.focus();
    }, 50);
  }

  toggleSplit() {
      if (this.terminals.size < 2) { showToast('NEED 2+ TERMINALS FOR SPLIT', 'info'); return; }
      this.splitActive = !this.splitActive;
      $('t-split-btn').classList.toggle('active', this.splitActive);
      this.activate(this.activeId);
  }

  renameActive() {
    const t = this.terminals.get(this.activeId);
    if (!t) return;
    const newName = prompt('Enter session name:', t.name === t.num ? '' : t.name);
    if (newName !== null) {
      t.name = newName.trim() || t.num;
      t.tab.querySelector('.tab-label').textContent = t.name;
      this.activate(this.activeId); // Refresh toolbar text
      this._save();
    }
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

  killAll() {
    if (confirm('Kill all active sessions?')) {
      [...this.terminals.keys()].forEach(id => this.close(id));
      showToast('ALL SESSIONS TERMINATED');
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
    const data = [...this.terminals.entries()].map(([id, t]) => ({ id, num: t.num, name: t.name }));
    sessionStorage.setItem('ks-ssh-terms', JSON.stringify(data));
  }
}
