import { $, showToast } from './utils.js';

export class TerminalManager {
  constructor(socket) {
    this.socket = socket;
    this.terminals = new Map();
    this.activeId = null;
    this.counter = 0;
    this.ctrlActive = false;
    this.altActive = false;
  }

  create(data = {}) {
    this.counter++;
    const id = data.id || `term-${Date.now()}`;
    this._spawn({ id, num: this.counter, restore: false });
    return id;
  }

  restore(id, num) {
    if (num > this.counter) this.counter = num;
    this._spawn({ id, num, restore: true });
  }

  _spawn({ id, num, restore }) {
    const wrapper = this._getWrapper();
    const tabBar = wrapper.querySelector('.terminal-tab-bar');
    const body = wrapper.querySelector('.terminal-body');

    // Create Tab
    const tab = document.createElement('div');
    tab.className = 'term-tab';
    tab.dataset.id = id;
    tab.innerHTML = `
      <span class="term-tab-num">${num}</span>
      <button class="term-tab-close">&times;</button>
    `;
    tab.onclick = (e) => { if (!e.target.closest('.term-tab-close')) this.activate(id); };
    tab.querySelector('.term-tab-close').onclick = (e) => { e.stopPropagation(); this.confirmClose(id); };
    tabBar.insertBefore(tab, tabBar.querySelector('.new-tab-btn'));

    // Create Container
    const container = document.createElement('div');
    container.className = 'terminal-container';
    container.id = `tc-${id}`;
    body.appendChild(container);

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"JetBrains Mono", monospace',
      theme: { background: '#000000' },
      allowProposedApi: true
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(container);

    term.onData(data => {
      let out = data;
      if (this.ctrlActive && data.length === 1) {
        out = String.fromCharCode(data.charCodeAt(0) & 0x1f);
        this.ctrlActive = false;
        this._updateKbd();
      } else if (this.altActive && data.length === 1) {
        out = '\x1b' + data;
        this.altActive = false;
        this._updateKbd();
      }
      this.socket.emit('terminal:input', { id, data: out });
    });

    this.terminals.set(id, { term, fit, num, tab, container });
    $('terminals-empty').style.display = 'none';

    setTimeout(() => {
      fit.fit();
      if (restore) this.socket.emit('terminal:reconnect', { id, cols: term.cols, rows: term.rows });
      else this.socket.emit('terminal:create', { id, cols: term.cols, rows: term.rows });
    }, 100);

    this.activate(id);
    this._save();
  }

  activate(id) {
    this.activeId = id;
    this.terminals.forEach(t => { t.tab.classList.remove('active'); t.container.classList.remove('active'); });
    const t = this.terminals.get(id);
    if (!t) return;
    t.tab.classList.add('active');
    t.container.classList.add('active');
    setTimeout(() => { t.fit.fit(); t.term.focus(); }, 20);
  }

  confirmClose(id) {
    this.pendingClose = id;
    $('term-close-modal').classList.remove('hidden');
    $('term-close-input').value = '';
    $('term-close-confirm').disabled = true;
  }

  close(id) {
    const t = this.terminals.get(id);
    if (!t) return;
    this.socket.emit('terminal:kill', { id });
    t.term.dispose(); t.tab.remove(); t.container.remove();
    this.terminals.delete(id);
    this._save();
    if (this.activeId === id) {
      const remaining = [...this.terminals.keys()];
      if (remaining.length) this.activate(remaining[remaining.length - 1]);
      else { this.activeId = null; $('terminals-empty').style.display = ''; this._getWrapper()?.remove(); }
    }
  }

  _getWrapper() {
    let w = document.querySelector('.terminal-wrapper');
    if (!w) {
      w = document.createElement('div');
      w.className = 'terminal-wrapper active';
      w.innerHTML = `
        <div class="terminal-tab-bar">
          <button class="new-tab-btn">+</button>
        </div>
        <div class="terminal-body"></div>
      `;
      w.querySelector('.new-tab-btn').onclick = () => this.create();
      $('terminals-area').appendChild(w);
      new ResizeObserver(() => this.refit()).observe(w.querySelector('.terminal-body'));
    }
    return w;
  }

  refit() {
    if (this.activeId) {
      const t = this.terminals.get(this.activeId);
      if (t) { t.fit.fit(); this.socket.emit('terminal:resize', { id: this.activeId, cols: t.term.cols, rows: t.term.rows }); }
    }
  }

  _save() {
    const data = [...this.terminals.entries()].map(([id, t]) => ({ id, num: t.num }));
    sessionStorage.setItem('ks-ssh-terms', JSON.stringify(data));
  }

  _updateKbd() {
    const cb = $('kbd-ctrl'), ab = $('kbd-alt');
    if (cb) cb.classList.toggle('on', this.ctrlActive);
    if (ab) ab.classList.toggle('on', this.altActive);
  }

  sendKbdKey(key) {
    if (!this.activeId) return;
    const t = this.terminals.get(this.activeId);
    if (!t) return;

    if (key === 'CTRL') { this.ctrlActive = !this.ctrlActive; this.altActive = false; this._updateKbd(); return; }
    if (key === 'ALT')  { this.altActive = !this.altActive; this.ctrlActive = false; this._updateKbd(); return; }

    let data = key;
    if (this.ctrlActive) {
      if (key.length === 1) data = String.fromCharCode(key.charCodeAt(0) & 0x1f);
      this.ctrlActive = false;
      this._updateKbd();
    } else if (this.altActive) {
      data = '\x1b' + key;
      this.altActive = false;
      this._updateKbd();
    }
    this.socket.emit('terminal:input', { id: this.activeId, data });
    t.term.focus();
  }
}
