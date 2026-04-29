import { $, showToast, fmtBytes } from './utils.js';

export class FileManager {
  constructor() {
    this.currentPath = '/';
    this.selectedPaths = new Set();
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
    list.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:40px; color:var(--text-muted);">Scanning disks...</div>';
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
      list.innerHTML = `<div style="grid-column:1/-1; color:var(--red); text-align:center; padding:40px;">Error: ${err.message}</div>`;
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
      el.style.cssText = "cursor:pointer; font-size:12px; font-weight:700; padding:4px 8px; border-radius:6px; transition:0.2s; color:var(--text-muted);";
      if (i === paths.length - 1) el.style.color = "var(--text)";
      else {
        el.onmouseover = () => el.style.background = "var(--bg-hover)";
        el.onmouseout = () => el.style.background = "transparent";
        el.onclick = () => this.load(p);
      }
      bc.appendChild(el);
      if (i < paths.length - 1) {
        const sep = document.createElement('span');
        sep.textContent = '›';
        sep.style.cssText = "color:var(--zinc-700); font-size:14px; margin:0 4px;";
        bc.appendChild(sep);
      }
    });
  }

  render(data) {
    const list = $('files-list');
    if (!list) return;
    list.innerHTML = '';

    if (data.parent && data.path !== '/') {
        const card = this.createCard({ name: '..', isDirectory: true, path: data.parent });
        list.appendChild(card);
    }

    data.files.forEach(f => {
      const card = this.createCard(f);
      list.appendChild(card);
    });
  }

  createCard(f) {
    const card = document.createElement('div');
    card.className = 'f-card';
    card.innerHTML = `
        <div class="f-icon">${f.isDirectory ? '📁' : '📄'}</div>
        <div class="f-name">${f.name}</div>
        ${!f.isDirectory ? `<div style="font-size:10px; color:var(--text-muted); font-family:var(--font-mono)">${fmtBytes(f.size)}</div>` : ''}
    `;

    card.onclick = () => {
        if (f.isDirectory) this.load(f.path);
        else this.openFileMenu(f, card);
    };

    card.oncontextmenu = (e) => {
        e.preventDefault();
        this.openFileMenu(f, card);
    };

    return card;
  }

  openFileMenu(file, card) {
    if (confirm(`Action for ${file.name}?\n- OK to Download\n- Cancel to Delete`)) {
        this.download(file.path);
    } else {
        if (confirm(`Permanently delete ${file.name}?`)) {
            this.optimisticDelete(file);
        }
    }
  }

  async handleUpload(e) {
    const files = e.target.files;
    if (!files.length) return;

    const formData = new FormData();
    for (let f of files) formData.append('files', f);
    formData.append('path', this.currentPath);

    showToast(`Uploading...`);
    try {
      const res = await fetch('/ksapi/files/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.success) { showToast('Complete'); this.load(); }
      else throw new Error(data.error);
    } catch (err) {
      showToast(err.message, 'error');
    }
    e.target.value = '';
  }

  async promptNewFolder() {
    const name = prompt('Folder Name:');
    if (!name) return;
    try {
      const res = await fetch('/ksapi/files/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: this.currentPath, name })
      });
      const data = await res.json();
      if (data.success) { showToast('Created'); this.load(); }
      else throw new Error(data.error);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  download(path) {
    window.location.href = `/ksapi/files/download?path=${encodeURIComponent(path)}`;
  }

  optimisticDelete(file) {
    fetch('/ksapi/files/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: file.path })
    }).then(r => r.json()).then(d => {
        if (d.success) { showToast('Deleted'); this.load(); }
        else showToast(d.error, 'error');
    });
  }

  exitSelectMode() {
    this.selectedPaths.clear();
    this.updateBulkBar();
  }

  updateBulkBar() {
    const bar = $('bulk-bar');
    if (!bar) return;
    if (this.selectedPaths.size > 0) bar.classList.remove('hidden');
    else bar.classList.add('hidden');
  }
}
