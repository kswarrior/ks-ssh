#!/usr/bin/env node
'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const archiver = require('archiver');
const mime = require('mime-types');
const { execSync, execFileSync, spawn } = require('child_process');
const os = require('os');
const https = require('https');

const PORT = process.env.PORT || 3000;

// Resolve public dir — works both in plain node and inside a pkg binary
const PUBLIC_DIR = process.pkg
  ? path.join(path.dirname(process.execPath), 'public')
  : path.join(__dirname, 'public');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = req.query.path || os.homedir();
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, file.originalname)
  })
});

const sessions = new Map();
let currentTunnelUrl = null;

// ===== CLOUDFLARE TUNNEL =====

function downloadCloudflared(dest, cb) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`;
  console.log(`[KS-SSH] Downloading cloudflared from GitHub (${arch})...`);

  const file = fs.createWriteStream(dest);
  const doGet = (u) => {
    https.get(u, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return doGet(res.headers.location);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return cb(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          try {
            fs.chmodSync(dest, 0o755);
            console.log(`[KS-SSH] cloudflared downloaded → ${dest}`);
            cb(null);
          } catch (e) { cb(e); }
        });
      });
    }).on('error', (e) => { file.close(); fs.unlink(dest, () => {}); cb(e); });
  };
  doGet(url);
}

function findOrDownloadCloudflared(cb) {
  // Search well-known paths
  const candidates = [
    process.env.CLOUDFLARED_BIN,
    'cloudflared',
    '/usr/local/bin/cloudflared',
    '/usr/bin/cloudflared',
    path.join(os.homedir(), '.local/bin/cloudflared'),
    path.join(os.homedir(), 'cloudflared'),
    // Next to the running binary (useful for pkg bundle)
    process.pkg ? path.join(path.dirname(process.execPath), 'cloudflared') : null,
    // Next to this script
    path.join(__dirname, '..', 'cloudflared'),
    path.join(__dirname, 'cloudflared'),
  ].filter(Boolean);

  for (const c of candidates) {
    try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return cb(null, c); } catch {}
  }

  // Not found — download it
  const dest = path.join(os.homedir(), '.local', 'bin', 'cloudflared');
  try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch {}

  downloadCloudflared(dest, (err) => {
    if (err) {
      console.log(`[KS-SSH] Failed to download cloudflared: ${err.message}`);
      console.log('[KS-SSH] You can install it manually:');
      console.log('[KS-SSH]   curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared');
      return cb(err);
    }
    cb(null, dest);
  });
}

let cfChild = null;

function killExistingCloudflared() {
  try { execSync('pkill -f "cloudflared tunnel" 2>/dev/null || true', { stdio: 'ignore' }); } catch {}
}

function startCloudflareTunnel() {
  findOrDownloadCloudflared((err, cfBin) => {
    if (err) return;

    // Kill any stale cloudflared from a previous run
    killExistingCloudflared();

    console.log(`[KS-SSH] Starting Cloudflare tunnel with: ${cfBin}`);

    // Use spawn (not exec) — no maxBuffer limit, streams data in real time
    const child = spawn(cfBin, ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate', '--protocol', 'http2'], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    cfChild = child;
    let announced = false;
    let buffer = '';

    function tryAnnounce(text) {
      buffer += text;
      if (announced) return;
      const match = buffer.match(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com/);
      if (match) {
        announced = true;
        currentTunnelUrl = `https://${match[1]}.trycloudflare.com`;
        const subdomain = match[1];
        console.log('');
        console.log('[KS-SSH] ==========================================');
        console.log('[KS-SSH]  TUNNEL READY');
        console.log('[KS-SSH] ==========================================');
        console.log(`[KS-SSH]  Share URL : https://ks-ssh.pages.dev/?token=${subdomain}`);
        console.log(`[KS-SSH]  Direct URL: ${currentTunnelUrl}`);
        console.log('[KS-SSH] ==========================================');
        console.log('');
        io.emit('tunnel:url', { url: currentTunnelUrl, shareUrl: `https://ks-ssh.pages.dev/?token=${subdomain}` });
      }
    }

    child.stdout.on('data', d => tryAnnounce(d.toString()));
    child.stderr.on('data', d => tryAnnounce(d.toString()));

    child.on('error', (e) => {
      console.log(`[KS-SSH] cloudflared error: ${e.message}`);
    });

    child.on('exit', (code, signal) => {
      cfChild = null;
      currentTunnelUrl = null;
      // Don't retry on SIGTERM (143) — that means we were shut down intentionally
      if (signal === 'SIGTERM' || signal === 'SIGKILL') return;
      if (code !== 0 && code !== null) {
        console.log(`[KS-SSH] cloudflared exited (code ${code}). Retrying in 8s...`);
        setTimeout(startCloudflareTunnel, 8000);
      } else if (code === 0) {
        // Clean exit — just restart
        console.log('[KS-SSH] cloudflared exited cleanly. Restarting tunnel in 8s...');
        setTimeout(startCloudflareTunnel, 8000);
      }
    });
  });
}

function cleanupAndExit(code) {
  if (cfChild) { try { cfChild.kill('SIGTERM'); } catch {} }
  process.exit(code || 0);
}
process.on('SIGTERM', () => cleanupAndExit(0));
process.on('SIGINT', () => cleanupAndExit(0));

// ===== API ROUTES =====

app.get('/ksapi/files', (req, res) => {
  const dirPath = req.query.path || os.homedir();
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const files = entries.map(entry => {
      const fullPath = path.join(dirPath, entry.name);
      let size = 0, modified = null;
      try { const s = fs.statSync(fullPath); size = s.size; modified = s.mtime.toISOString(); } catch {}
      return {
        name: entry.name, path: fullPath,
        isDirectory: entry.isDirectory(),
        size, modified,
        ext: path.extname(entry.name).toLowerCase()
      };
    }).sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });
    res.json({ path: dirPath, parent: path.dirname(dirPath), files });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/ksapi/files/download', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'No path' });
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
      const mimeType = mime.lookup(filePath) || 'application/octet-stream';
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/ksapi/files/upload', upload.array('files'), (req, res) => {
  res.json({ success: true, count: req.files.length });
});

app.post('/ksapi/files/rename', (req, res) => {
  const { oldPath, newName } = req.body;
  if (!oldPath || !newName) return res.status(400).json({ error: 'Missing params' });
  const newPath = path.join(path.dirname(oldPath), newName);
  try { fs.renameSync(oldPath, newPath); res.json({ success: true, newPath }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/ksapi/files/delete', (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'Missing path' });
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) fs.rmSync(filePath, { recursive: true, force: true });
    else fs.unlinkSync(filePath);
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/ksapi/files/mkdir', (req, res) => {
  const { dirPath } = req.body;
  if (!dirPath) return res.status(400).json({ error: 'Missing path' });
  try { fs.mkdirSync(dirPath, { recursive: true }); res.json({ success: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/ksapi/files/read', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'No path' });
  try { res.json({ content: fs.readFileSync(filePath, 'utf8') }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/ksapi/files/write', (req, res) => {
  const { filePath, content } = req.body;
  if (!filePath) return res.status(400).json({ error: 'Missing path' });
  try { fs.writeFileSync(filePath, content || ''); res.json({ success: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/ksapi/ports', (req, res) => {
  try {
    let output = '';
    try { output = execSync('ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null', { encoding: 'utf8' }); } catch {}
    const ports = [];
    for (const line of output.split('\n')) {
      const match = line.match(/:(\d+)\s/);
      if (match) {
        const port = parseInt(match[1]);
        if (port > 0 && port < 65536 && !ports.find(p => p.port === port)) {
          const pm = line.match(/users:\(\("([^"]+)"/);
          ports.push({ port, process: pm ? pm[1] : 'unknown', address: line.match(/0\.0\.0\.0/) ? '0.0.0.0' : '127.0.0.1' });
        }
      }
    }
    res.json({ ports: ports.sort((a, b) => a.port - b.port) });
  } catch { res.json({ ports: [] }); }
});

app.get('/ksapi/system', (req, res) => {
  try {
    const freeMem = os.freemem(), totalMem = os.totalmem();
    res.json({
      hostname: os.hostname(), platform: os.platform(), arch: os.arch(),
      uptime: os.uptime(),
      memory: { free: freeMem, total: totalMem, used: totalMem - freeMem },
      loadAvg: os.loadavg(), cpus: os.cpus().length,
      home: os.homedir(), user: os.userInfo().username
    });
  } catch (err) { res.json({ error: err.message }); }
});

app.get('/ksapi/tunnel', (req, res) => {
  if (currentTunnelUrl) {
    const subdomain = currentTunnelUrl.replace('https://', '').replace('.trycloudflare.com', '');
    res.json({ url: currentTunnelUrl, shareUrl: `https://ks-ssh.pages.dev/?token=${subdomain}`, active: true });
  } else {
    res.json({ url: null, shareUrl: null, active: false });
  }
});

// ===== SOCKET / TERMINAL =====

io.on('connection', (socket) => {
  console.log(`[KS-SSH] Client connected: ${socket.id}`);
  // Send current tunnel URL immediately if available
  if (currentTunnelUrl) {
    const subdomain = currentTunnelUrl.replace('https://', '').replace('.trycloudflare.com', '');
    socket.emit('tunnel:url', { url: currentTunnelUrl, shareUrl: `https://ks-ssh.pages.dev/?token=${subdomain}` });
  }

  socket.on('terminal:create', (data) => {
    const id = data.id || uuidv4();
    const shell = process.env.SHELL || '/bin/bash';
    const cols = data.cols || 80, rows = data.rows || 24;
    try {
      const ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color', cols, rows,
        cwd: data.cwd || os.homedir(),
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
      });
      sessions.set(id, { pty: ptyProcess, socket: socket.id });
      ptyProcess.onData((chunk) => socket.emit('terminal:data', { id, data: chunk }));
      ptyProcess.onExit(({ exitCode }) => { socket.emit('terminal:exit', { id, exitCode }); sessions.delete(id); });
      socket.emit('terminal:created', { id });
    } catch (err) { socket.emit('terminal:error', { id, error: err.message }); }
  });

  socket.on('terminal:input', ({ id, data }) => {
    const s = sessions.get(id);
    if (s) { try { s.pty.write(data); } catch {} }
  });

  socket.on('terminal:resize', ({ id, cols, rows }) => {
    const s = sessions.get(id);
    if (s) { try { s.pty.resize(cols, rows); } catch {} }
  });

  socket.on('terminal:kill', ({ id }) => {
    const s = sessions.get(id);
    if (s) { try { s.pty.kill(); } catch {} sessions.delete(id); }
  });

  socket.on('disconnect', () => {
    console.log(`[KS-SSH] Client disconnected: ${socket.id}`);
    for (const [id, s] of sessions.entries()) {
      if (s.socket === socket.id) { try { s.pty.kill(); } catch {} sessions.delete(id); }
    }
  });
});

// ===== START =====

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('[KS-SSH] ==========================================');
  console.log('[KS-SSH]  KS SSH Server running');
  console.log(`[KS-SSH]  Local : http://localhost:${PORT}`);
  console.log('[KS-SSH]  Starting Cloudflare tunnel...');
  console.log('[KS-SSH] ==========================================');
  console.log('');
  startCloudflareTunnel();
});
