'use strict';

const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');

class SystemMonitor {
  constructor() {
    this.prevCpu = this._readCpu();
  }

  _readCpu() {
    try {
      const lines = fs.readFileSync('/proc/stat', 'utf8').split('\n').filter(l => /^cpu/.test(l));
      return lines.map(line => {
        const nums = line.split(/\s+/).slice(1).map(Number);
        return { total: nums.reduce((a, b) => a + b, 0), idle: nums[3] + (nums[4] || 0) };
      });
    } catch { return []; }
  }

  getStats() {
    const currentCpu = this._readCpu();
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
      const info = fs.readFileSync('/proc/cpuinfo', 'utf8');
      const m = info.match(/model name\s*:\s*(.+)/);
      if (m) cpuModel = m[1].trim().replace(/\s+/g, ' ');
    } catch {}

    let netIn = 0, netOut = 0;
    try {
      const devs = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
      for (const line of devs) {
        const p = line.trim().split(/\s+/);
        if (p.length > 9 && !p[0].startsWith('lo:')) { netIn += parseInt(p[1]) || 0; netOut += parseInt(p[9]) || 0; }
      }
    } catch {}

    let temp = null;
    try {
      if (fs.existsSync('/sys/class/thermal/thermal_zone0/temp')) {
        const t = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim();
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
    return {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      uptime: os.uptime(),
      memory: { free: os.freemem(), total: os.totalmem(), used: os.totalmem() - os.freemem() },
      loadAvg: os.loadavg(),
      cpus: os.cpus().length,
      home: os.homedir(),
      user: os.userInfo().username
    };
  }
}

module.exports = SystemMonitor;
