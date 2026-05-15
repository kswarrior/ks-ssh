import { $, showToast } from './utils.js';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';

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

    $('t-scrollback-btn')?.addEventListener('click', () => this.clearActive());
    $('t-download-log')?.addEventListener('click', () => this.downloadLog());

    // Custom Actions
    $('add-custom-action-btn')?.addEventListener('click', () => this.showActionPanel());
    $('action-cancel-btn')?.addEventListener('click', () => this.hideActionPanel());
    $('action-save-btn')?.addEventListener('click', () => this.saveCustomAction());

    try {
        this.customActions = JSON.parse(localStorage.getItem('ks-ssh-custom-actions') || '[]');
    } catch (e) {
        this.customActions = [];
    }
    this.renderCustomActions();

    this._setupKeypad();
  }

  showActionPanel(action = null) {
      this.editingActionId = action ? action.id : null;
      $('terminal-action-panel')?.classList.remove('hidden');
      if ($('action-label')) $('action-label').value = action ? action.label : '';
      if ($('action-code')) $('action-code').value = action ? action.code : '';
      if ($('action-type')) $('action-type').value = action ? action.type : 'code';
      if ($('action-save-btn')) $('action-save-btn').textContent = action ? 'UPDATE ACTION' : 'SAVE ACTION';
  }

  hideActionPanel() {
      $('terminal-action-panel')?.classList.add('hidden');
  }

  saveCustomAction() {
      const label = $('action-label')?.value;
      const code = $('action-code')?.value;
      const type = $('action-type')?.value;

      if (!label || !code) return;

      if (this.editingActionId) {
          const idx = this.customActions.findIndex(a => a.id === this.editingActionId);
          if (idx !== -1) this.customActions[idx] = { ...this.customActions[idx], label, code, type };
          showToast('ACTION UPDATED');
      } else {
          this.customActions.push({ label, code, type, id: Date.now() });
          showToast('ACTION SAVED');
      }

      try {
          localStorage.setItem('ks-ssh-custom-actions', JSON.stringify(this.customActions));
      } catch (e) {}
      this.renderCustomActions();
      this.hideActionPanel();
  }

  renderCustomActions() {
      const list = $('custom-actions-list');
      if (!list) return;
      list.innerHTML = '';

      this.customActions.forEach(action => {
          const btn = document.createElement('button');
          btn.className = 't-key';
          btn.style.minWidth = 'auto';
          btn.style.padding = '0 10px';
          btn.textContent = action.label.toUpperCase();

          let holdTimer;
          const startHold = () => {
              holdTimer = setTimeout(() => {
                  this.showActionContextMenu(action, btn);
              }, 600);
          };
          const clearHold = () => clearTimeout(holdTimer);

          btn.onclick = () => {
              if (this.isHolding) return;
              this.executeCustomAction(action);
          };
          btn.onmousedown = startHold;
          btn.onmouseup = clearHold;
          btn.onmouseleave = clearHold;
          btn.ontouchstart = startHold;
          btn.ontouchend = clearHold;

          btn.oncontextmenu = (e) => {
              e.preventDefault();
              this.showActionContextMenu(action, btn);
          };

          list.appendChild(btn);
      });
  }

  showActionContextMenu(action, btn) {
      this.isHolding = true;
      setTimeout(() => this.isHolding = false, 300);

      const menu = document.createElement('div');
      menu.className = 'context-menu';
      menu.style.left = btn.getBoundingClientRect().left + 'px';
      menu.style.top = (btn.getBoundingClientRect().bottom + 5) + 'px';

      menu.innerHTML = `
          <div class="menu-item" id="act-edit">EDIT</div>
          <div class="menu-item danger" id="act-delete">DELETE</div>
      `;

      document.body.appendChild(menu);

      menu.querySelector('#act-edit').onclick = () => {
          this.showActionPanel(action);
          menu.remove();
      };
      menu.querySelector('#act-delete').onclick = () => {
          if (confirm(`PURGE "${action.label}"?`)) {
              this.customActions = this.customActions.filter(a => a.id !== action.id);
              try {
                  localStorage.setItem('ks-ssh-custom-actions', JSON.stringify(this.customActions));
              } catch (e) {}
              this.renderCustomActions();
          }
          menu.remove();
      };

      const closeMenu = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', closeMenu); } };
      setTimeout(() => document.addEventListener('click', closeMenu), 10);
  }

  executeCustomAction(action) {
      if (action.type === 'code') {
          this.socket.emit('terminal:input', { id: this.activeId, data: action.code + '\n' });
      } else if (action.type === 'timer') {
          const sec = parseInt(action.code);
          if (isNaN(sec)) return;
          showToast(`TIMER STARTED: ${sec}s`);
          setTimeout(() => {
              showToast(`TIMER ELAPSED: ${action.label}`, 'info');
              // Play a sound or notify?
          }, sec * 1000);
      }
  }

  _setupKeypad() {
    this.modifiers = { ctrl: false, alt: false };
    document.querySelectorAll('.t-key[data-key]').forEach(btn => {
      btn.onclick = (e) => {
        const key = btn.dataset.key;
        if (btn.classList.contains('key-toggle')) {
          this.modifiers[key] = !this.modifiers[key];
          btn.classList.toggle('active', this.modifiers[key]);
        } else {
          this.sendKey(key);
        }
      };
    });
  }

  sendKey(key) {
    const t = this.terminals.get(this.activeId);
    if (!t) return;

    let code = '';

    if ((this.modifiers.ctrl && key === 'c') || key === 'ctrl-c') {
        code = '\x03';
        if (key === 'ctrl-c') {
            this.modifiers.ctrl = false;
            document.querySelectorAll('.t-key[data-key="ctrl"]').forEach(b => b.classList.remove('active'));
        }
    } else {
        switch (key) {
            case 'esc': code = '\x1b'; break;
            case 'tab': code = '\t'; break;
            case 'backspace': code = '\x7f'; break;
            case 'arrowup': code = '\x1b[A'; break;
            case 'arrowdown': code = '\x1b[B'; break;
            case 'arrowright': code = '\x1b[C'; break;
            case 'arrowleft': code = '\x1b[D'; break;
            case 'c': code = 'c'; break;
        }
    }

    if (code) {
        this.socket.emit('terminal:input', { id: this.activeId, data: code });
    }

    t.term.focus();
  }

  create(data = {}) {
    const id = data.id || `term-${Date.now()}`;
    if (!data.cwd) {
        data.cwd = localStorage.getItem('ks-ssh-default-cwd');
    }
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
    if (!tabList) return;
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
    if (!area) return;
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
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    term.onData(data => {
        if (this.modifiers.ctrl) {
            // Handle CTRL modifier for text input
            if (data.length === 1) {
                const charCode = data.charCodeAt(0);
                // Convert a-z to 1-26 (Control codes)
                if (charCode >= 97 && charCode <= 122) { // a-z
                    data = String.fromCharCode(charCode - 96);
                } else if (charCode >= 65 && charCode <= 90) { // A-Z
                    data = String.fromCharCode(charCode - 64);
                }
            }
            this.modifiers.ctrl = false;
            document.querySelector('.t-key[data-key="ctrl"]')?.classList.remove('active');
        }
        this.socket.emit('terminal:input', { id, data });
    });

    this.terminals.set(id, { term, fit, num, tab, container });

    $('terminals-empty')?.classList.add('hidden');
    $('terminal-header-area')?.classList.remove('hidden');
    $('terminal-keypad')?.classList.remove('hidden');

    setTimeout(() => {
      skeleton.remove();
      fit.fit();
      if (restore) this.socket.emit('terminal:reconnect', { id, cols: term.cols, rows: term.rows });
      else this.socket.emit('terminal:create', { id, cols: term.cols, rows: term.rows });
    }, 500);

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

  downloadLog() {
      const t = this.terminals.get(this.activeId);
      if (!t) return;
      const entries = t.term.buffer.active;
      let text = '';
      for (let i = 0; i < entries.length; i++) {
          text += entries.getLine(i).translateToString() + '\n';
      }
      const blob = new Blob([text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `terminal-${this.activeId}-log.txt`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('LOG DOWNLOADED');
  }

  confirmClose(id) {
    this.pendingClose = id;
    $('term-close-modal')?.classList.remove('hidden');
    if ($('term-close-input')) {
        $('term-close-input').value = '';
        $('term-close-input').focus();
    }
    if ($('term-close-confirm')) $('term-close-confirm').disabled = true;
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
        $('terminals-empty')?.classList.remove('hidden');
        $('terminal-header-area')?.classList.add('hidden');
        $('terminal-keypad')?.classList.add('hidden');
      }
    }
  }

  updateTheme(theme) {
      this.terminals.forEach(t => {
          t.term.options.theme = {
              ...t.term.options.theme,
              ...theme
          };
      });
  }

  updateOptions(options) {
      this.terminals.forEach(t => {
          Object.keys(options).forEach(key => {
              t.term.options[key] = options[key];
          });
      });
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
    try {
        localStorage.setItem('ks-ssh-terms', JSON.stringify(data));
    } catch (e) {}
  }

  restoreSessions() {
    let data = null;
    try {
        data = localStorage.getItem('ks-ssh-terms');
    } catch (e) {}

    if (data) {
        try {
            const saved = JSON.parse(data);
            // Sort by num to preserve order
            saved.sort((a, b) => a.num - b.num);
            saved.forEach(s => {
                this.restore(s.id, s.num);
            });
        } catch (e) {
            console.error('Failed to restore sessions:', e);
            localStorage.removeItem('ks-ssh-terms');
        }
    }
  }
}
