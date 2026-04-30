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
  }

  async load(dirPath = this.currentPath) {
    const list = $('files-list');
    list.innerHTML = '<div style="text-align:center; padding:60px; font-family:var(--font-mono); color:var(--text-blue); font-size:12px;">SEQUENCING DATA BLOCKS...</div>';
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
    const list = $('files-list');
    if (!list) return;
    list.innerHTML = '';
    if (data.parent && data.path !== '/') {
        list.appendChild(this.createRow({ name: '..', isDirectory: true, path: data.parent }));
    }
    data.files.forEach(f => list.appendChild(this.createRow(f)));
  }

  createRow(f) {
    const row = document.createElement('div');
    row.className = 'file-row';
    const isParent = f.name === '..';

    row.innerHTML = `
        <div class="file-icon">${f.isDirectory ? '📁' : '📄'}</div>
        <div class="file-info">
            <div class="file-name">${esc(f.name)}</div>
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

  optimisticDelete(file) {
    if (!confirm(`PURGE ${file.name}?`)) return;
    fetch('/ksapi/files/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: file.path })
    }).then(r => r.json()).then(d => {
        if (d.success) { showToast('DATA PURGED'); this.load(); }
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
}
