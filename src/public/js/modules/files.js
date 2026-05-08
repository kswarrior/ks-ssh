import { $, showToast, fmtBytes, esc } from './utils.js';

export class FileManager {
  constructor() {
    this.currentPath = '/';
    this.selectedPaths = new Set();
    this.activeFile = null;
    this._setupUI();
  }

  _setupUI() {
    $('upload-btn')?.addEventListener('click', () => $('file-input').click());
    $('file-input')?.addEventListener('change', (e) => this.handleUpload(e));
    $('new-file-btn')?.addEventListener('click', () => this.promptNewFile());
    $('new-folder-btn')?.addEventListener('click', () => this.promptNewFolder());
    $('files-refresh-btn')?.addEventListener('click', () => this.load());

    // URL Upload
    $('url-upload-btn')?.addEventListener('click', () => $('url-upload-modal').classList.remove('hidden'));
    $('url-upload-confirm')?.addEventListener('click', () => this.handleUrlUpload());

    // Select mode toggle
    $('select-btn')?.addEventListener('click', () => {
        const bar = $('bulk-bar');
        if (bar.classList.contains('hidden')) {
            showToast('MULTI-SELECT ENABLED (SHIFT+CLICK)');
            bar.classList.remove('hidden');
        } else {
            this.exitSelectMode();
        }
    });

    // Bulk actions
    $('bulk-delete')?.addEventListener('click', () => this.handleBulkDelete());
    $('bulk-zip')?.addEventListener('click', () => this.handleBulkZip());
    $('bulk-cancel')?.addEventListener('click', () => this.exitSelectMode());

    // Context Menu actions
    $('ctx-download')?.addEventListener('click', () => { this.download(this.activeFile.path); this.closeContextMenu(); });
    $('ctx-edit')?.addEventListener('click', () => { this.openEditor(this.activeFile); this.closeContextMenu(); });
    $('ctx-rename')?.addEventListener('click', () => { this.promptRename(this.activeFile); this.closeContextMenu(); });
    $('ctx-copy-path')?.addEventListener('click', () => { this.copyToClipboard(this.activeFile.path); this.closeContextMenu(); });
    $('ctx-delete')?.addEventListener('click', () => { this.optimisticDelete(this.activeFile); this.closeContextMenu(); });

    // Global click to close menu/modals
    document.addEventListener('click', (e) => {
        if (!$('file-context-menu').contains(e.target)) this.closeContextMenu();
        if (e.target.classList.contains('modal-overlay') || e.target.classList.contains('modal-close')) {
            e.target.closest('.modal-overlay')?.classList.add('hidden');
        }
    });

    // Editor Save
    $('editor-save-btn')?.addEventListener('click', () => this.saveFile());

    // Search
    $('files-search')?.addEventListener('input', (e) => this.filterList(e.target.value));
  }

  async load(dirPath = this.currentPath) {
    const list = $('files-list');
    list.innerHTML = `
        <div class="skeleton-row">
            <div class="skeleton skeleton-icon"></div>
            <div><div class="skeleton skeleton-line mid"></div><div class="skeleton skeleton-line short"></div></div>
            <div class="skeleton skeleton-line"></div>
            <div class="skeleton skeleton-icon"></div>
        </div>
        <div class="skeleton-row">
            <div class="skeleton skeleton-icon"></div>
            <div><div class="skeleton skeleton-line mid"></div><div class="skeleton skeleton-line short"></div></div>
            <div class="skeleton skeleton-line"></div>
            <div class="skeleton skeleton-icon"></div>
        </div>
        <div class="skeleton-row">
            <div class="skeleton skeleton-icon"></div>
            <div><div class="skeleton skeleton-line mid"></div><div class="skeleton skeleton-line short"></div></div>
            <div class="skeleton skeleton-line"></div>
            <div class="skeleton skeleton-icon"></div>
        </div>
    `;
    this.exitSelectMode();
    try {
      const res = await fetch(`/ksapi/files?path=${encodeURIComponent(dirPath)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      this.currentPath = data.path;
      this.renderBreadcrumb(data.path);
      this.render(data);
    } catch (err) {
      list.innerHTML = `<div style="color:#ef4444; text-align:center; padding:40px;">UPLINK ERROR: ${err.message}</div>`;
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
      el.textContent = (seg === '/' ? 'ROOT' : seg).toUpperCase();
      el.style.cssText = "cursor:pointer; transition:0.2s;";
      if (i === paths.length - 1) el.style.color = "var(--text-pure)";
      else {
        el.onclick = () => this.load(p);
      }
      bc.appendChild(el);
      if (i < paths.length - 1) bc.appendChild(document.createTextNode(' / '));
    });
  }

  render(data) {
    this.allFiles = data.files || [];
    this.parentPath = (data.path !== '/') ? data.parent : null;
    this._draw();
  }

  _draw(filter = '') {
    const list = $('files-list');
    if (!list) return;
    list.innerHTML = '';

    if (this.parentPath && !filter) {
        list.appendChild(this.createRow({ name: '..', isDirectory: true, path: this.parentPath }));
    }

    const filtered = filter
        ? this.allFiles.filter(f => f.name.toLowerCase().includes(filter.toLowerCase()))
        : this.allFiles;

    filtered.forEach(f => list.appendChild(this.createRow(f)));

    if (filtered.length === 0 && this.allFiles.length > 0) {
        list.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text-dim);">NO MATCHES FOUND</div>`;
    }
  }

  filterList(val) {
      this._draw(val);
  }

  createRow(f) {
    const row = document.createElement('div');
    row.className = 'file-row';
    const isParent = f.name === '..';

    const { icon, color } = this.getFileVisuals(f);
    const colorClass = this.getFileColorClass(f);

    row.innerHTML = `
        <div class="file-icon" style="color: ${color}">${icon}</div>
        <div class="file-info">
            <div class="file-name ${colorClass}">${esc(f.name)}</div>
            ${!isParent ? `<div class="file-meta">${f.modified ? f.modified.split('T')[0] : ''}</div>` : ''}
        </div>
        <div class="file-size">${!f.isDirectory ? fmtBytes(f.size) : ''}</div>
        <div class="file-actions" style="display:flex; justify-content:center;">
            ${!isParent ? `<button class="icon-btn" style="padding:4px;"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg></button>` : ''}
        </div>
    `;

    row.onclick = (e) => {
        if (e.target.closest('.file-actions')) {
            e.stopPropagation();
            this.openContextMenu(e, f);
            return;
        }
        if (e.shiftKey && !isParent) {
            this.toggleSelect(f.path, row);
        } else {
            if (f.isDirectory) this.load(f.path);
            else if (!isParent) this.download(f.path);
        }
    };

    row.oncontextmenu = (e) => {
        if (isParent) return;
        e.preventDefault();
        this.openContextMenu(e, f);
    };

    return row;
  }

  toggleSelect(path, el) {
      if (this.selectedPaths.has(path)) {
          this.selectedPaths.delete(path);
          el.classList.remove('selected');
      } else {
          this.selectedPaths.add(path);
          el.classList.add('selected');
      }
      this.updateBulkBar();
  }

  openContextMenu(e, file) {
    this.activeFile = file;
    const menu = $('file-context-menu');
    menu.classList.remove('hidden');

    let x = e.clientX, y = e.clientY;
    if (x + 160 > window.innerWidth) x -= 160;
    if (y + 180 > window.innerHeight) y -= 180;

    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    $('ctx-edit').classList.toggle('hidden', file.isDirectory);
  }

  closeContextMenu() {
    $('file-context-menu').classList.add('hidden');
  }

  async openEditor(file) {
    this.activeFile = file;
    $('editor-filename').textContent = file.name;

    // Header color based on type
    const header = $('file-editor-modal').querySelector('.modal-header');
    const colorClass = this.getFileColorClass(file);
    header.style.borderBottom = colorClass ? `2px solid ${getComputedStyle(document.documentElement).getPropertyValue('--' + colorClass.replace('text-', '')) || 'var(--electric-blue)'}` : '1px solid var(--glass-border)';

    $('file-editor-modal').classList.remove('hidden');
    $('file-editor-text').value = 'LOADING...';
    try {
        const res = await fetch(`/ksapi/files/read?path=${encodeURIComponent(file.path)}`);
        const data = await res.json();
        $('file-editor-text').value = data.content || '';
    } catch (err) {
        showToast('FAILED TO READ FILE', 'error');
    }
  }

  async saveFile() {
    try {
        const res = await fetch('/ksapi/files/write', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath: this.activeFile.path, content: $('file-editor-text').value })
        });
        const data = await res.json();
        if (data.success) { showToast('CHANGES SAVED'); $('file-editor-modal').classList.add('hidden'); }
        else throw new Error(data.error);
    } catch (err) {
        showToast(err.message, 'error');
    }
  }

  async promptRename(file) {
    const newName = prompt('NEW IDENTIFIER:', file.name);
    if (!newName || newName === file.name) return;

    // Optimistic UI
    const rows = document.querySelectorAll('.file-row');
    let targetRow = null;
    rows.forEach(r => { if (r.querySelector('.file-name').textContent === file.name) targetRow = r; });
    const oldName = file.name;
    if (targetRow) targetRow.querySelector('.file-name').textContent = newName;

    try {
        const res = await fetch('/ksapi/files/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldPath: file.path, newName })
        });
        const data = await res.json();
        if (data.success) { showToast('RENAMED'); this.load(); }
        else throw new Error(data.error);
    } catch (err) {
        if (targetRow) targetRow.querySelector('.file-name').textContent = oldName;
        showToast(err.message, 'error');
    }
  }

  async handleUpload(e) {
    const files = e.target.files;
    if (!files.length) return;
    const formData = new FormData();
    formData.append('path', this.currentPath);
    for (let f of files) formData.append('files', f);
    showToast(`UPLOADING DATA...`);
    try {
      const res = await fetch('/ksapi/files/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.success) { showToast('UPLINK COMPLETE'); this.load(); }
    } catch (err) { showToast(err.message, 'error'); }
    e.target.value = '';
  }

  async handleUrlUpload() {
      const url = $('upload-url-input').value;
      if (!url) return;
      showToast('INITIATING REMOTE FETCH...');
      try {
          const res = await fetch('/ksapi/files/upload-url', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url, destDir: this.currentPath })
          });
          const data = await res.json();
          if (data.success) { showToast('REMOTE DATA ACQUIRED'); $('url-upload-modal').classList.add('hidden'); this.load(); }
          else throw new Error(data.error);
      } catch (err) { showToast(err.message, 'error'); }
  }

  async handleBulkZip() {
      const name = prompt('ARCHIVE NAME:', 'archive.zip');
      if (!name) return;
      try {
          const res = await fetch('/ksapi/files/zip', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ paths: Array.from(this.selectedPaths), outputDir: this.currentPath, outputName: name })
          });
          const data = await res.json();
          if (data.success) { showToast('ARCHIVE CREATED'); this.load(); }
      } catch (err) { showToast(err.message, 'error'); }
  }

  async handleBulkDelete() {
      if (!confirm(`PURGE ${this.selectedPaths.size} ITEMS?`)) return;
      try {
          const res = await fetch('/ksapi/files/delete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ filePaths: Array.from(this.selectedPaths) })
          });
          const data = await res.json();
          if (data.success) { showToast('PURGE COMPLETE'); this.load(); }
      } catch (err) { showToast(err.message, 'error'); }
  }

  download(path) {
    window.location.href = `/ksapi/files/download?path=${encodeURIComponent(path)}`;
  }

  copyToClipboard(text) {
      navigator.clipboard.writeText(text).then(() => {
          showToast('PATH COPIED TO CLIPBOARD');
      }).catch(() => {
          showToast('CLIPBOARD ACCESS DENIED', 'error');
      });
  }

  optimisticDelete(file) {
    if (!confirm(`PURGE ${file.name}?`)) return;

    // Optimistic UI
    const rows = document.querySelectorAll('.file-row');
    let targetRow = null;
    rows.forEach(r => { if (r.querySelector('.file-name').textContent === file.name) targetRow = r; });
    if (targetRow) targetRow.style.display = 'none';

    fetch('/ksapi/files/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: file.path })
    }).then(r => r.json()).then(d => {
        if (d.success) { showToast('DATA PURGED'); this.load(); }
        else {
            if (targetRow) targetRow.style.display = 'grid';
            showToast(d.error, 'error');
        }
    }).catch(err => {
        if (targetRow) targetRow.style.display = 'grid';
        showToast(err.message, 'error');
    });
  }

  exitSelectMode() {
    this.selectedPaths.clear();
    document.querySelectorAll('.file-row.selected').forEach(el => el.classList.remove('selected'));
    this.updateBulkBar();
  }

  updateBulkBar() {
    const bar = $('bulk-bar');
    if (!bar) return;
    if (this.selectedPaths.size > 0) {
        bar.classList.remove('hidden');
        $('bulk-count').textContent = `${this.selectedPaths.size} ITEMS TAGGED`;
    } else bar.classList.add('hidden');
  }

  async promptNewFile() {
    const name = prompt('NEW FILE IDENTIFIER:');
    if (!name) return;
    try {
        const res = await fetch('/ksapi/files/write', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath: `${this.currentPath}/${name}`, content: '' })
        });
        const data = await res.json();
        if (data.success) { showToast('FILE CREATED'); this.load(); }
    } catch (err) { showToast(err.message, 'error'); }
  }

  async promptNewFolder() {
    const name = prompt('NEW FOLDER IDENTIFIER:');
    if (!name) return;
    try {
        const res = await fetch('/ksapi/files/mkdir', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: this.currentPath, name })
        });
        const data = await res.json();
        if (data.success) { showToast('DIRECTORY CREATED'); this.load(); }
    } catch (err) { showToast(err.message, 'error'); }
  }

  getFileVisuals(f) {
    if (f.name === '..') return { icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="11 17 6 12 11 7"/><path d="M6 12h12"/></svg>', color: 'var(--text-dim)' };

    if (f.isDirectory) return { icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v12z"/></svg>', color: '#fbbf24' };

    const ext = f.name.split('.').pop().toLowerCase();

    // Code
    if (['js', 'ts', 'jsx', 'tsx'].includes(ext)) return { icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 18l6-6-6-6"/><path d="M8 6l-6 6 6 6"/></svg>', color: '#f7df1e' };
    if (['html', 'htm'].includes(ext)) return { icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/><path d="M11 13l-2 2 2 2"/><path d="M13 17l2-2-2-2"/></svg>', color: '#e34f26' };
    if (ext === 'css') return { icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/><path d="M9 13v4h2"/><path d="M15 13v4h-2"/></svg>', color: '#1572b6' };
    if (ext === 'py') return { icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/><path d="M10 13a2 2 0 1 0 4 0 2 2 0 0 0-4 0z"/></svg>', color: '#3776ab' };
    if (['json', 'yml', 'yaml'].includes(ext)) return { icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/><path d="M8 13h1"/><path d="M8 15h1"/><path d="M8 17h1"/></svg>', color: '#8bc34a' };

    // Media
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return { icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>', color: '#ab47bc' };
    if (['mp4', 'mov', 'avi', 'webm'].includes(ext)) return { icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg>', color: '#ef4444' };

    // Archives
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return { icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v3"/><path d="M21 12v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9"/><path d="M10 3v18"/><path d="M14 3v18"/><path d="M3 8h18"/><path d="M3 12h18"/></svg>', color: '#ffca28' };

    // Docs
    if (ext === 'md') return { icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/><path d="M9 13l2 2 2-2"/><path d="M12 17V15"/></svg>', color: '#00b0ff' };

    // Default
    return { icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>', color: 'var(--text-dim)' };
  }

  getFileColorClass(f) {
      if (f.isDirectory) return '';
      const ext = f.name.split('.').pop().toLowerCase();
      const colors = {
          'js': 'text-js', 'ts': 'text-js',
          'html': 'text-html',
          'css': 'text-css',
          'json': 'text-json', 'yml': 'text-json', 'yaml': 'text-json',
          'md': 'text-md',
          'py': 'text-py',
          'sh': 'text-sh',
          'zip': 'text-zip', 'tar': 'text-zip', 'gz': 'text-zip',
          'png': 'text-img', 'jpg': 'text-img', 'jpeg': 'text-img', 'svg': 'text-img', 'gif': 'text-img',
          'mp4': 'text-danger', 'mov': 'text-danger'
      };
      return colors[ext] || '';
  }
}
