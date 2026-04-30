import { $, esc } from './utils.js';

export class PortScanner {
  constructor() {
    this.list = $('ports-list');
    this._setupUI();
  }

  _setupUI() {
    $('ports-refresh-btn')?.addEventListener('click', () => this.load());
  }

  async load() {
    this.list.innerHTML = '<div style="text-align:center; padding:60px; font-family:var(--font-mono); font-size:12px; color:var(--text-blue);">SCANNING UPLINK PORTS...</div>';
    try {
      const res = await fetch('/ksapi/ports');
      const data = await res.json();
      this.render(data.ports || []);
    } catch (err) {
      this.list.innerHTML = `<div style="color:#ef4444; text-align:center; padding:40px;">SCAN ERROR: ${err.message}</div>`;
    }
  }

  render(ports) {
    if (!ports.length) {
      this.list.innerHTML = '<div style="text-align:center; padding:60px; color:var(--text-dim); font-size:14px;">NO ACTIVE SERVICES DETECTED</div>';
      return;
    }
    this.list.innerHTML = ports.map(p => `
      <div style="background:var(--night-900); border:1px solid var(--glass-border); border-radius:8px; padding:12px 20px; display:flex; align-items:center; justify-content:space-between; transition:var(--transition-fast);" onmouseover="this.style.background='var(--night-800)'" onmouseout="this.style.background='var(--night-900)'">
        <div style="display:flex; align-items:center; gap:20px;">
            <div style="width:40px; height:40px; background:var(--night-800); border-radius:6px; display:flex; align-items:center; justify-content:center; color:var(--text-blue);">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/></svg>
            </div>
            <div style="display:flex; flex-direction:column; gap:2px;">
              <div style="font-family:var(--font-mono); font-weight:700; color:var(--text-pure); font-size:16px;">:${p.port}</div>
              <div style="font-size:11px; font-weight:600; color:var(--text-dim); text-transform:uppercase; letter-spacing:0.5px;">${esc(p.process)} • ${p.address === '0.0.0.0' ? 'PUBLIC' : 'LOCAL'}</div>
            </div>
        </div>
        <button onclick="window.openPortPreview(${p.port})" class="btn-primary" style="padding:6px 16px; font-size:11px; background:transparent; border:1px solid var(--text-blue); color:var(--text-blue); box-shadow:none;">PREVIEW</button>
      </div>
    `).join('');
  }
}
