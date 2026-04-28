import { $, showToast } from './utils.js';

export class TerminalManager {
  constructor(socket) {
    this.socket = socket;
    this.terminals = new Map();
    this.activeId = null;
    this.counter = 0;
    this.fontSize = 14;

    this._setupUI();
  }

  _setupUI() {
    $('empty-new-term')?.addEventListener('click', () => this.create());
    $('add-term-btn')?.addEventListener('click', () => this.create());
    $('t-clear-btn')?.addEventListener('click', () => this.clearActive());
    $('t-fit-btn')?.addEventListener('click', () => this.refit());
    $('t-download-btn')?.addEventListener('click', () => this.downloadActiveLog());
    $('t-copy-btn')?.addEventListener('click', () => this.copyActiveBuffer());
    $('t-font-inc')?.addEventListener('click', () => this.changeFontSize(1));
    $('t-font-dec')?.addEventListener('click', () => this.changeFontSize(-1));

    const searchInput = $('t-search-input');
    if (searchInput) {
      searchInput.onkeydown = (e) => {
        if (e.key === 'Enter') this.searchActive(searchInput.value);
      };
    }
    $('t-search-next')?.addEventListener('click', () => this.searchActive(searchInput.value));
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
    tab.className = 't-tab';
    tab.dataset.id = id;
    tab.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
      <span>bash (${num})</span>
      <button class="t-tab-close" title="Close Session">&times;</button>
    `;
    tab.onclick = (e) => { if (!e.target.closest('.t-tab-close')) this.activate(id); };
    tab.querySelector('.t-tab-close').onclick = (e) => { e.stopPropagation(); this.confirmClose(id); };
    tabList.appendChild(tab);

    const area = $('terminals-area');
    const container = document.createElement('div');
    container.className = 'terminal-instance';
    container.id = `ti-${id}`;
    area.appendChild(container);

    const term = new Terminal({
      cursorBlink: true,
      fontSize: this.fontSize,
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      theme: {
        background: '#000000',
        foreground: '#f8fafc',
        cursor: '#3b82f6',
        selection: 'rgba(59, 130, 246, 0.3)'
      },
      allowProposedApi: true
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(container);

    term.onData(data => {
      this.socket.emit('terminal:input', { id, data });
    });

    this.terminals.set(id, { term, fit, num, tab, container });

    $('terminals-empty').classList.add('hidden');
    $('terminal-toolbar').classList.remove('hidden');

    setTimeout(() => {
      fit.fit();
      if (restore) this.socket.emit('terminal:reconnect', { id, cols: term.cols, rows: term.rows });
      else this.socket.emit('terminal:create', { id, cols: term.cols, rows: term.rows });
    }, 100);

    this.activate(id);
    this._save();
  }

  activate(id) {
    if (this.activeId === id) return;
    this.activeId = id;

    this.terminals.forEach(t => {
      t.tab.classList.remove('active');
      t.container.classList.remove('active');
    });

    const t = this.terminals.get(id);
    if (!t) return;

    t.tab.classList.add('active');
    t.container.classList.add('active');
    $('t-session-name').textContent = `bash (${t.num})`;

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
    showToast(`Font size: ${this.fontSize}px`);
  }

  clearActive() {
    const t = this.terminals.get(this.activeId);
    if (t) {
      t.term.clear();
      showToast('Terminal cleared');
    }
  }

  searchActive(query) {
    if (!query) return;
    showToast(`Search not yet implemented: ${query}`, 'info');
  }

  copyActiveBuffer() {
    const t = this.terminals.get(this.activeId);
    if (!t) return;

    let content = "";
    const buffer = t.term.buffer.active;
    for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i);
        if (line) content += line.translateToString() + "\n";
    }

    navigator.clipboard.writeText(content).then(() => {
      showToast('Buffer copied to clipboard');
    }).catch(() => {
      showToast('Failed to copy', 'error');
    });
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
    a.download = `terminal-log-${t.num}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Log downloaded');
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
      if (keys.length > 0) {
        this.activate(keys[keys.length - 1]);
      } else {
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
