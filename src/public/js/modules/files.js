import { $, showToast, fmtBytes, esc } from './utils.js';

export class FileManager {
  constructor() {
    this.currentPath = localStorage.getItem('ks-ssh-files-path') || localStorage.getItem('ks-ssh-default-cwd') || '/';
    this.selectedPaths = new Set();
    this.activeFile = null;
    this._setupUI();
  }

  _setupUI() {
    $('upload-btn')?.addEventListener('click', () => $('file-input').click());
    $('file-input')?.addEventListener('change', (e) => this.handleUpload(e));
    $('new-file-btn')?.addEventListener('click', () => this.showCreatePanel('file'));
    $('new-folder-btn')?.addEventListener('click', () => this.showCreatePanel('folder'));
    $('files-refresh-btn')?.addEventListener('click', () => this.load());

    // Search
    $('files-search')?.addEventListener('input', (e) => this.filterFiles(e.target.value));

    // Quick Links
    document.querySelectorAll('.sidebar-link').forEach(link => {
        link.onclick = () => this.load(link.dataset.path);
    });

    // Bookmarks
    $('add-bookmark-btn')?.addEventListener('click', () => this.addBookmark());
    this.bookmarks = JSON.parse(localStorage.getItem('ks-ssh-bookmarks') || '[]');
    this.renderBookmarks();

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
    $('ctx-copy')?.addEventListener('click', () => { this.promptCopy(this.activeFile); this.closeContextMenu(); });
    $('ctx-move')?.addEventListener('click', () => { this.promptMove(this.activeFile); this.closeContextMenu(); });
    $('ctx-delete')?.addEventListener('click', () => { this.optimisticDelete(this.activeFile); this.closeContextMenu(); });

    // Global click to close menu/modals
    document.addEventListener('click', (e) => {
        if (!$('file-context-menu').contains(e.target)) this.closeContextMenu();
        if (e.target.classList.contains('modal-overlay') || e.target.classList.contains('modal-close')) {
            e.target.closest('.modal-overlay')?.classList.add('hidden');
        }
    });

    // Editor Save & Highlight sync
    $('editor-save-btn')?.addEventListener('click', () => this.saveFile());

    const editor = $('file-editor-text');
    const highlight = $('editor-highlight');
    if (editor && highlight) {
        editor.addEventListener('input', () => this.applyHighlight());
        editor.addEventListener('scroll', () => {
            highlight.scrollTop = editor.scrollTop;
            highlight.scrollLeft = editor.scrollLeft;
        });
        // Handle Tab key
        editor.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                e.preventDefault();
                const start = editor.selectionStart;
                const end = editor.selectionEnd;
                editor.value = editor.value.substring(0, start) + "    " + editor.value.substring(end);
                editor.selectionStart = editor.selectionEnd = start + 4;
                this.applyHighlight();
            }
        });
    }

    // Create Panel
    $('create-cancel-btn')?.addEventListener('click', () => this.hideCreatePanel());
    $('create-confirm-btn')?.addEventListener('click', () => this.handleCreate());
    document.querySelectorAll('.create-type-btn').forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll('.create-type-btn').forEach(b => {
                b.classList.add('btn-secondary');
                b.classList.remove('active');
            });
            btn.classList.remove('btn-secondary');
            btn.classList.add('active');
            this.createType = btn.dataset.type;
        };
    });
  }

  showCreatePanel(type) {
      this.createType = type;
      $('files-list').classList.add('hidden');
      $('files-create-panel').classList.remove('hidden');
      $('create-name-input').value = '';
      $('create-name-input').focus();
      document.querySelectorAll('.create-type-btn').forEach(b => {
          const active = b.dataset.type === type;
          b.classList.toggle('active', active);
          b.classList.toggle('btn-secondary', !active);
      });
  }

  hideCreatePanel() {
      $('files-list').classList.remove('hidden');
      $('files-create-panel').classList.add('hidden');
  }

  async handleCreate() {
      const name = $('create-name-input').value;
      if (!name) return;
      if (this.createType === 'file') await this._createFile(name);
      else await this._createFolder(name);
      this.hideCreatePanel();
  }

  async load(dirPath = this.currentPath) {
    const list = $('files-list');
    this.hideCreatePanel();
    localStorage.setItem('ks-ssh-files-path', dirPath);
    if ($('files-search')) $('files-search').value = '';
    list.innerHTML = `
        <div class="skeleton-row" style="grid-template-columns: 32px 1fr auto 40px; gap:12px;">
            <div class="skeleton skeleton-icon"></div>
            <div><div class="skeleton skeleton-line mid"></div><div class="skeleton skeleton-line short"></div></div>
            <div class="skeleton skeleton-line" style="width:60px;"></div>
            <div class="skeleton skeleton-icon"></div>
        </div>
        <div class="skeleton-row" style="grid-template-columns: 32px 1fr auto 40px; gap:12px;">
            <div class="skeleton skeleton-icon"></div>
            <div><div class="skeleton skeleton-line mid"></div><div class="skeleton skeleton-line short"></div></div>
            <div class="skeleton skeleton-line" style="width:40px;"></div>
            <div class="skeleton skeleton-icon"></div>
        </div>
        <div class="skeleton-row" style="grid-template-columns: 32px 1fr auto 40px; gap:12px;">
            <div class="skeleton skeleton-icon"></div>
            <div><div class="skeleton skeleton-line mid"></div><div class="skeleton skeleton-line short"></div></div>
            <div class="skeleton skeleton-line" style="width:80px;"></div>
            <div class="skeleton skeleton-icon"></div>
        </div>
    `.repeat(4);
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
    this.allFiles = data.files;
    this.parentPath = data.parent;
    this._renderList(this.allFiles);
  }

  _renderList(files) {
    const list = $('files-list');
    if (!list) return;
    list.innerHTML = '';
    if (this.parentPath && this.currentPath !== '/') {
        list.appendChild(this.createRow({ name: '..', isDirectory: true, path: this.parentPath }));
    }
    files.forEach(f => list.appendChild(this.createRow(f)));
  }

  filterFiles(query) {
      if (!this.allFiles) return;
      const filtered = this.allFiles.filter(f => f.name.toLowerCase().includes(query.toLowerCase()));
      this._renderList(filtered);
  }

  createRow(f) {
    const row = document.createElement('div');
    row.className = 'file-row';
    const isParent = f.name === '..';

    const icon = this.getFileIcon(f);

    const colorClass = this.getFileColorClass(f);

    const iconClass = f.isDirectory ? 'folder-vibrant' : (colorClass ? colorClass.replace('text-', 'icon-') : '');

    row.innerHTML = `
        <div class="file-icon ${iconClass}">${icon}</div>
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
            else if (!isParent) {
                const ext = f.name.split('.').pop().toLowerCase();
                const imgIcons = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'];
                if (imgIcons.includes(ext)) {
                    this.openPreview(f);
                } else {
                    this.download(f.path);
                }
            }
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

  openPreview(file) {
      this.activeFile = file;
      $('preview-filename').textContent = file.name;
      $('preview-img').src = `/ksapi/files/download?path=${encodeURIComponent(file.path)}`;
      $('image-preview-modal').classList.remove('hidden');
  }

  async openEditor(file) {
    this.activeFile = file;
    $('editor-filename').textContent = file.name;

    // Header color based on type
    const header = $('file-editor-modal').querySelector('.modal-header');
    const colorClass = this.getFileColorClass(file);
    const colorValue = colorClass ? getComputedStyle(document.documentElement).getPropertyValue('--' + colorClass.replace('text-', '')) : 'var(--electric-blue)';
    header.style.borderBottom = `2px solid ${colorValue}`;
    header.style.background = colorValue.trim() ? `${colorValue}11` : 'transparent';
    $('editor-filename').className = colorClass;

    $('file-editor-modal').classList.remove('hidden');
    $('file-editor-text').value = 'LOADING...';
    $('editor-highlight').innerHTML = '';

    try {
        const res = await fetch(`/ksapi/files/read?path=${encodeURIComponent(file.path)}`);
        const data = await res.json();
        $('file-editor-text').value = data.content || '';
        this.applyHighlight();
    } catch (err) {
        showToast('FAILED TO READ FILE', 'error');
    }
  }

  applyHighlight() {
      const text = $('file-editor-text').value;
      const highlight = $('editor-highlight');
      const ext = this.activeFile.name.split('.').pop().toLowerCase();

      const doHighlight = (txt, rules) => {
          let matches = [];
          rules.forEach(rule => {
              let m;
              const r = new RegExp(rule.r.source, rule.r.flags);
              while ((m = r.exec(txt)) !== null) {
                  matches.push({ index: m.index, length: m[0].length, text: m[0], type: rule.t });
                  if (!r.global) break;
              }
          });
          matches.sort((a, b) => a.index - b.index);
          let res = '';
          let last = 0;
          for (let m of matches) {
              if (m.index < last) continue;
              res += esc(txt.substring(last, m.index));
              res += `<span class="token-${m.type}">${esc(m.text)}</span>`;
              last = m.index + m.length;
          }
          res += esc(txt.substring(last));
          return res;
      };

      let html = '';
      if (['js', 'ts', 'json'].includes(ext)) {
          html = doHighlight(text, [
              { r: /(\/\/.*|\/\*[\s\S]*?\*\/)/g, t: 'comment' },
              { r: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, t: 'string' },
              { r: /\b(const|let|var|function|return|if|else|for|while|import|export|from|class|extends|new|async|await|try|catch|finally|throw)\b/g, t: 'keyword' },
              { r: /\b(\d+)\b/g, t: 'number' },
              { r: /(\.[\w$]+)(?=\s*\()/g, t: 'function' },
              { r: /([+\-*\/=<>!&|?:]+)/g, t: 'operator' }
          ]);
      } else if (['html', 'ejs'].includes(ext)) {
          html = doHighlight(text, [
              { r: /(<!--[\s\S]*?-->)/g, t: 'comment' },
              { r: /(<[\/!]?[\w-]+)/g, t: 'tag' },
              { r: /(>)/g, t: 'tag' },
              { r: /([\w-]+)=/g, t: 'attr' },
              { r: /(".*?"|'.*?')/g, t: 'string' }
          ]);
      } else if (['py'].includes(ext)) {
          html = doHighlight(text, [
              { r: /(#.*)/g, t: 'comment' },
              { r: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, t: 'string' },
              { r: /\b(def|class|return|if|else|elif|for|while|import|from|as|try|except|finally|with|lambda|in|is|not|and|or)\b/g, t: 'keyword' },
              { r: /\b(\d+)\b/g, t: 'number' }
          ]);
      } else if (['sh', 'bash'].includes(ext)) {
          html = doHighlight(text, [
              { r: /(#.*)/g, t: 'comment' },
              { r: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, t: 'string' },
              { r: /\b(if|then|else|elif|fi|for|do|done|while|case|esac|in|function|local|export|return)\b/g, t: 'keyword' }
          ]);
      } else {
          html = esc(text);
      }

      highlight.innerHTML = html + (text.endsWith('\n') ? ' ' : '');
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

  async promptCopy(file) {
    const newName = prompt('COPY TO (IDENTIFIER):', file.name + '_copy');
    if (!newName) return;
    const dest = `${this.currentPath}/${newName}`;
    try {
        const res = await fetch('/ksapi/files/copy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ src: file.path, dest })
        });
        const data = await res.json();
        if (data.success) { showToast('COPIED'); this.load(); }
        else throw new Error(data.error);
    } catch (err) { showToast(err.message, 'error'); }
  }

  async promptMove(file) {
    const newPath = prompt('MOVE TO (ABSOLUTE PATH):', file.path);
    if (!newPath || newPath === file.path) return;
    try {
        const res = await fetch('/ksapi/files/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ src: file.path, dest: newPath })
        });
        const data = await res.json();
        if (data.success) { showToast('MOVED'); this.load(); }
        else throw new Error(data.error);
    } catch (err) { showToast(err.message, 'error'); }
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

  async _createFile(name) {
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

  addBookmark(path = this.currentPath) {
      if (this.bookmarks.includes(path)) return;
      this.bookmarks.push(path);
      localStorage.setItem('ks-ssh-bookmarks', JSON.stringify(this.bookmarks));
      showToast('BOOKMARK ADDED');
      this.renderBookmarks();
  }

  removeBookmark(path) {
      this.bookmarks = this.bookmarks.filter(b => b !== path);
      localStorage.setItem('ks-ssh-bookmarks', JSON.stringify(this.bookmarks));
      this.renderBookmarks();
  }

  renderBookmarks() {
      const list = $('bookmarks-list');
      if (!list) return;
      list.innerHTML = '';
      this.bookmarks.forEach(path => {
          const div = document.createElement('div');
          div.className = 'sidebar-link bookmark-item';
          div.style.display = 'flex';
          div.style.justifyContent = 'space-between';
          div.style.alignItems = 'center';

          const name = path.split('/').filter(Boolean).pop() || 'ROOT';
          div.innerHTML = `
              <span class="bookmark-name" style="flex:1; overflow:hidden; text-overflow:ellipsis;">${name.toUpperCase()}</span>
              <button class="remove-bookmark-btn icon-btn" style="padding:2px; opacity:0.5;">&times;</button>
          `;

          div.onclick = (e) => {
              if (e.target.closest('.remove-bookmark-btn')) {
                  e.stopPropagation();
                  this.removeBookmark(path);
              } else {
                  this.load(path);
              }
          };
          list.appendChild(div);
      });
  }

  async _createFolder(name) {
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

  getFileIcon(f) {
      if (f.isDirectory) return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v12z"/></svg>';

      const ext = f.name.split('.').pop().toLowerCase();
      const codeIcons = ['js', 'ts', 'html', 'css', 'py', 'sh', 'c', 'cpp', 'java', 'go', 'php'];
      const imgIcons = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'];
      const zipIcons = ['zip', 'rar', 'tar', 'gz', '7z'];

      if (codeIcons.includes(ext)) return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';
      if (imgIcons.includes(ext)) return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
      if (zipIcons.includes(ext)) return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 2v20"/><path d="M14 2v20"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/></svg>';

      return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>';
  }

  getFileColorClass(f) {
      if (f.isDirectory) return '';
      const ext = f.name.split('.').pop().toLowerCase();
      const colors = {
          'js': 'text-js', 'ts': 'text-js',
          'html': 'text-html',
          'css': 'text-css',
          'json': 'text-json',
          'md': 'text-md',
          'py': 'text-py',
          'sh': 'text-sh',
          'zip': 'text-zip', 'rar': 'text-zip', 'tar': 'text-zip', 'gz': 'text-zip',
          'png': 'text-img', 'jpg': 'text-img', 'jpeg': 'text-img', 'svg': 'text-img', 'webp': 'text-img'
      };
      return colors[ext] || '';
  }
}
