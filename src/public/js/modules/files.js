import { $, showToast, fmtBytes } from './utils.js';

export class FileManager {
  constructor() {
    this.currentPath = '/';
    this.selectedPaths = new Set();
    this.activeDropdown = null;
    this._setupUI();
  }

  _setupUI() {
    $('upload-btn')?.addEventListener('click', () => $('file-input').click());
    $('file-input')?.addEventListener('change', (e) => this.handleUpload(e));
    $('new-folder-btn')?.addEventListener('click', () => this.promptNewFolder());
    $('files-refresh-btn')?.addEventListener('click', () => this.load());

    $('bulk-delete')?.addEventListener('click', () => this.handleBulkDelete());
    $('bulk-cancel')?.addEventListener('click', () => this.exitSelectMode());
  }

  async load(dirPath = this.currentPath) {
    const list = $('files-list');
    list.innerHTML = '<div class="empty-state"><div class="loading-spinner"></div><p>Reading directory...</p></div>';
    this.exitSelectMode();
    try {
      const res = await fetch(`/ksapi/files?path=${encodeURIComponent(dirPath)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      this.currentPath = data.path;
      if ($('current-path')) $('current-path').textContent = data.path;
      this.renderBreadcrumb(data.path);
      this.render(data);
    } catch (err) {
      list.innerHTML = `<div class="empty-state" style="color:var(--red)">Error: ${err.message}</div>`;
    }
  }

  renderBreadcrumb(filePath) {
    const bc = $('breadcrumb');
    if (!bc) return;
    bc.innerHTML = '';
    const parts = filePath.split('/').filter(Boolean);
    const paths = ['/'];
    parts.forEach(p => paths.push(paths[paths.length - 1].replace(/\/$/, '') + '/' + p));
    paths.forEach((p, i) => {
      const seg = parts[i - 1] || '/';
      const el = document.createElement('span');
      el.className = 'bc-item' + (i === paths.length - 1 ? ' current' : '');
      el.textContent = seg === '/' ? 'root' : seg;
      if (i < paths.length - 1) el.onclick = () => this.load(p);
      bc.appendChild(el);
      if (i < paths.length - 1) {
        const sep = document.createElement('span');
        sep.className = 'bc-sep'; sep.textContent = '/';
        bc.appendChild(sep);
      }
    });
  }

  render(data) {
    const list = $('files-list');
    if (!list) return;
    list.innerHTML = '';

    if (data.parent && data.path !== '/') {
      const row = document.createElement('div');
      row.className = 'file-item-row';
      row.style.cursor = 'pointer';
      row.innerHTML = `
        <span></span>
        <span class="file-icon-svg">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--text-muted)" stroke-width="2"><path d="M3 3h6l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/></svg>
        </span>
        <div class="file-name">..</div>
        <span></span><span></span>
      `;
      row.onclick = () => this.load(data.parent);
      list.appendChild(row);
    }

    data.files.forEach(f => {
      const row = document.createElement('div');
      row.className = 'file-item-row';
      row.dataset.path = f.path;

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'file-check';
      check.onclick = (e) => e.stopPropagation();
      check.onchange = () => {
        row.classList.toggle('selected', check.checked);
        if (check.checked) this.selectedPaths.add(f.path);
        else this.selectedPaths.delete(f.path);
        this.updateBulkBar();
      };

      row.innerHTML = `
        <span class="file-icon-svg">
          ${f.isDirectory ?
            '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--blue-light)" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v12z"/></svg>' :
            '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--text-muted)" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>'}
        </span>
        <div class="file-name">${f.name}</div>
        <div class="file-size-col">${f.isDirectory ? '-' : fmtBytes(f.size)}</div>
        <div class="file-menu-wrap"><button class="file-menu-btn">⋮</button></div>
      `;
      row.prepend(check);

      row.onclick = (e) => {
        if (!e.target.closest('.file-menu-wrap') && !e.target.closest('.file-check')) {
          if (f.isDirectory) this.load(f.path);
        }
      };

      row.querySelector('.file-menu-btn').onclick = (e) => {
        e.stopPropagation();
        this.openDropdown(e.target, f);
      };

      list.appendChild(row);
    });
  }

  async handleUpload(e) {
    const files = e.target.files;
    if (!files.length) return;

    const formData = new FormData();
    for (let f of files) formData.append('files', f);
    formData.append('path', this.currentPath);

    showToast(`Uploading ${files.length} file(s)...`);
    try {
      const res = await fetch('/ksapi/files/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.success) { showToast('Upload complete'); this.load(); }
      else throw new Error(data.error);
    } catch (err) {
      showToast(err.message, 'error');
    }
    e.target.value = '';
  }

  async promptNewFolder() {
    const name = prompt('New Folder Name:');
    if (!name) return;
    try {
      const res = await fetch('/ksapi/files/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: this.currentPath, name })
      });
      const data = await res.json();
      if (data.success) { showToast('Folder created'); this.load(); }
      else throw new Error(data.error);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  openDropdown(btn, file) {
    this.closeDropdown();
    const rect = btn.getBoundingClientRect();
    const dd = document.createElement('div');
    dd.className = 'file-dropdown';
    dd.style.cssText = `position:fixed; top:${rect.bottom+4}px; left:${rect.right-140}px; z-index:1000;`;

    const items = [
      { label: 'Download', action: () => this.download(file.path) },
      { label: 'Rename', action: () => this.promptRename(file) },
      { label: 'Delete', danger: true, action: () => this.optimisticDelete(file) }
    ];

    items.forEach(item => {
      const b = document.createElement('button');
      if (item.danger) b.className = 'danger';
      b.textContent = item.label;
      b.onclick = () => { this.closeDropdown(); item.action(); };
      dd.appendChild(b);
    });

    document.body.appendChild(dd);
    this.activeDropdown = dd;
    setTimeout(() => document.addEventListener('click', () => this.closeDropdown(), { once: true }), 0);
  }

  closeDropdown() {
    if (this.activeDropdown) { this.activeDropdown.remove(); this.activeDropdown = null; }
  }

  download(path) {
    window.location.href = `/ksapi/files/download?path=${encodeURIComponent(path)}`;
  }

  promptRename(file) {
    const newName = prompt('New name:', file.name);
    if (newName && newName !== file.name) {
      fetch('/ksapi/files/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPath: file.path, newName })
      }).then(r => r.json()).then(d => {
        if (d.success) { showToast('Renamed'); this.load(); }
        else showToast(d.error, 'error');
      });
    }
  }

  optimisticDelete(file) {
    if (confirm(`Delete ${file.name}?`)) {
      fetch('/ksapi/files/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: file.path })
      }).then(r => r.json()).then(d => {
        if (d.success) { showToast('Deleted'); this.load(); }
        else showToast(d.error, 'error');
      });
    }
  }

  handleBulkDelete() {
    if (!this.selectedPaths.size) return;
    if (confirm(`Delete ${this.selectedPaths.size} items?`)) {
        showToast('Bulk delete not yet implemented', 'info');
    }
  }

  exitSelectMode() {
    this.selectedPaths.clear();
    document.querySelectorAll('.file-check').forEach(c => c.checked = false);
    document.querySelectorAll('.file-item-row.selected').forEach(r => r.classList.remove('selected'));
    this.updateBulkBar();
  }

  updateBulkBar() {
    const bar = $('bulk-bar');
    if (!bar) return;
    if (this.selectedPaths.size > 0) {
      bar.classList.remove('hidden');
      $('bulk-count').textContent = `${this.selectedPaths.size} selected`;
    } else {
      bar.classList.add('hidden');
    }
  }
}
