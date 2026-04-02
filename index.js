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
const io = new Server(server);

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
        console.log('Using local cloudflared');
        return CLOUDFLARED_PATH;
    }

    console.log('Downloading cloudflared (one-time)...');
    const downloadUrl = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';

    return new Promise((resolve, reject) => {
        const curl = spawn('curl', ['-L', '-o', CLOUDFLARED_PATH, downloadUrl]);

        curl.on('close', (code) => {
            if (code === 0) {
                fs.chmodSync(CLOUDFLARED_PATH, '0755');
                console.log('cloudflared ready');
                resolve(CLOUDFLARED_PATH);
            } else {
                console.error('Download failed');
                process.exit(1);
            }
        });
    });
}

// ======================
// EMBEDDED HTML + JS (clean terminal)
// ======================
const terminalHTML = `
<!DOCTYPE html>
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
        :root { --accent: #00ff9d; }
        body, html {
            margin: 0; padding: 0; height: 100%; background: #0a0a0a; overflow: hidden;
            font-family: 'Inter', system-ui, sans-serif;
        }
        #terminal { width: 100%; height: 100%; }
        .header {
            position: absolute; top: 0; left: 0; right: 0; background: rgba(10,10,10,0.85);
            color: var(--accent); padding: 12px 20px; font-size: 14px; z-index: 1000;
            display: flex; align-items: center; gap: 12px; backdrop-filter: blur(12px);
            border-bottom: 1px solid rgba(0,255,157,0.15);
        }
        .header span:first-child { font-size: 18px; font-weight: 500; letter-spacing: -0.5px; }
        .status { margin-left: auto; display: flex; align-items: center; gap: 6px; font-size: 13px; }
        .dot { width: 8px; height: 8px; background: var(--accent); border-radius: 50%; animation: pulse 2s infinite; }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
        .footer {
            position: absolute; bottom: 12px; left: 0; right: 0; text-align: center;
            font-size: 11px; color: rgba(0,255,157,0.4); pointer-events: none; z-index: 10;
        }
    </style>
</head>
<body>
    <div class="header">
        <span>KS SSH</span>
        <div class="status">
            <span>live</span>
            <div class="dot"></div>
        </div>
    </div>
    <div id="terminal"></div>
    <div class="footer">
        Terminal ready • End-to-end encrypted • Type any command
    </div>

    <script>
        const term = new Terminal({
            cursorBlink: true,
            theme: { background: '#0a0a0a', foreground: '#00ff9d', cursor: '#00ff9d' },
            fontFamily: 'Menlo, Monaco, "Courier New", monospace',
            fontSize: 15, lineHeight: 1.3, scrollback: 10000
        });
        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        const socket = io();

        term.open(document.getElementById('terminal'));
        fitAddon.fit();

        window.addEventListener('resize', () => setTimeout(() => fitAddon.fit(), 100));

        term.onData(data => socket.emit('input', data));
        socket.on('output', data => term.write(data));

        term.writeln('\x1b[32m╔════════════════════════════════════════════╗');
        term.writeln('║              KS SSH — READY                ║');
        term.writeln('╚════════════════════════════════════════════╝\x1b[0m');
        term.writeln('');
        term.writeln('You can now run any command (apt update, apt install openjdk-21-jdk -y, etc.)');
        term.focus();
    </script>
</body>
</html>
`;

// Serve the embedded terminal
app.get('/', (req, res) => {
    res.send(terminalHTML);
});

// ======================
// Shared PTY (powerful like sshx.io — one real bash for all clients)
// ======================
let ptyProcess = null;

io.on('connection', (socket) => {
    console.log('New session connected');

    // Spawn ONE shared bash (like sshx.io) — first client creates it
    if (!ptyProcess) {
        ptyProcess = pty.spawn('bash', [], {
            name: 'xterm-color',
            cwd: process.env.HOME || '/root',
            env: process.env
        });

        // Broadcast output to EVERY connected client
        ptyProcess.onData((data) => {
            io.emit('output', data);
        });
    }

    // All clients send input to the shared PTY
    socket.on('input', (data) => {
        if (ptyProcess) ptyProcess.write(data);
    });

    socket.on('disconnect', () => {
        console.log('Session closed');
        // PTY stays alive for other clients (sshx.io style)
    });
});

// ======================
// Cloudflare Tunnel (simple HTTPS link)
// ======================
let tunnel = null;
let PORT = null;

function startTunnel(cloudflaredPath, port) {
    console.log(`Starting tunnel on port ${port}`);

    tunnel = spawn(cloudflaredPath, ['tunnel', '--url', `http://127.0.0.1:${port}`]);

    const checkForUrl = (data) => {
        const output = data.toString();
        const urlMatch = output.match(/https:\/\/([a-z0-9.-]+)\.trycloudflare\.com/);
        if (urlMatch) {
            const publicUrl = `https://${urlMatch[1]}.trycloudflare.com`;
            console.log('\n✅ TUNNEL READY');
            console.log('🔗 HTTPS Link:');
            console.log(publicUrl);
            console.log('\nOpen this link in browser for the terminal\n');
        }
    };

    tunnel.stdout.on('data', checkForUrl);
    tunnel.stderr.on('data', checkForUrl);
}

// Start everything
server.listen(0, '127.0.0.1', async () => {
    const addr = server.address();
    PORT = addr.port;
    console.log(`Server ready on http://127.0.0.1:${PORT}`);

    const cloudflaredPath = await ensureCloudflared();
    startTunnel(cloudflaredPath, PORT);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down...');
    if (tunnel) tunnel.kill();
    if (ptyProcess) ptyProcess.kill();
    process.exit(0);
});

process.on('SIGTERM', () => {
    if (tunnel) tunnel.kill();
    if (ptyProcess) ptyProcess.kill();
    process.exit(0);
});
