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
const nodeHttp = require('http');

// ===== PORT RESOLUTION =====
// Priority: --port flag > PORT env var > interactive prompt
function parsePortArg() {
  const args = process.argv.slice(2);
  const i = args.findIndex(a => a === '--port' || a === '-p');
  if (i !== -1 && args[i + 1]) return parseInt(args[i + 1]);
  const eq = args.find(a => /^--port=\d+$/.test(a));
  if (eq) return parseInt(eq.split('=')[1]);
  return null;
}

async function resolvePort() {
  const fromArg = parsePortArg();
  if (fromArg) return fromArg;
  if (process.env.PORT) return parseInt(process.env.PORT);

  // Interactive prompt (only when running as CLI, not as workflow)
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('\x1b[36m[KS SSH]\x1b[0m Enter port to listen on \x1b[2m(default: 3000)\x1b[0m: ', answer => {
      rl.close();
      const p = parseInt(answer.trim());
      resolve(!isNaN(p) && p > 0 && p < 65536 ? p : 3000);
    });
    rl.on('SIGINT', () => { rl.close(); process.exit(0); });
  });
}

let PORT;

// When running as a pkg binary, assets are embedded in the virtual snapshot
// filesystem under __dirname. We extract them to a real temp directory so that
// express.static (which needs real disk paths) can serve them. This makes the
// binary fully self-contained — no external files needed.
let PUBLIC_DIR;
if (process.pkg) {
  const tmpDir = path.join(os.tmpdir(), 'ks-ssh-public-' + process.pid);
  const embeddedPublic = path.join(__dirname, 'public');
  function extractEmbedded(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    let entries;
    try { entries = fs.readdirSync(src); } catch { return; }
    for (const entry of entries) {
      const srcPath = path.join(src, entry);
      const dstPath = path.join(dst, entry);
      let stat;
      try { stat = fs.statSync(srcPath); } catch { continue; }
      if (stat.isDirectory()) {
        extractEmbedded(srcPath, dstPath);
      } else {
        try { fs.writeFileSync(dstPath, fs.readFileSync(srcPath)); } catch {}
      }
    }
  }
  extractEmbedded(embeddedPublic, tmpDir);
  PUBLIC_DIR = tmpDir;
  // Clean up temp dir on exit
  process.on('exit', () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });
} else {
  PUBLIC_DIR = path.join(__dirname, 'public');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout:  60000,   // wait 60s for pong before declaring disconnect
  pingInterval: 25000,   // heartbeat every 25s
  connectTimeout: 45000,
  transports: ['websocket', 'polling'],
  upgradeTimeout: 10000,
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { const dir = req.query.path || os.homedir(); cb(null, dir); },
    filename: (req, file, cb) => cb(null, file.originalname)
  })
});

const sessions = new Map();
let currentTunnelUrl = null;

// ===== TUNNEL =====
function downloadLinker(dest, cb) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`;

  // Try wget first (follows redirects natively), fall back to curl
  const hasWget = (() => { try { execFileSync('wget', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  const hasCurl = (() => { try { execFileSync('curl', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

  let cmd, args;
  if (hasWget) {
    cmd = 'wget';
    args = ['-q', '--show-progress', '-O', dest, url];
  } else if (hasCurl) {
    cmd = 'curl';
    args = ['-L', '--silent', '--show-error', '-o', dest, url];
  } else {
    // Pure Node.js fallback — correct redirect handling (no file.close on redirect)
    const file = fs.createWriteStream(dest);
    let done = false;
    const finish = (err) => {
      if (done) return; done = true;
      if (err) { try { fs.unlinkSync(dest); } catch {} return cb(err); }
      try { fs.chmodSync(dest, 0o755); cb(null); } catch (e) { cb(e); }
    };
    const doGet = (u) => {
      const mod = u.startsWith('https') ? https : require('http');
      mod.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); return doGet(res.headers.location);
        }
        if (res.statusCode !== 200) { res.resume(); return finish(new Error(`HTTP ${res.statusCode}`)); }
        res.pipe(file);
        file.on('finish', () => file.close(() => finish(null)));
        file.on('error', finish);
      }).on('error', finish);
    };
    doGet(url);
    return;
  }

  const dl = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  
  // ===== FIXED: Show real-time download progress & errors =====
  dl.stderr.on('data', (data) => {
    process.stdout.write(data);   // Progress bar (wget) + errors (curl) now visible
  });
  
  dl.on('close', (code) => {
    if (code !== 0) { try { fs.unlinkSync(dest); } catch {} return cb(new Error(`${cmd} exited ${code}`)); }
    try { fs.chmodSync(dest, 0o755); cb(null); } catch (e) { cb(e); }
  });
  dl.on('error', (e) => { try { fs.unlinkSync(dest); } catch {} cb(e); });
}

function findOrDownloadLinker(cb) {
  const candidates = [
    process.env.KS_SSH_LINKER_BIN,
    'ks-ssh-linker',
    path.join(os.homedir(), '.local/bin/ks-ssh-linker'),
    path.join(os.homedir(), 'ks-ssh-linker'),
    process.pkg ? path.join(path.dirname(process.execPath), 'ks-ssh-linker') : null,
    path.join(__dirname, '..', 'ks-ssh-linker'),
    path.join(__dirname, 'ks-ssh-linker'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return cb(null, c); } catch {}
  }
  const dest = path.join(os.homedir(), '.local', 'bin', 'ks-ssh-linker');
  try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch {}
  console.log('[KS-SSH] Downloading ks-ssh-linker…');
  downloadLinker(dest, (err) => { if (err) return cb(err); cb(null, dest); });
}

let cfChild = null;

function startTunnel() {
  findOrDownloadLinker((err, linkerBin) => {
    if (err) return;
    try { execSync('pkill -f "ks-ssh-linker tunnel" 2>/dev/null || true', { stdio: 'ignore' }); } catch {}
    const child = spawn(linkerBin, ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate', '--protocol', 'http2'], {
      env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe']
    });
    cfChild = child;
    let announced = false, buffer = '';
    function tryAnnounce(text) {
      buffer += text;
      if (announced) return;
      const match = buffer.match(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com/);
      if (match) {
        announced = true;
        currentTunnelUrl = `https://${match[1]}.trycloudflare.com`;
        const subdomain = match[1];
        const shareUrl = `https://ssh.ksw.workers.dev/?token=${subdomain}`;
        const ready = [
          '',
          '\x1b[32m  ✓ Tunnel ready!\x1b[0m',
          '',
          `\x1b[36m  ┌──────────────────────────────────────────────┐\x1b[0m`,
          `\x1b[36m  │\x1b[0m  \x1b[1mLink:\x1b[0m   \x1b[4m\x1b[97mhttps://ssh.ksw.workers.dev/\x1b[0m          \x1b[36m│\x1b[0m`,
          `\x1b[36m  │\x1b[0m  \x1b[1mToken:\x1b[0m  \x1b[93m${subdomain}\x1b[0m`,
          `\x1b[36m  └──────────────────────────────────────────────┘\x1b[0m`,
          '',
        ].join('\n');
        process.stdout.write(ready);
        io.emit('tunnel:url', { url: currentTunnelUrl, shareUrl, subdomain });
      }
    }
    child.stdout.on('data', d => tryAnnounce(d.toString()));
    child.stderr.on('data', d => tryAnnounce(d.toString()));
    child.on('exit', (code, signal) => {
      cfChild = null; currentTunnelUrl = null;
      if (signal === 'SIGTERM' || signal === 'SIGKILL') return;
      console.log(`[KS-SSH] Linker exited (${code}), restarting in 8s…`);
      setTimeout(startTunnel, 8000);
    });
  });
}

function cleanupAndExit(code) {
  if (cfChild) { try { cfChild.kill('SIGTERM'); } catch {} }
  process.exit(code || 0);
}
process.on('SIGTERM', () => cleanupAndExit(0));
process.on('SIGINT',  () => cleanupAndExit(0));

// ===== PING =====
app.get('/ksapi/ping', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ===== RESOURCES =====
app.get('/ksapi/resources', async (req, res) => {
  try {
    const readAllCpuStats = () => {
      const lines = fs.readFileSync('/proc/stat', 'utf8').split('\n').filter(l => /^cpu/.test(l));
      return lines.map(line => {
        const nums = line.split(/\s+/).slice(1).map(Number);
        return { total: nums.reduce((a,b)=>a+b,0), idle: nums[3]+(nums[4]||0) };
      });
    };
    const s1 = readAllCpuStats();
    await new Promise(r => setTimeout(r, 300));
    const s2 = readAllCpuStats();
    const calcPct = (a, b) => { const td=b.total-a.total, id=b.idle-a.idle; return td>0?((td-id)/td)*100:0; };
    const cpuPercent = calcPct(s1[0], s2[0]);
    const corePercents = s1.slice(1).map((c,i) => calcPct(c, s2[i+1]||c));

    const totalMem = os.totalmem(), freeMem = os.freemem(), usedMem = totalMem - freeMem;

    let diskTotal = 0, diskUsed = 0;
    try {
      const dfOut = execSync('df -k / 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
      const parts = dfOut.trim().split('\n')[1]?.trim().split(/\s+/) || [];
      if (parts.length >= 3) { diskTotal = parseInt(parts[1]) * 1024; diskUsed = parseInt(parts[2]) * 1024; }
    } catch {}

    let cpuModel = null;
    try {
      const cpuInfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
      const m = cpuInfo.match(/model name\s*:\s*(.+)/);
      if (m) cpuModel = m[1].trim().replace(/\s+/g, ' ');
    } catch {}

    let netIn = 0, netOut = 0;
    try {
      const netLines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
      for (const line of netLines) {
        const p = line.trim().split(/\s+/);
        if (p.length > 9 && !p[0].startsWith('lo:')) { netIn += parseInt(p[1])||0; netOut += parseInt(p[9])||0; }
      }
    } catch {}

    let temp = null;
    try {
      const t = execSync('cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null', { encoding:'utf8', timeout:1000 }).trim();
      if (t) temp = parseInt(t) / 1000;
    } catch {}

    res.json({
      ram:  { total: totalMem/1073741824, used: usedMem/1073741824, percent: (usedMem/totalMem)*100 },
      cpu:  { percent: cpuPercent, cores: corePercents, model: cpuModel, count: corePercents.length },
      disk: { total: diskTotal/1073741824, used: diskUsed/1073741824, percent: diskTotal>0?(diskUsed/diskTotal)*100:0 },
      network: { in: netIn, out: netOut },
      temp,
    });
  } catch (err) { res.json({ error: err.message }); }
});

// ===== SYSTEM =====
app.get('/ksapi/system', (req, res) => {
  try {
    const freeMem = os.freemem(), totalMem = os.totalmem();
    res.json({
      hostname: os.hostname(), platform: os.platform(), arch: os.arch(),
      uptime: os.uptime(), memory: { free: freeMem, total: totalMem, used: totalMem - freeMem },
      loadAvg: os.loadavg(), cpus: os.cpus().length, home: os.homedir(), user: os.userInfo().username
    });
  } catch (err) { res.json({ error: err.message }); }
});

// ===== TUNNEL =====
app.get('/ksapi/tunnel', (req, res) => {
  if (currentTunnelUrl) {
    const subdomain = currentTunnelUrl.replace('https://', '').replace('.trycloudflare.com', '');
    res.json({ url: currentTunnelUrl, shareUrl: `https://ssh.ksw.workers.dev/?token=${subdomain}`, subdomain, active: true });
  } else {
    res.json({ url: null, shareUrl: null, subdomain: null, active: false });
  }
});

// ===== PORT PROXY =====
app.all('/ksapi/proxy/:port*', (req, res) => {
  const port = parseInt(req.params.port);
  if (!port || port < 1 || port > 65535) return res.status(400).send('Invalid port');
  const targetPath = req.url.replace(`/ksapi/proxy/${port}`, '') || '/';

  const options = {
    hostname: '127.0.0.1', port,
    path: targetPath, method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${port}` },
    timeout: 10000,
  };
  delete options.headers['accept-encoding'];

  const proxyReq = nodeHttp.request(options, (proxyRes) => {
    const ct = proxyRes.headers['content-type'] || '';
    const headers = { ...proxyRes.headers };
    delete headers['x-frame-options'];
    delete headers['content-security-policy'];

    if (ct.includes('text/html')) {
      let body = '';
      proxyRes.setEncoding('utf8');
      proxyRes.on('data', c => body += c);
      proxyRes.on('end', () => {
        const base = `<base href="/ksapi/proxy/${port}/">`;
        body = body.replace(/<head[^>]*>/i, m => m + base);
        if (!body.toLowerCase().includes('<base ')) body = base + body;
        delete headers['content-length'];
        res.writeHead(proxyRes.statusCode, headers);
        res.end(body);
      });
    } else {
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res, { end: true });
    }
  });

  proxyReq.on('error', () => {
    if (!res.headersSent) {
      res.status(502).send(`<html><body style="font-family:monospace;background:#0a0e1a;color:#94a3b8;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><div style="font-size:48px;margin-bottom:16px">⚡</div><div style="color:#ef4444;font-size:14px">Cannot connect to port ${port}</div><div style="font-size:12px;margin-top:8px">Make sure a server is running on this port</div></div></body></html>`);
    }
  });
  proxyReq.on('timeout', () => { proxyReq.destroy(); });

  if (req.method !== 'GET' && req.method !== 'HEAD') req.pipe(proxyReq, { end: true });
  else proxyReq.end();
});

// ===== PORTS =====
app.get('/ksapi/ports', (req, res) => {
  try {
    const ports = [];
    const seen = new Set();
    let output = '';

    // Try multiple commands
    const cmds = ['ss -Htlnp', 'ss -tlnp', 'netstat -tlnp 2>/dev/null'];
    for (const cmd of cmds) {
      try { output = execSync(cmd, { encoding: 'utf8', timeout: 4000 }); if (output.trim()) break; } catch {}
    }

    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      if (/^State|^Proto|^Netid/i.test(line.trim())) continue;

      // Match local address:port — supports IPv4 and IPv6
      const m = line.match(/(?:0\.0\.0\.0|127\.0\.0\.1|\[::\]|\[::1\]|::|\*):(\d+)/);
      if (!m) continue;

      const port = parseInt(m[1]);
      if (!port || port > 65535 || seen.has(port)) continue;
      seen.add(port);

      const pm = line.match(/users:\(\("([^"]+)"/) || line.match(/"([^"]+)"\/\d+/);
      const isPublic = line.includes('0.0.0.0') || /\*:\d+/.test(line) || line.includes('[::]');
      ports.push({
        port,
        process: pm ? pm[1] : 'unknown',
        address: isPublic ? '0.0.0.0' : '127.0.0.1'
      });
    }

    // If ss/netstat gave nothing, try /proc/net/tcp
    if (!ports.length) {
      try {
        const readTcpFile = (file) => {
          if (!fs.existsSync(file)) return;
          const lines = fs.readFileSync(file, 'utf8').split('\n').slice(1);
          for (const line of lines) {
            const cols = line.trim().split(/\s+/);
            if (!cols[1] || !cols[3]) continue;
            const state = cols[3];
            if (state !== '0A') continue; // 0A = LISTEN
            const local = cols[1];
            const portHex = local.split(':')[1];
            if (!portHex) continue;
            const port = parseInt(portHex, 16);
            if (!port || port > 65535 || seen.has(port)) continue;
            seen.add(port);
            ports.push({ port, process: 'unknown', address: '0.0.0.0' });
          }
        };
        readTcpFile('/proc/net/tcp');
        readTcpFile('/proc/net/tcp6');
      } catch {}
    }

    res.json({ ports: ports.sort((a, b) => a.port - b.port) });
  } catch (err) { res.json({ ports: [], error: err.message }); }
});

// ===== FILES =====
app.get('/ksapi/files', (req, res) => {
  const dirPath = req.query.path || os.homedir();
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const files = entries.map(entry => {
      const fullPath = path.join(dirPath, entry.name);
      let size = 0, modified = null;
      try { const s = fs.statSync(fullPath); size = s.size; modified = s.mtime.toISOString(); } catch {}
      return { name: entry.name, path: fullPath, isDirectory: entry.isDirectory(), size, modified, ext: path.extname(entry.name).toLowerCase() };
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

// Upload from URL
app.post('/ksapi/files/upload-url', async (req, res) => {
  const { url, destDir, filename } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided' });
  const targetDir = destDir || os.homedir();
  const rawName = filename || decodeURIComponent(path.basename(url.split('?')[0])) || 'downloaded-file';
  const fname = rawName.replace(/[/\\:*?"<>|]/g, '_');
  const destPath = path.join(targetDir, fname);
  try {
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);
      const proto = url.startsWith('https') ? https : nodeHttp;
      const doGet = (u) => {
        proto.get(u, (response) => {
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            file.close(); return doGet(response.headers.location);
          }
          if (response.statusCode !== 200) {
            file.close(); fs.unlink(destPath, () => {}); return reject(new Error(`HTTP ${response.statusCode}`));
          }
          response.pipe(file);
          file.on('finish', () => file.close(resolve));
          file.on('error', (e) => { fs.unlink(destPath, () => {}); reject(e); });
        }).on('error', (e) => { file.close(); fs.unlink(destPath, () => {}); reject(e); });
      };
      doGet(url);
    });
    res.json({ success: true, path: destPath, name: fname });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Zip files/folders → create archive on server
app.post('/ksapi/files/zip', (req, res) => {
  const { paths, outputDir, outputName } = req.body;
  if (!paths || !paths.length) return res.status(400).json({ error: 'No paths specified' });
  const name = outputName || ('archive_' + new Date().toISOString().slice(0,10) + '.zip');
  const outDir = outputDir || path.dirname(paths[0]);
  const outPath = path.join(outDir, name);
  const output = fs.createWriteStream(outPath);
  const archive = archiver('zip', { zlib: { level: 6 } });
  output.on('close', () => res.json({ success: true, path: outPath, name }));
  archive.on('error', err => { try { res.status(500).json({ error: err.message }); } catch {} });
  archive.pipe(output);
  for (const p of paths) {
    try { const s = fs.statSync(p); if (s.isDirectory()) archive.directory(p, path.basename(p)); else archive.file(p, { name: path.basename(p) }); } catch {}
  }
  archive.finalize();
});

app.post('/ksapi/files/rename', (req, res) => {
  const { oldPath, newName } = req.body;
  if (!oldPath || !newName) return res.status(400).json({ error: 'Missing params' });
  const newPath = path.join(path.dirname(oldPath), newName);
  try { fs.renameSync(oldPath, newPath); res.json({ success: true, newPath }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/ksapi/files/delete', (req, res) => {
  const { filePath, filePaths } = req.body;
  try {
    const toDelete = filePaths || (filePath ? [filePath] : []);
    if (!toDelete.length) return res.status(400).json({ error: 'Missing path' });
    for (const p of toDelete) {
      const stat = fs.statSync(p);
      if (stat.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
      else fs.unlinkSync(p);
    }
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

// ===== SOCKET / TERMINAL =====
const TERM_GRACE_MS  = 5 * 60 * 1000;  // keep PTY alive 5 min after disconnect
const TERM_BUF_MAX   = 131072;          // 128 KB replay buffer
const TERM_BUF_TRIM  = 65536;           // trim to 64 KB when over limit

function attachPtyToSocket(id, session, sock) {
  if (session.dataListener) {
    try { session.dataListener.dispose(); } catch {}
    session.dataListener = null;
  }
  session.socketId = sock.id;
  session.dataListener = session.pty.onData((chunk) => {
    session.buffer += chunk;
    if (session.buffer.length > TERM_BUF_MAX)
      session.buffer = session.buffer.slice(-TERM_BUF_TRIM);
    sock.emit('terminal:data', { id, data: chunk });
  });
}

io.on('connection', (socket) => {
  if (currentTunnelUrl) {
    const subdomain = currentTunnelUrl.replace('https://', '').replace('.trycloudflare.com', '');
    socket.emit('tunnel:url', { url: currentTunnelUrl, shareUrl: `https://ssh.ksw.workers.dev/?token=${subdomain}`, subdomain });
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
      const session = { pty: ptyProcess, socketId: socket.id, buffer: '', killTimer: null, dataListener: null };
      sessions.set(id, session);
      attachPtyToSocket(id, session, socket);
      ptyProcess.onExit(({ exitCode }) => {
        socket.emit('terminal:exit', { id, exitCode });
        sessions.delete(id);
      });
      socket.emit('terminal:created', { id });
    } catch (err) { socket.emit('terminal:error', { id, error: err.message }); }
  });

  // Reconnect to an existing PTY session (e.g. after page refresh)
  socket.on('terminal:reconnect', ({ id, cols, rows }) => {
    const s = sessions.get(id);
    if (!s) { socket.emit('terminal:reconnect:fail', { id }); return; }
    if (s.killTimer) { clearTimeout(s.killTimer); s.killTimer = null; }
    if (cols && rows) { try { s.pty.resize(cols, rows); } catch {} }
    attachPtyToSocket(id, s, socket);
    socket.emit('terminal:replay', { id, buffer: s.buffer });
  });

  socket.on('terminal:input',  ({ id, data }) => { const s = sessions.get(id); if (s) { try { s.pty.write(data); } catch {} } });
  socket.on('terminal:resize', ({ id, cols, rows }) => { const s = sessions.get(id); if (s) { try { s.pty.resize(cols, rows); } catch {} } });
  socket.on('terminal:kill',   ({ id }) => {
    const s = sessions.get(id);
    if (s) { if (s.killTimer) clearTimeout(s.killTimer); try { s.pty.kill(); } catch {} sessions.delete(id); }
  });

  socket.on('disconnect', () => {
    for (const [id, s] of sessions.entries()) {
      if (s.socketId === socket.id) {
        s.socketId = null;
        s.killTimer = setTimeout(() => {
          const ss = sessions.get(id);
          if (ss && !ss.socketId) { try { ss.pty.kill(); } catch {} sessions.delete(id); }
        }, TERM_GRACE_MS);
      }
    }
  });
});

// ===== START =====
(async () => {
  PORT = await resolvePort();

  server.listen(PORT, '0.0.0.0', () => {
    const banner = [
      '',
      '\x1b[36m╔══════════════════════════════════════════════════╗\x1b[0m',
      '\x1b[36m║\x1b[0m  \x1b[1m\x1b[97mKS SSH\x1b[0m — Browser Terminal Manager  \x1b[2mby KS Warrior\x1b[0m  \x1b[36m║\x1b[0m',
      '\x1b[36m╚══════════════════════════════════════════════════╝\x1b[0m',
      '',
      `  \x1b[2mLocal:\x1b[0m    \x1b[4mhttp://localhost:${PORT}\x1b[0m`,
      `  \x1b[2mNetwork:\x1b[0m  \x1b[4mhttp://0.0.0.0:${PORT}\x1b[0m`,
      '',
      '  \x1b[2m⏳ Starting tunnel… Link & Token will appear below.\x1b[0m',
      '',
    ].join('\n');
    process.stdout.write(banner);
    startTunnel();
  });
})();
