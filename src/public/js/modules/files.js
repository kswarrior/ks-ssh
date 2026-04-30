import { $, showToast, fmtBytes, esc } from './utils.js';

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
    list.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:60px; font-family:var(--font-mono); color:var(--electric-cyan); font-size:12px;">SEQUENCING DATA BLOCKS...</div>';
    this.exitSelectMode();
    try {
      const res = await fetch(`/ksapi/files?path=${encodeURIComponent(dirPath)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      this.currentPath = data.path;
      this.renderBreadcrumb(data.path);
      this.render(data);
    } catch (err) {
      list.innerHTML = `<div style="grid-column:1/-1; color:#ef4444; text-align:center; padding:40px;">UPLINK ERROR: ${err.message}</div>`;
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
        el.onmouseover = () => el.style.color = "var(--text-pure)";
        el.onmouseout = () => el.style.color = "var(--electric-cyan)";
        el.onclick = () => this.load(p);
      }
      bc.appendChild(el);
      if (i < paths.length - 1) {
        const sep = document.createElement('span');
        sep.textContent = ' / ';
        sep.style.color = "var(--night-700)";
        bc.appendChild(sep);
      }
    });
  }

  render(data) {
    const list = $('files-list');
    if (!list) return;
    list.innerHTML = '';

    if (data.parent && data.path !== '/') {
        list.appendChild(this.createCard({ name: '..', isDirectory: true, path: data.parent }));
    }

    data.files.forEach(f => list.appendChild(this.createCard(f)));
  }

  createCard(f) {
    const card = document.createElement('div');
    card.className = 'hud-f-card';
    card.innerHTML = `
        <div class="hud-f-icon">${f.isDirectory ? '📁' : '📄'}</div>
        <div class="hud-f-name">${esc(f.name)}</div>
        ${!f.isDirectory ? `<div style="font-size:10px; color:var(--text-dim); font-family:var(--font-mono); margin-top:auto;">${fmtBytes(f.size)}</div>` : ''}
    `;

    card.onclick = () => f.isDirectory ? this.load(f.path) : this.openFileMenu(f);
    return card;
  }

  openFileMenu(file) {
    if (confirm(`INITIATE DOWNLOAD FOR ${file.name}?`)) {
        this.download(file.path);
    } else {
        if (confirm(`EXECUTE PERMANENT PURGE OF ${file.name}?`)) {
            this.optimisticDelete(file);
        }
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
      else throw new Error(data.error);
    } catch (err) {
      showToast(err.message, 'error');
    }
    e.target.value = '';
  }

  async promptNewFolder() {
    const name = prompt('FOLDER IDENTIFIER:');
    if (!name) return;
    try {
      const res = await fetch('/ksapi/files/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: this.currentPath, name })
      });
      const data = await res.json();
      if (data.success) { showToast('IDENTIFIER REGISTERED'); this.load(); }
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
        if (d.success) { showToast('DATA PURGED'); this.load(); }
        else showToast(d.error, 'error');
    });
  }

  handleBulkDelete() {
      showToast('BULK PURGE NOT YET IMPLEMENTED', 'info');
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
