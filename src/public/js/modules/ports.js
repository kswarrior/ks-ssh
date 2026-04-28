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
    this.list.innerHTML = `
      <div class="empty-state">
        <div class="loading-spinner"></div>
        <p>Scanning active processes...</p>
      </div>
    `;
    try {
      const res = await fetch('/ksapi/ports');
      const data = await res.json();
      this.render(data.ports || []);
      if ($('ports-count')) $('ports-count').textContent = (data.ports || []).length;
    } catch (err) {
      this.list.innerHTML = `<div class="empty-state" style="color:var(--red)">Error: ${err.message}</div>`;
    }
  }

  render(ports) {
    if (!ports.length) {
      this.list.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="var(--text-muted)" stroke-width="1"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/></svg>
          <p>No active listening ports found.</p>
        </div>
      `;
      return;
    }
    this.list.innerHTML = `
      <table class="ports-table">
        <thead>
          <tr>
            <th>Port</th>
            <th>Process</th>
            <th>Visibility</th>
            <th style="text-align:right">Action</th>
          </tr>
        </thead>
        <tbody>
          ${ports.map(p => `
            <tr>
              <td><span class="port-num-badge">:${p.port}</span></td>
              <td><span style="font-weight:600">${p.process}</span></td>
              <td>
                <span style="color:${p.address === '0.0.0.0' ? 'var(--green)' : 'var(--text-muted)'}">
                  ${p.address === '0.0.0.0' ? 'Public' : 'Local'}
                </span>
              </td>
              <td style="text-align:right">
                <button onclick="window.openPortPreview(${p.port})" class="port-open-btn">Preview</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }
}
