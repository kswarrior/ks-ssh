import { $, showToast } from './utils.js';

export class ResourceMonitor {
  constructor() {
    this.isOpen = false;
    this.btn = $('res-mon-btn');
    this.dropdown = $('res-dropdown');
    this.data = null;
    this.init();
  }

  init() {
    if (!this.btn) return;
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
    if (!this.isOpen) return;
    try {
      const res = await fetch('/ksapi/resources');
      const d = await res.json();
      this.update(d);
    } catch {}
  }

  update(d) {
    if (!d || d.error) return;
    this.data = d;

    // Update labels
    if ($('rm-ram-label')) $('rm-ram-label').textContent = `${Math.round(d.ram.percent)}%`;
    if ($('rm-cpu-label')) $('rm-cpu-label').textContent = `${Math.round(d.cpu.percent)}%`;

    // Optimistic progress bars with smooth transitions
    this._setBar('rm-ram-bar', d.ram.percent);
    this._setBar('rm-cpu-bar', d.cpu.percent);

    // Core-level tracking
    if (d.cpu.cores && $('rm-cores-container')) {
      const container = $('rm-cores-container');
      if (container.children.length !== d.cpu.cores.length) {
        container.innerHTML = d.cpu.cores.map((_, i) => `
          <div class="rm-core-item">
            <span class="rm-core-label">C${i}</span>
            <div class="rm-core-track">
              <div class="rm-core-fill" id="rm-core-fill-${i}" style="height: 0%"></div>
            </div>
          </div>
        `).join('');
      }
      d.cpu.cores.forEach((pct, i) => {
        const f = $(`rm-core-fill-${i}`);
        if (f) f.style.height = Math.round(pct) + '%';
      });
    }

    // Network stats
    if (d.network && $('rm-net-in')) {
      const fmt = (b) => b > 1073741824 ? (b/1073741824).toFixed(1)+'GB' : b > 1048576 ? (b/1048576).toFixed(1)+'MB' : (b/1024).toFixed(1)+'KB';
      $('rm-net-in').textContent = fmt(d.network.in);
      $('rm-net-out').textContent = fmt(d.network.out);
    }
  }

  _setBar(id, pct) {
    const el = $(id);
    if (!el) return;
    el.style.width = pct + '%';
    // Deeply optimistic color shifts
    if (pct > 85) el.style.background = 'var(--red)';
    else if (pct > 60) el.style.background = 'var(--yellow)';
    else el.style.background = id.includes('cpu') ? 'var(--blue-primary)' : 'var(--green)';
  }
}
