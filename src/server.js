#!/usr/bin/env node
'use strict';

const express = require('express');
const ejs = require('ejs');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');

// Modules
const TunnelManager = require('./lib/tunnel');
const TerminalManager = require('./lib/terminal');
const FileManager = require('./lib/file-manager');
const SystemMonitor = require('./lib/sys-monitor');
const PortScanner = require('./lib/port-scanner');

// ===== SETUP =====
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

app.set('view engine', 'ejs');
app.engine('ejs', ejs.renderFile);
app.set('views', path.join(__dirname, 'views'));

if (process.pkg) {
    console.log('[PKG] Internal Views Path:', path.join(__dirname, 'views'));
}

app.use(express.json({ limit: '50mb' }));
app.use(express.static(PUBLIC_DIR));

app.get('/', (req, res) => {
  res.render('index');
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dest = req.query.path || req.body.path || os.homedir();
      cb(null, dest);
    },
    filename: (req, file, cb) => cb(null, file.originalname)
  })
});

// Managers
const tunnel = new TunnelManager(PORT, io);
const terminals = new TerminalManager(io);
const files = new FileManager();
const sys = new SystemMonitor();
const scanner = new PortScanner();

// ===== API ROUTES =====

app.get('/ksapi/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.get('/ksapi/system', (req, res) => res.json(sys.getSystemInfo()));

app.get('/ksapi/resources', async (req, res) => res.json(await sys.getStats()));

app.get('/ksapi/tunnel', (req, res) => res.json(tunnel.getInfo()));

app.get('/ksapi/ports', (req, res) => res.json({ ports: scanner.scan() }));

app.get('/ksapi/files', (req, res) => {
  try { res.json(files.list(req.query.path)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/ksapi/files/download', (req, res) => files.download(req.query.path, res));

app.post('/ksapi/files/upload', upload.array('files'), (req, res) => res.json({ success: true, count: req.files.length }));

app.post('/ksapi/files/upload-url', async (req, res) => {
  try { const d = await files.uploadFromUrl(req.body.url, req.body.destDir, req.body.filename); res.json({ success: true, ...d }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/ksapi/files/zip', async (req, res) => {
  try { const d = await files.zip(req.body.paths, req.body.outputDir, req.body.outputName); res.json({ success: true, ...d }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/ksapi/files/rename', (req, res) => {
  const { oldPath, newName } = req.body;
  const newPath = path.join(path.dirname(oldPath), newName);
  try { fs.renameSync(oldPath, newPath); res.json({ success: true, newPath }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/ksapi/files/delete', (req, res) => {
  const list = req.body.filePaths || [req.body.filePath];
  try {
    list.forEach(p => { if (fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true }); else fs.unlinkSync(p); });
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/ksapi/files/mkdir', (req, res) => {
  try {
    const dirPath = req.body.dirPath || path.join(req.body.path, req.body.name);
    fs.mkdirSync(dirPath, { recursive: true });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/ksapi/files/read', (req, res) => {
  try { res.json({ content: fs.readFileSync(req.query.path, 'utf8') }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/ksapi/files/write', (req, res) => {
  try { fs.writeFileSync(req.body.filePath, req.body.content || ''); res.json({ success: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/ksapi/processes', (req, res) => {
  try {
    const output = require('child_process').execSync('ps -eo pid,ppid,user,%cpu,%mem,comm --sort=-%cpu | head -n 50', { encoding: 'utf8' });
    const lines = output.trim().split('\n');
    const data = lines.slice(1).map(l => {
      const parts = l.trim().split(/\s+/);
      return { pid: parts[0], ppid: parts[1], user: parts[2], cpu: parts[3], mem: parts[4], name: parts.slice(5).join(' ') };
    });
    res.json({ processes: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/ksapi/processes/kill', (req, res) => {
  try {
    const pid = parseInt(req.body.pid);
    if (isNaN(pid)) return res.status(400).json({ error: 'Invalid PID' });
    process.kill(pid, 'SIGKILL');
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Proxy logic (kept in server.js for simplicity of middleware integration)
app.all('/ksapi/proxy/:port*', (req, res) => {
  const port = parseInt(req.params.port);
  if (!port) return res.status(400).send('Invalid port');
  const target = req.url.replace(`/ksapi/proxy/${port}`, '') || '/';

  const options = {
    hostname: '127.0.0.1', port, path: target, method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${port}` },
    timeout: 5000
  };
  delete options.headers['accept-encoding'];

  const proxy = http.request(options, (pRes) => {
    const ct = pRes.headers['content-type'] || '';
    const h = { ...pRes.headers };
    delete h['x-frame-options']; delete h['content-security-policy'];

    if (ct.includes('text/html')) {
      let body = ''; pRes.setEncoding('utf8');
      pRes.on('data', c => body += c);
      pRes.on('end', () => {
        const base = `<base href="/ksapi/proxy/${port}/">`;
        body = body.replace(/<head[^>]*>/i, m => m + base);
        if (!body.toLowerCase().includes('<base ')) body = base + body;
        delete h['content-length']; res.writeHead(pRes.statusCode, h); res.end(body);
      });
    } else {
      res.writeHead(pRes.statusCode, h); pRes.pipe(res, { end: true });
    }
  });
  proxy.on('error', () => { if (!res.headersSent) res.status(502).send('Error connecting to port ' + port); });
  if (req.method !== 'GET') req.pipe(proxy, { end: true }); else proxy.end();
});

// ===== SOCKET =====
io.on('connection', (socket) => {
  const info = tunnel.getInfo();
  if (info.active) socket.emit('tunnel:url', info);

  socket.on('terminal:create', (data) => terminals.create(socket, data));
  socket.on('terminal:reconnect', (data) => terminals.reconnect(socket, data));
  socket.on('terminal:input', ({ id, data }) => terminals.write(id, data));
  socket.on('terminal:resize', ({ id, cols, rows }) => terminals.resize(id, cols, rows));
  socket.on('terminal:kill', ({ id }) => terminals.kill(id));
  socket.on('disconnect', () => terminals.handleDisconnect(socket.id));
});

// ===== START =====
server.listen(PORT, '0.0.0.0', () => {
  const banner = `
\x1b[36m╔══════════════════════════════════════════════════╗\x1b[0m
\x1b[36m║\x1b[0m  \x1b[1m\x1b[97mKS SSH\x1b[0m — Browser Terminal Manager  \x1b[2mby KS Warrior\x1b[0m  \x1b[36m║\x1b[0m
\x1b[36m╚══════════════════════════════════════════════════╝\x1b[0m
  \x1b[2mLocal:\x1b[0m    \x1b[4mhttp://localhost:${PORT}\x1b[0m
  \x1b[2mNetwork:\x1b[0m  \x1b[4mhttp://0.0.0.0:${PORT}\x1b[0m
  \x1b[2m⏳ Starting tunnel...\x1b[0m
`;
  process.stdout.write(banner);
  tunnel.start();
});

process.on('SIGTERM', () => { tunnel.stop(); process.exit(0); });
process.on('SIGINT', () => { tunnel.stop(); process.exit(0); });
