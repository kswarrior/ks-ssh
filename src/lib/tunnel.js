'use strict';

const { spawn, execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');

class TunnelManager {
  constructor(port, io) {
    this.port = port;
    this.io = io;
    this.cfChild = null;
    this.currentUrl = null;
    this.subdomain = null;
    this.shareUrl = null;
  }

  downloadLinker(dest, cb) {
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`;

    const hasWget = (() => { try { execFileSync('wget', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
    const hasCurl = (() => { try { execFileSync('curl', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

    if (hasWget) {
      const dl = spawn('wget', ['-q', '--show-progress', '-O', dest, url], { stdio: ['ignore', 'ignore', 'pipe'] });
      dl.stderr.on('data', d => process.stdout.write(d));
      dl.on('close', code => {
        if (code !== 0) { try { fs.unlinkSync(dest); } catch {} return cb(new Error(`wget exited ${code}`)); }
        try { fs.chmodSync(dest, 0o755); cb(null); } catch (e) { cb(e); }
      });
    } else if (hasCurl) {
      const dl = spawn('curl', ['-L', '--silent', '--show-error', '-o', dest, url], { stdio: ['ignore', 'ignore', 'pipe'] });
      dl.stderr.on('data', d => process.stdout.write(d));
      dl.on('close', code => {
        if (code !== 0) { try { fs.unlinkSync(dest); } catch {} return cb(new Error(`curl exited ${code}`)); }
        try { fs.chmodSync(dest, 0o755); cb(null); } catch (e) { cb(e); }
      });
    } else {
      cb(new Error('Neither wget nor curl found for download'));
    }
  }

  findOrDownloadLinker(cb) {
    const binName = 'ks-ssh-linker';
    const candidates = [
      process.env.KS_SSH_LINKER_BIN,
      binName,
      path.join(os.homedir(), '.local/bin', binName),
      path.join(os.homedir(), binName),
      path.join(__dirname, '..', '..', binName),
    ].filter(Boolean);

    for (const c of candidates) {
      try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return cb(null, c); } catch {}
    }

    const dest = path.join(os.homedir(), '.local', 'bin', binName);
    try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch {}
    console.log('[Tunnel] Downloading ks-ssh-linker...');
    this.downloadLinker(dest, err => { if (err) return cb(err); cb(null, dest); });
  }

  start() {
    this.findOrDownloadLinker((err, bin) => {
      if (err) { console.error('[Tunnel] Failed to acquire linker:', err.message); return; }

      try { execSync('pkill -f "ks-ssh-linker tunnel" 2>/dev/null || true'); } catch {}

      const child = spawn(bin, ['tunnel', '--url', `http://localhost:${this.port}`, '--no-autoupdate', '--protocol', 'http2'], {
        env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe']
      });

      this.cfChild = child;
      let announced = false, buffer = '';

      const processOutput = (data) => {
        buffer += data.toString();
        if (announced) return;
        const match = buffer.match(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com/);
        if (match) {
          announced = true;
          this.subdomain = match[1];
          this.currentUrl = `https://${this.subdomain}.trycloudflare.com`;
          this.shareUrl = `https://ssh.ksw.workers.dev/?token=${this.subdomain}`;

          const banner = `
\x1b[32m  ✓ Tunnel ready!\x1b[0m
\x1b[36m  ┌──────────────────────────────────────────────┐\x1b[0m
\x1b[36m  │\x1b[0m  \x1b[1mLink:\x1b[0m   \x1b[4m\x1b[97mhttps://ssh.ksw.workers.dev/\x1b[0m          \x1b[36m│\x1b[0m
\x1b[36m  │\x1b[0m  \x1b[1mToken:\x1b[0m  \x1b[93m${this.subdomain}\x1b[0m
\x1b[36m  └──────────────────────────────────────────────┘\x1b[0m
`;
          process.stdout.write(banner);
          this.io.emit('tunnel:url', { url: this.currentUrl, shareUrl: this.shareUrl, subdomain: this.subdomain });
        }
      };

      child.stdout.on('data', processOutput);
      child.stderr.on('data', processOutput);

      child.on('exit', (code, sig) => {
        this.cfChild = null; this.currentUrl = null;
        if (sig === 'SIGTERM' || sig === 'SIGKILL') return;
        console.log(`[Tunnel] Linker exited (${code}), restarting in 10s...`);
        setTimeout(() => this.start(), 10000);
      });
    });
  }

  stop() {
    if (this.cfChild) { try { this.cfChild.kill('SIGTERM'); } catch {} }
  }

  getInfo() {
    return {
      active: !!this.currentUrl,
      url: this.currentUrl,
      shareUrl: this.shareUrl,
      token: this.subdomain,
      subdomain: this.subdomain
    };
  }
}

module.exports = TunnelManager;
