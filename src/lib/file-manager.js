'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const archiver = require('archiver');
const mime = require('mime-types');
const http = require('http');
const https = require('https');

class FileManager {
  constructor() {}

  list(dirPath) {
    const target = dirPath || os.homedir();
    const entries = fs.readdirSync(target, { withFileTypes: true });
    const files = entries.map(entry => {
      const full = path.join(target, entry.name);
      let size = 0, modified = null;
      try { const s = fs.statSync(full); size = s.size; modified = s.mtime.toISOString(); } catch {}
      return {
        name: entry.name,
        path: full,
        isDirectory: entry.isDirectory(),
        size,
        modified,
        ext: path.extname(entry.name).toLowerCase()
      };
    }).sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });
    return { path: target, parent: path.dirname(target), files };
  }

  download(filePath, res) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}.zip"`);
        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(res);
        archive.directory(filePath, path.basename(filePath));
        archive.finalize();
      } else {
        const type = mime.lookup(filePath) || 'application/octet-stream';
        res.setHeader('Content-Type', type);
        res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
        fs.createReadStream(filePath).pipe(res);
      }
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }

  async uploadFromUrl(url, destDir, filename) {
    const targetDir = destDir || os.homedir();
    const rawName = filename || decodeURIComponent(path.basename(url.split('?')[0])) || 'download';
    const fname = rawName.replace(/[/\\:*?"<>|]/g, '_');
    const destPath = path.join(targetDir, fname);

    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);
      const proto = url.startsWith('https') ? https : http;

      const doGet = (u) => {
        proto.get(u, (response) => {
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            return doGet(response.headers.location);
          }
          if (response.statusCode !== 200) {
            file.close(); fs.unlink(destPath, () => {});
            return reject(new Error(`HTTP ${response.statusCode}`));
          }
          response.pipe(file);
          file.on('finish', () => file.close(() => resolve({ path: destPath, name: fname })));
          file.on('error', (e) => { fs.unlink(destPath, () => {}); reject(e); });
        }).on('error', (e) => { fs.unlink(destPath, () => {}); reject(e); });
      };
      doGet(url);
    });
  }

  zip(paths, outDir, outName) {
    const name = outName || (`archive_${new Date().toISOString().slice(0, 10)}.zip`);
    const targetDir = outDir || path.dirname(paths[0]);
    const outPath = path.join(targetDir, name);
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    return new Promise((resolve, reject) => {
      output.on('close', () => resolve({ path: outPath, name }));
      archive.on('error', reject);
      archive.pipe(output);
      for (const p of paths) {
        try {
          const s = fs.statSync(p);
          if (s.isDirectory()) archive.directory(p, path.basename(p));
          else archive.file(p, { name: path.basename(p) });
        } catch {}
      }
      archive.finalize();
    });
  }
}

module.exports = FileManager;
