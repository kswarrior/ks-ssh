import { $, esc, showToast } from './utils.js';

export class ProcessManager {
  constructor() {
    this.list = $('proc-list');
    this.refreshTimer = null;
    this.lastData = [];
    this.filter = '';
    this._setupUI();
  }

  _setupUI() {
    $('proc-refresh-btn')?.addEventListener('click', () => this.load());
    $('proc-search')?.addEventListener('input', (e) => {
        this.filter = e.target.value.toLowerCase();
        this.render(this.lastData);
    });
    $('proc-refresh-rate')?.addEventListener('change', (e) => {
        this._setupAutoRefresh(parseInt(e.target.value));
    });
    this._setupAutoRefresh(5000);
  }

  _setupAutoRefresh(ms) {
      if (this.refreshTimer) clearInterval(this.refreshTimer);
      if (ms > 0) {
          this.refreshTimer = setInterval(() => this.load(true), ms);
      }
  }

  async load(isAuto = false) {
    if (!isAuto) {
    this.list.innerHTML = `
        <div class="skeleton-row" style="grid-template-columns: 60px 1fr 60px 60px 40px; margin-bottom:10px;">
            <div class="skeleton skeleton-line"></div>
            <div class="skeleton skeleton-line mid"></div>
            <div class="skeleton skeleton-line"></div>
            <div class="skeleton skeleton-line"></div>
            <div class="skeleton skeleton-icon"></div>
        </div>
    `.repeat(5);

    try {
      const res = await fetch('/ksapi/processes');
      const data = await res.json();
      this.lastData = data.processes || [];
      this.render(this.lastData);
    } catch (err) {
      this.list.innerHTML = `<div style="color:#ef4444; text-align:center; padding:40px;">TASK ERROR: ${err.message}</div>`;
    }
  }

  render(procs) {
    const filtered = this.filter
        ? procs.filter(p => p.name.toLowerCase().includes(this.filter) || p.pid.toString().includes(this.filter))
        : procs;

    if (!filtered.length) {
      this.list.innerHTML = '<div style="text-align:center; padding:60px; color:var(--text-dim);">NO MATCHING TASKS</div>';
      return;
    }

    const html = `
        <div style="display:grid; grid-template-columns: 70px 1fr 60px 60px 40px; padding:8px 16px; border-bottom:1px solid var(--glass-border); font-size:10px; font-weight:800; color:var(--text-dim); text-transform:uppercase; letter-spacing:1px;">
            <div>PID</div>
            <div>COMMAND</div>
            <div style="text-align:right;">CPU%</div>
            <div style="text-align:right;">MEM%</div>
            <div></div>
        </div>
        ${filtered.map(p => `
            <div class="proc-row" style="display:grid; grid-template-columns: 70px 1fr 60px 60px 40px; padding:10px 16px; align-items:center; border-bottom:1px solid var(--glass-border); transition:0.2s;">
                <div style="font-family:var(--font-mono); font-size:12px; color:var(--text-dim);">${p.pid}</div>
                <div style="font-weight:600; color:var(--text-pure); font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(p.name)}</div>
                <div style="font-family:var(--font-mono); text-align:right; color:var(--text-blue); font-size:12px;">${p.cpu}%</div>
                <div style="font-family:var(--font-mono); text-align:right; color:var(--text-main); font-size:12px;">${p.mem}%</div>
                <div style="display:flex; justify-content:flex-end;">
                    <button onclick="processes.kill('${p.pid}')" class="icon-btn danger-hover" style="padding:4px;"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg></button>
                </div>
            </div>
        `).join('')}
    `;
    this.list.innerHTML = html;
  }

  async kill(pid) {
      if (!confirm(`TERMINATE PROCESS ${pid}?`)) return;
      try {
          const res = await fetch('/ksapi/processes/kill', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ pid })
          });
          const data = await res.json();
          if (data.success) { showToast(`PROCESS ${pid} TERMINATED`); this.load(); }
          else throw new Error(data.error);
      } catch (err) { showToast(err.message, 'error'); }
  }
}
