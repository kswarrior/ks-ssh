import { $, showToast } from './utils.js';

export class PortScanner {
  constructor() {
    this.list = $('ports-list');
    this._setupUI();
  }

  _setupUI() {
    $('ports-refresh-btn')?.addEventListener('click', () => this.load());
  }

  async load() {
    this.list.innerHTML = '<div style="text-align:center; padding:40px; color:var(--text-muted);">Syncing gateway...</div>';
    try {
      const res = await fetch('/ksapi/ports');
      const data = await res.json();
      this.render(data.ports || []);
    } catch (err) {
      this.list.innerHTML = `<div style="color:var(--red); text-align:center; padding:40px;">Error: ${err.message}</div>`;
    }
  }

  render(ports) {
    if (!ports.length) {
      this.list.innerHTML = '<div style="text-align:center; padding:40px; color:var(--text-muted);">No services found.</div>';
      return;
    }
    this.list.innerHTML = ports.map(p => `
      <div class="p-row">
        <div class="p-info">
          <div class="p-port">:${p.port}</div>
          <div class="p-process">${p.process} • ${p.address === '0.0.0.0' ? 'Public' : 'Local'}</div>
        </div>
        <button onclick="window.openPortPreview(${p.port})" class="btn-primary" style="padding:8px 16px; font-size:12px;">Connect</button>
      </div>
    `).join('');
  }
}
