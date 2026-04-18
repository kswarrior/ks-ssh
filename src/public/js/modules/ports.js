import { $, showToast } from './utils.js';

export class PortScanner {
  constructor() {
    this.list = $('ports-list');
  }

  async load() {
    this.list.innerHTML = '<div>Scanning...</div>';
    try {
      const res = await fetch('/ksapi/ports');
      const data = await res.json();
      this.render(data.ports || []);
    } catch (err) {
      this.list.innerHTML = `<div style="color:red">Error: ${err.message}</div>`;
    }
  }

  render(ports) {
    if (!ports.length) {
      this.list.innerHTML = '<div>No open ports found.</div>';
      return;
    }
    this.list.innerHTML = `
      <table class="ports-table">
        <thead><tr><th>Port</th><th>Process</th><th>Visibility</th><th>Action</th></tr></thead>
        <tbody>
          ${ports.map(p => `
            <tr>
              <td><span class="port-num-badge">:${p.port}</span></td>
              <td>${p.process}</td>
              <td>${p.address === '0.0.0.0' ? 'Public' : 'Local'}</td>
              <td><button onclick="window.openPortPreview(${p.port})" class="port-open-btn">Preview</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }
}
