import { $, showToast, fmtBytes, esc } from './utils.js';

export class PortScanner {
  constructor() {
    this.list = $('ports-list');
    this._setupUI();
  }

  _setupUI() {
    $('ports-refresh-btn')?.addEventListener('click', () => this.load());
  }

  async load() {
    this.list.innerHTML = '<div style="text-align:center; padding:40px; font-family:var(--font-mono); font-size:12px; color:var(--electric-cyan);">SCANNING NETWORK INTERFACES...</div>';
    try {
      const res = await fetch('/ksapi/ports');
      const data = await res.json();
      this.render(data.ports || []);
    } catch (err) {
      this.list.innerHTML = `<div style="color:#ef4444; text-align:center; padding:40px;">ERROR: ${err.message}</div>`;
    }
  }

  render(ports) {
    if (!ports.length) {
      this.list.innerHTML = '<div style="text-align:center; padding:40px; color:var(--text-dim);">NO ACTIVE SERVICES DETECTED</div>';
      return;
    }
    this.list.innerHTML = ports.map(p => `
      <div style="background:var(--night-800); border:1px solid var(--glass-border); border-radius:14px; padding:16px 24px; display:flex; align-items:center; justify-content:space-between;">
        <div style="display:flex; flex-direction:column; gap:4px;">
          <div style="font-family:var(--font-mono); font-weight:900; color:var(--electric-cyan); font-size:18px;">:${p.port}</div>
          <div style="font-size:12px; font-weight:700; color:var(--text-dim); text-transform:uppercase; letter-spacing:0.05em;">${esc(p.process)} • ${p.address === '0.0.0.0' ? 'PUBLIC' : 'LOCAL'}</div>
        </div>
        <button onclick="window.openPortPreview(${p.port})" style="background:var(--night-700); border:1px solid var(--electric-cyan); color:var(--electric-cyan); padding:8px 24px; border-radius:8px; font-weight:800; font-size:11px; cursor:pointer; transition:0.2s;">PREVIEW</button>
      </div>
    `).join('');
  }
}
