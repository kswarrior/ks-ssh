import { $, showToast, fmtBytes } from './utils.js';

export class FileManager {
  constructor() {
    this.currentPath = '/';
    this.selectMode = false;
    this.selectedPaths = new Set();
    this.activeDropdown = null;
  }

  async load(dirPath = this.currentPath) {
    const list = $('files-list');
    list.innerHTML = '<div class="loading-files">Loading...</div>';
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
      list.innerHTML = `<div class="loading-files" style="color:red">Error: ${err.message}</div>`;
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
      el.textContent = seg === '/' ? '/ root' : seg;
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
      row.innerHTML = `<span></span><span>📁</span><div class="file-info"><div class="file-name">..</div></div><span></span><span></span>`;
      row.onclick = () => this.load(data.parent);
      list.appendChild(row);
    }

    data.files.forEach(f => {
      const row = document.createElement('div');
      row.className = 'file-item-row';
      row.dataset.path = f.path;
      if (f.isDirectory) row.style.cursor = 'pointer';

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'file-check';
      check.onchange = (e) => {
        e.stopPropagation();
        row.classList.toggle('selected', check.checked);
        if (check.checked) this.selectedPaths.add(f.path);
        else this.selectedPaths.delete(f.path);
        this.updateBulkBar();
      };

      row.innerHTML = `
        <span class="file-icon-svg">${f.isDirectory ? '📁' : '📄'}</span>
        <div class="file-info"><div class="file-name">${f.name}</div></div>
        <div class="file-size-col">${f.isDirectory ? '-' : fmtBytes(f.size)}</div>
        <div class="file-menu-wrap"><button class="file-menu-btn">⋮</button></div>
      `;
      row.prepend(check);

      if (f.isDirectory) {
        row.onclick = (e) => {
          if (!e.target.closest('.file-menu-wrap') && !e.target.closest('.file-check'))
            this.load(f.path);
        };
      }

      row.querySelector('.file-menu-btn').onclick = (e) => {
        e.stopPropagation();
        this.openDropdown(e.target, f);
      };

      list.appendChild(row);
    });
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
      // Optimistic rename
      const row = document.querySelector(`.file-item-row[data-path="${file.path.replace(/\\/g, '\\\\')}"]`);
      const nameEl = row?.querySelector('.file-name');
      const oldName = nameEl ? nameEl.textContent : file.name;
      if (nameEl) nameEl.textContent = newName;

      fetch('/ksapi/files/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPath: file.path, newName })
      }).then(r => r.json()).then(d => {
        if (d.success) { showToast('Renamed'); this.load(); }
        else { showToast(d.error, 'error'); if (nameEl) nameEl.textContent = oldName; }
      });
    }
  }

  optimisticDelete(file) {
    if (confirm(`Delete ${file.name}?`)) {
      // Optimistic delete: remove from UI immediately
      const row = document.querySelector(`.file-item-row[data-path="${file.path.replace(/\\/g, '\\\\')}"]`);
      if (row) row.style.opacity = '0.5';

      fetch('/ksapi/files/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: file.path })
      }).then(r => r.json()).then(d => {
        if (d.success) { showToast('Deleted'); row?.remove(); }
        else { showToast(d.error, 'error'); if (row) row.style.opacity = '1'; }
      });
    }
  }

  exitSelectMode() {
    this.selectMode = false;
    this.selectedPaths.clear();
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
