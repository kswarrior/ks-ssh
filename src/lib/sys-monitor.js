'use strict';

const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');

class SystemMonitor {
  constructor() {
    this.prevCpu = [];
    this.cachedIp = 'Loading...';
    this.lastIpFetch = 0;
    this.cachedSystemInfo = null;
    this._init();
  }

  async _init() {
    this.prevCpu = await this._readCpu();
    this._fetchIp();
    this._cacheSystemInfo();
  }

  _cacheSystemInfo() {
    let osName = os.type();
    let logo = '🐧';
    let pkgs = 'N/A';

    try {
      if (fs.existsSync('/etc/os-release')) {
        const release = fs.readFileSync('/etc/os-release', 'utf8');
        const nameMatch = release.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
        if (nameMatch) osName = nameMatch[1];

        const idMatch = release.match(/^ID=([^"\n]+)/m);
        const osId = idMatch ? idMatch[1].toLowerCase() : '';

        if (osId.includes('ubuntu')) {
          logo = `
         _
     ---(_)---
   /  /  |  \\  \\
  |  |   |   |  |
   \\  \\  |  /  /
     ---(_)---
`;
        } else if (osId.includes('debian')) {
          logo = `
      _____
     /  __ \\
    /  /  \\_|
    |  |
    \\  \\__/|
     \\____/
`;
        } else if (osId.includes('centos')) {
          logo = `
     _______
    / _____ \\
   / /     \\ \\
   | |     | |
   \\ \\_____/ /
    \\_______/
`;
        } else if (osId.includes('arch')) {
          logo = `
       /\\
      /  \\
     /    \\
    /      \\
   /   /\\   \\
  /___/  \\___\\
`;
        }
      }
    } catch {}

    try {
      if (fs.existsSync('/usr/bin/dpkg')) {
        pkgs = execSync('dpkg-query -f \'${binary:Package}\\n\' -W | wc -l', { encoding: 'utf8', timeout: 500 }).trim() + ' (dpkg)';
      } else if (fs.existsSync('/usr/bin/rpm')) {
        pkgs = execSync('rpm -qa | wc -l', { encoding: 'utf8', timeout: 500 }).trim() + ' (rpm)';
      }
    } catch {}

    this.cachedSystemInfo = { osName, logo, pkgs };
  }

  _fetchIp() {
    if (this.lastIpFetch && (Date.now() - this.lastIpFetch < 300000)) return;

    // Fallback to local immediately if we have nothing
    if (this.cachedIp === 'Loading...') this._fallbackIp();

    const { exec } = require('child_process');
    exec('curl -s --max-time 3 https://ifconfig.me', (error, stdout) => {
      if (!error && stdout && stdout.trim()) {
        this.cachedIp = stdout.trim();
        this.lastIpFetch = Date.now();
      } else {
        this._fallbackIp();
      }
    });
  }

  _fallbackIp() {
    try {
      const nets = os.networkInterfaces();
      for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
          if (net.family === 'IPv4' && !net.internal) {
            this.cachedIp = net.address;
            return;
          }
        }
      }
    } catch {}
  }

  async _readCpu() {
    try {
      const data = await fs.promises.readFile('/proc/stat', 'utf8');
      const lines = data.split('\n').filter(l => /^cpu/.test(l));
      return lines.map(line => {
        const nums = line.split(/\s+/).slice(1).map(Number);
        return { total: nums.reduce((a, b) => a + b, 0), idle: nums[3] + (nums[4] || 0) };
      });
    } catch { return []; }
  }

  async getStats() {
    const currentCpu = await this._readCpu();
    if (this.prevCpu.length === 0) {
      this.prevCpu = currentCpu;
      return {
        ram: { total: 0, used: 0, percent: 0 },
        cpu: { percent: 0, cores: [], model: '', count: 0 },
        disk: { total: 0, used: 0, percent: 0 },
        network: { in: 0, out: 0 },
        temp: null
      };
    }
    const calcPct = (a, b) => {
      if (!a || !b) return 0;
      const td = b.total - a.total, id = b.idle - a.idle;
      return td > 0 ? ((td - id) / td) * 100 : 0;
    };

    const cpuPercent = calcPct(this.prevCpu[0], currentCpu[0]);
    const corePercents = this.prevCpu.slice(1).map((c, i) => calcPct(c, currentCpu[i + 1]));

    // Update for next call
    this.prevCpu = currentCpu;

    const totalMem = os.totalmem(), freeMem = os.freemem(), usedMem = totalMem - freeMem;

    let diskTotal = 0, diskUsed = 0;
    try {
      const dfOut = execSync('df -k / 2>/dev/null', { encoding: 'utf8', timeout: 500 });
      const parts = dfOut.trim().split('\n')[1]?.trim().split(/\s+/) || [];
      if (parts.length >= 3) { diskTotal = parseInt(parts[1]) * 1024; diskUsed = parseInt(parts[2]) * 1024; }
    } catch {}

    let cpuModel = '';
    try {
      const info = await fs.promises.readFile('/proc/cpuinfo', 'utf8');
      const m = info.match(/model name\s*:\s*(.+)/);
      if (m) cpuModel = m[1].trim().replace(/\s+/g, ' ');
    } catch {}

    let netIn = 0, netOut = 0;
    try {
      const data = await fs.promises.readFile('/proc/net/dev', 'utf8');
      const devs = data.split('\n').slice(2);
      for (const line of devs) {
        const p = line.trim().split(/\s+/);
        if (p.length > 9 && !p[0].startsWith('lo:')) { netIn += parseInt(p[1]) || 0; netOut += parseInt(p[9]) || 0; }
      }
    } catch {}

    let temp = null;
    try {
      if (fs.existsSync('/sys/class/thermal/thermal_zone0/temp')) {
        const t = (await fs.promises.readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8')).trim();
        if (t) temp = parseInt(t) / 1000;
      }
    } catch {}

    return {
      ram: { total: totalMem / 1073741824, used: usedMem / 1073741824, percent: (usedMem / totalMem) * 100 },
      cpu: { percent: cpuPercent, cores: corePercents, model: cpuModel, count: corePercents.length },
      disk: { total: diskTotal / 1073741824, used: diskUsed / 1073741824, percent: diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0 },
      network: { in: netIn, out: netOut },
      temp
    };
  }

  getSystemInfo() {
    this._fetchIp();

    const info = this.cachedSystemInfo || { osName: os.type(), logo: '🐧', pkgs: 'N/A' };

    return {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      uptime: os.uptime(),
      memory: { free: os.freemem(), total: os.totalmem(), used: os.totalmem() - os.freemem() },
      loadAvg: os.loadavg(),
      cpus: os.cpus().length,
      home: os.homedir(),
      user: os.userInfo().username,
      ip: this.cachedIp,
      osName: info.osName,
      kernel: os.release(),
      shell: process.env.SHELL || '/bin/sh',
      packages: info.pkgs,
      logo: info.logo
    };
  }
}

module.exports = SystemMonitor;
