'use strict';

const { execSync } = require('child_process');
const fs = require('fs');

class PortScanner {
  constructor() {}

  scan() {
    const ports = [];
    const seen = new Set();
    let output = '';

    const cmds = ['ss -Htlnp', 'ss -tlnp', 'netstat -tlnp 2>/dev/null'];
    for (const cmd of cmds) {
      try { output = execSync(cmd, { encoding: 'utf8', timeout: 2000 }); if (output.trim()) break; } catch {}
    }

    for (const line of output.split('\n')) {
      const m = line.match(/(?:0\.0\.0\.0|127\.0\.0\.1|\[::\]|\[::1\]|::|\*|::1|::0):(\d+)/);
      if (!m) continue;
      const port = parseInt(m[1]);
      if (!port || port > 65535 || seen.has(port)) continue;
      seen.add(port);

      let processName = 'unknown';
      const pm = line.match(/users:\(\("([^"]+)"/) || line.match(/"([^"]+)"\/\d+/) || line.match(/\d+\/([^ \n]+)/);
      if (pm) processName = pm[1];

      const isPublic = line.includes('0.0.0.0') || line.includes('*') || line.includes('[::]') || line.includes(':::');
      ports.push({ port, process: processName, address: isPublic ? '0.0.0.0' : '127.0.0.1' });
    }

    if (!ports.length) {
      try {
        ['/proc/net/tcp', '/proc/net/tcp6'].forEach(file => {
          if (!fs.existsSync(file)) return;
          fs.readFileSync(file, 'utf8').split('\n').slice(1).forEach(l => {
            const c = l.trim().split(/\s+/);
            if (c[3] !== '0A') return;
            const p = parseInt(c[1].split(':')[1], 16);
            if (p && !seen.has(p)) { seen.add(p); ports.push({ port: p, process: 'unknown', address: '0.0.0.0' }); }
          });
        });
      } catch {}
    }

    return ports.sort((a, b) => a.port - b.port);
  }
}

module.exports = PortScanner;
