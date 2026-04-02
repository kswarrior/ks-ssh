const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const pty = require('node-pty');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ======================
// Auto-install cloudflared (no root)
// ======================
const HOME = os.homedir();
const KSSSH_DIR = path.join(HOME, '.ksssh');
const CLOUDFLARED_PATH = path.join(KSSSH_DIR, 'ks-link');

if (!fs.existsSync(KSSSH_DIR)) {
    fs.mkdirSync(KSSSH_DIR, { recursive: true, mode: 0o700 });
}

async function ensureCloudflared() {
    if (fs.existsSync(CLOUDFLARED_PATH)) {
        console.log('✅ Using local cloudflared');
        return CLOUDFLARED_PATH;
    }

    console.log('Downloading cloudflared (one-time)...');
    const downloadUrl = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';

    return new Promise((resolve) => {
        const curl = spawn('curl', ['-L', '-o', CLOUDFLARED_PATH, downloadUrl]);

        curl.on('close', (code) => {
            if (code === 0) {
                fs.chmodSync(CLOUDFLARED_PATH, 0o755);
                console.log('✅ cloudflared ready');
                resolve(CLOUDFLARED_PATH);
            } else {
                console.error('❌ Download failed');
                process.exit(1);
            }
        });
    });
}

// ======================
// HTML
// ======================
const terminalHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>KS SSH</title>
<script src="https://cdn.jsdelivr.net/npm/xterm@5.5.0/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
<script src="https://cdn.jsdelivr.net/npm/socket.io-client@4.7.5/dist/socket.io.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.5.0/css/xterm.css">
<style>
body,html{margin:0;height:100%;background:#0a0a0a}
#terminal{height:100%}
</style>
</head>
<body>
<div id="terminal"></div>
<script>
const term = new Terminal({cursorBlink:true});
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
const socket = io();

term.open(document.getElementById('terminal'));
fitAddon.fit();

window.addEventListener('resize',()=>fitAddon.fit());

term.onData(d=>socket.emit('input',d));

socket.on('output',d=>term.write(d));

socket.on('sync',buffer=>{
    term.write('\\x1bc');
    term.write(buffer);
});

socket.emit('request-sync');
</script>
</body>
</html>`;

// ======================
// Server
// ======================
app.get('/', (req, res) => res.send(terminalHTML));

// ======================
// SHARED PTY + BUFFER (tmate/sshx style)
// ======================
let ptyProcess = null;
let terminalBuffer = '';
let connectedClients = 0;

function spawnPTY() {
    ptyProcess = pty.spawn('bash', ['-i'], {
        name: 'xterm-256color',
        cwd: process.env.HOME,
        env: { ...process.env, TERM: 'xterm-256color' }
    });

    setTimeout(() => {
        ptyProcess.write(\`PS1='\\\\[\\\\e[32m\\\\]\\\\u@ks-ssh\\\\[\\\\e[0m\\\\]:\\\\[\\\\e[34m\\\\]\\\\w\\\\[\\\\e[0m\\\\]\\\\$ '\n\`);
        ptyProcess.write('clear\n');
    }, 500);

    ptyProcess.onData(data => {
        terminalBuffer += data;
        if (terminalBuffer.length > 50000) {
            terminalBuffer = terminalBuffer.slice(-30000);
        }
        io.emit('output', data);
    });
}

io.on('connection', (socket) => {
    connectedClients++;
    io.emit('users', connectedClients);

    if (!ptyProcess) spawnPTY();

    socket.on('request-sync', () => {
        socket.emit('sync', terminalBuffer);
    });

    socket.on('input', (data) => {
        if (ptyProcess) ptyProcess.write(data);
    });

    socket.on('disconnect', () => {
        connectedClients--;
        io.emit('users', connectedClients);
    });
});

// ======================
// Tunnel
// ======================
let tunnel = null;

function startTunnel(path, port) {
    tunnel = spawn(path, ['tunnel', '--url', \`http://127.0.0.1:\${port}\`]);

    const parse = (d) => {
        const m = d.toString().match(/https:\\/\\/.*trycloudflare.com/);
        if (m) {
            console.log('\\n🔗 ' + m[0] + '\\n');
        }
    };

    tunnel.stdout.on('data', parse);
    tunnel.stderr.on('data', parse);
}

// ======================
// Start
// ======================
server.listen(0, '127.0.0.1', async () => {
    const PORT = server.address().port;
    console.log('Local:', PORT);

    const cf = await ensureCloudflared();
    startTunnel(cf, PORT);
});

// ======================
// Exit
// ======================
process.on('SIGINT', () => {
    if (tunnel) tunnel.kill();
    if (ptyProcess) ptyProcess.kill();
    process.exit(0);
});
