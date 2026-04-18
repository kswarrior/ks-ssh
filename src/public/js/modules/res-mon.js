import { $, showToast } from './utils.js';

export class ResourceMonitor {
  constructor() {
    this.isOpen = false;
    this.btn = $('res-mon-btn');
    this.dropdown = $('res-dropdown');
    this.init();
  }

  init() {
    this.btn.onclick = (e) => {
      e.stopPropagation();
      this.toggle();
    };
    document.addEventListener('click', (e) => {
      if (this.isOpen && !$('res-mon-wrap').contains(e.target)) this.toggle(false);
    });
  }

  toggle(force) {
    this.isOpen = force !== undefined ? force : !this.isOpen;
    this.dropdown.classList.toggle('hidden', !this.isOpen);
    this.btn.classList.toggle('active', this.isOpen);
    if (this.isOpen) this.poll();
  }

  async poll() {
    try {
      const res = await fetch('/ksapi/resources');
      const d = await res.json();
      this.update(d);
    } catch {}
  }

  update(d) {
    if (!d || d.error) return;

    // Icon Fills
    this._setFill('rm-ram-fill', d.ram.percent);
    this._setFill('rm-cpu-fill', d.cpu.percent);
    this._setFill('rm-disk-fill', d.disk.percent);

    // Dropdown Labels & Bars
    if ($('rm-ram-label')) $('rm-ram-label').textContent = `${d.ram.used.toFixed(1)} / ${d.ram.total.toFixed(1)} GB (${Math.round(d.ram.percent)}%)`;
    if ($('rm-cpu-label')) $('rm-cpu-label').textContent = `${Math.round(d.cpu.percent)}%`;
    if ($('rm-disk-label')) $('rm-disk-label').textContent = `${d.disk.used.toFixed(1)} / ${d.disk.total.toFixed(1)} GB (${Math.round(d.disk.percent)}%)`;

    this._setBar('rm-ram-bar', d.ram.percent, '#22c55e');
    this._setBar('rm-cpu-bar', d.cpu.percent, '#3b82f6');
    this._setBar('rm-disk-bar', d.disk.percent, '#a855f7');

    if (d.cpu.model && $('rm-cpu-model')) $('rm-cpu-model').textContent = d.cpu.model;

    // Network
    if (d.network && $('rm-net-in')) {
      const fmt = (b) => b > 1073741824 ? (b/1073741824).toFixed(1)+'GB' : b > 1048576 ? (b/1048576).toFixed(1)+'MB' : (b/1024).toFixed(1)+'KB';
      $('rm-net-in').textContent = fmt(d.network.in);
      $('rm-net-out').textContent = fmt(d.network.out);
    }

    // Cores
    if (d.cpu.cores && $('rm-cores-container')) {
      const container = $('rm-cores-container');
      if (container.children.length !== d.cpu.cores.length) {
        container.innerHTML = d.cpu.cores.map((_, i) => `
          <div class="rm-core-item">
            <span class="rm-core-label">C${i}</span>
            <div class="rm-core-track"><div class="rm-core-fill" id="rm-core-fill-${i}"></div></div>
          </div>
        `).join('');
      }
      d.cpu.cores.forEach((pct, i) => {
        const f = $(`rm-core-fill-${i}`);
        if (f) f.style.height = pct + '%';
      });
    }
  }

  _setFill(id, pct) {
    const el = $(id);
    if (!el) return;
    const h = (pct / 100) * 17;
    el.setAttribute('height', h.toFixed(1));
    el.setAttribute('y', (21 - h).toFixed(1));
  }

  _setBar(id, pct, color) {
    const el = $(id);
    if (!el) return;
    el.style.width = pct + '%';
    if (pct > 90) el.style.background = '#ef4444';
    else if (pct > 70) el.style.background = '#f59e0b';
    else el.style.background = color;
  }
}
