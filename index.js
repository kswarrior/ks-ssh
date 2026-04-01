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

// Path to the Unix Socket file
const SOCKET_PATH = '/tmp/sshx.sock';

// Clean up existing socket file if it exists
if (fs.existsSync(SOCKET_PATH)) {
    fs.unlinkSync(SOCKET_PATH);
}

// ======================
// Auto-install cloudflared (no root required)
// ======================
const HOME = os.homedir();
const KSSSH_DIR = path.join(HOME, '.ksssh');
const CLOUDFLARED_PATH = path.join(KSSSH_DIR, 'ks-link');

if (!fs.existsSync(KSSSH_DIR)) {
    fs.mkdirSync(KSSSH_DIR, { recursive: true, mode: 0o700 });
}

async function ensureCloudflared() {
    // Already exists → use it
    if (fs.existsSync(CLOUDFLARED_PATH)) {
        console.log(`✅ Using local Cloudflare Tunnel: ${CLOUDFLARED_PATH}`);
        return CLOUDFLARED_PATH;
    }

    console.log('🔧 cloudflared not found — downloading automatically (one-time only)...');
    console.log('   Saving as \~/.ksssh/ks-link (works without root anywhere)');

    const downloadUrl = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';

    return new Promise((resolve, reject) => {
        const curl = spawn('curl', ['-L', '--progress-bar', '-o', CLOUDFLARED_PATH, downloadUrl]);

        curl.stdout.on('data', (data) => process.stdout.write(data)); // show progress
        curl.stderr.on('data', (data) => process.stderr.write(data));

        curl.on('close', (code) => {
            if (code === 0) {
                fs.chmodSync(CLOUDFLARED_PATH, '0755'); // make executable
                console.log('✅ cloudflared downloaded & ready → \~/.ksssh/ks-link');
                resolve(CLOUDFLARED_PATH);
            } else {
                console.error('❌ Download failed. Please install cloudflared manually.');
                process.exit(1);
            }
        });
    });
}

// ======================
// TERMINAL VIEW (embedded HTML - served at root)
// ======================
const terminalHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SSHX Terminal</title>
    <script src="https://cdn.jsdelivr.net/npm/xterm@5.5.0/lib/xterm.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/socket.io-client@4.7.5/dist/socket.io.js"></script>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.5.0/css/xterm.css">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
        body, html { margin:0; padding:0; height:100%; background:#0a0a0a; overflow:hidden; font-family:'Inter',sans-serif; }
        #terminal { width:100%; height:100%; }
        .header {
            position: absolute; top: 0; left: 0; right: 0;
            background: rgba(0,0,0,0.7); color: #00ff9d; padding: 8px 16px;
            font-size: 13px; z-index: 100; display: flex; align-items: center; gap: 8px;
            backdrop-filter: blur(8px);
        }
    </style>
</head>
<body>
    <div class="header">
        <span>🚀 SSHX</span>
        <span style="opacity:0.6">— Secure Web Terminal</span>
        <span style="margin-left:auto; font-size:11px; opacity:0.5;">Connected via Cloudflare Tunnel</span>
    </div>
    <div id="terminal"></div>

    <script>
        const term = new Terminal({
            cursorBlink: true,
            theme: {
                background: '#0a0a0a',
                foreground: '#00ff9d',
                cursor: '#00ff9d'
            },
            fontFamily: 'Menlo, Monaco, "Courier New", monospace',
            fontSize: 15,
            lineHeight: 1.2
        });

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);

        const socket = io();

        term.open(document.getElementById('terminal'));
        fitAddon.fit();

        window.addEventListener('resize', () => fitAddon.fit());

        term.onData(data => socket.emit('input', data));
        socket.on('output', data => term.write(data));

        term.writeln('\\x1b[32mSSHX Terminal ready! Type any command...\\x1b[0m');
        term.focus();
    </script>
</body>
</html>
`;

// Serve the embedded terminal view at root (iframe loads this)
app.get('/', (req, res) => {
    res.send(terminalHTML);
});

// ======================
// Socket.IO for real-time terminal
// ======================
io.on('connection', (socket) => {
    console.log('👤 New terminal session connected');

    const ptyProcess = pty.spawn('bash', [], {
        name: 'xterm-color',
        cwd: process.env.HOME || '/root',
        env: process.env
    });

    ptyProcess.onData((data) => socket.emit('output', data));
    socket.on('input', (data) => ptyProcess.write(data));

    socket.on('disconnect', () => {
        console.log('👋 Terminal session closed');
        ptyProcess.kill();
    });
});

// ======================
// Cloudflare Tunnel (now uses local \~/.ksssh/ks-link)
// ======================
let tunnel = null;

function startTunnel(cloudflaredPath) {
    console.log('🌐 Launching Cloudflare Tunnel (unix socket backend)...');

    tunnel = spawn(cloudflaredPath, ['tunnel', '--url', `unix:${SOCKET_PATH}`]);

    const checkForUrl = (data) => {
        const output = data.toString();
        const urlMatch = output.match(/https:\/\/([a-z0-9.-]+)\.trycloudflare\.com/);
        if (urlMatch) {
            const subdomain = urlMatch[1];
            const publicUrl = `https://ks-ssh.pages.dev/token=${subdomain}`;

            console.log('\n' + '⭐'.repeat(25));
            console.log('🎉 TUNNEL IS LIVE — NO PORTS USED!');
            console.log('🔗 Your public URL (hidden behind ks-ssh.pages.dev):');
            console.log('   ' + publicUrl);
            console.log('   (Share this link — Cloudflare URL is completely hidden)');
            console.log('⭐'.repeat(25) + '\n');
            console.log('💡 Tip: Open the URL in your browser and enjoy the terminal!');
        }
    };

    tunnel.stdout.on('data', checkForUrl);
    tunnel.stderr.on('data', checkForUrl);

    tunnel.on('close', (code) => {
        if (code !== 0) console.log(`⚠️ Tunnel closed with code ${code}.`);
    });
}

// Start server on Unix socket
server.listen(SOCKET_PATH, async () => {
    fs.chmodSync(SOCKET_PATH, '0777');

    console.log(`✅ Express + Socket.IO ready on Unix socket: ${SOCKET_PATH}`);
    console.log('   Everything is set — starting tunnel now...\n');

    // Auto-download cloudflared if needed, then start tunnel
    const cloudflaredPath = await ensureCloudflared();
    startTunnel(cloudflaredPath);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Gracefully shutting down SSHX...');
    if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
    if (tunnel) tunnel.kill();
    console.log('✅ Clean exit. Thanks for using SSHX! 👋');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Received SIGTERM — shutting down gracefully...');
    if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
    if (tunnel) tunnel.kill();
    process.exit(0);
});
