import { $, showToast } from './utils.js';

export class ResourceMonitor {
  constructor() {
    this.isOpen = false;
    this.btn = $('res-mon-btn');
    this.data = null;
    this.init();
  }

  init() {
    if (!this.btn) return;
    this.btn.onclick = (e) => {
      e.stopPropagation();
      this.toggle();
    };
  }

  toggle(force) {
    this.isOpen = force !== undefined ? force : !this.isOpen;
    this.btn.classList.toggle('active', this.isOpen);
  }

  async poll() {
    // Basic polling handled by app.js loadSystemInfo for now to keep header sync
  }

  update(d) {
    if (!d || d.error) return;
    this.data = d;
  }
}
