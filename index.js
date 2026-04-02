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
// Auto-install cloudflared (unchanged)
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
    return new Promise((resolve, reject) => {
        const curl = spawn('curl', ['-L', '-o', CLOUDFLARED_PATH, downloadUrl]);
        curl.on('close', (code) => {
            if (code === 0) {
                fs.chmodSync(CLOUDFLARED_PATH, '0755');
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
// UPDATED HTML + JS (Real SSH prompt + chat + presence)
// ======================
const terminalHTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>KS SSH • Real Terminal</title>
    <script src="https://cdn.jsdelivr.net/npm/xterm@5.5.0/lib/xterm.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/socket.io-client@4.7.5/dist/socket.io.js"></script>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.5.0/css/xterm.css">
    <style>
        :root { --accent: #00ff9d; --bg: #0a0a0a; }
        body, html {
            margin: 0; padding: 0; height: 100%; background: var(--bg); overflow: hidden;
            font-family: 'Inter', system-ui, sans-serif;
        }
        #terminal { width: 100%; height: 100%; }
        .header {
            position: absolute; top: 0; left: 0; right: 0; background: rgba(10,10,10,0.95);
            color: var(--accent); padding: 12px 20px; font-size: 14px; z-index: 1000;
            display: flex; align-items: center; gap: 12px; backdrop-filter: blur(12px);
            border-bottom: 1px solid rgba(0,255,157,0.2);
        }
        .header span:first-child { font-size: 18px; font-weight: 600; letter-spacing: -0.5px; }
        .status { margin-left: auto; display: flex; align-items: center; gap: 8px; font-size: 13px; }
        .dot { width: 8px; height: 8px; background: var(--accent); border-radius: 50%; animation: pulse 2s infinite; }
        .users { font-size: 13px; background: rgba(0,255,157,0.1); padding: 2px 8px; border-radius: 9999px; }
        .chat-container {
            position: absolute; bottom: 12px; left: 20px; right: 20px; height: 180px;
            background: rgba(10,10,10,0.95); border: 1px solid rgba(0,255,157,0.2);
            border-radius: 12px; z-index: 1000; display: flex; flex-direction: column; overflow: hidden;
            backdrop-filter: blur(12px);
        }
        .chat-messages {
            flex: 1; overflow-y: auto; padding: 12px; font-size: 13px; color: #ddd; line-height: 1.4;
        }
        .chat-input {
            display: flex; border-top: 1px solid rgba(0,255,157,0.2); padding: 8px;
        }
        .chat-input input {
            flex: 1; background: transparent; border: none; color: #fff; outline: none; font-size: 14px;
        }
        .footer {
            position: absolute; bottom: 210px; left: 0; right: 0; text-align: center;
            font-size: 11px; color: rgba(0,255,157,0.4); pointer-events: none; z-index: 10;
        }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
    </style>
</head>
<body>
    <div class="header">
        <span>KS SSH • Real Terminal</span>
        <div class="status">
            <span id="users-count">1 connected</span>
            <div class="dot"></div>
            <span id="latency" style="font-size:12px; opacity:0.6;">0ms</span>
        </div>
    </div>
    <div id="terminal"></div>

    <!-- Chat (sshx-style collaboration) -->
    <div class="chat-container">
        <div class="chat-messages" id="chat-messages"></div>
        <div class="chat-input">
            <input id="chat-input" type="text" placeholder="Chat with others (Enter to send) • Type /help for commands" autocomplete="off">
        </div>
    </div>

    <div class="footer">
        Real SSH-like session • Shared bash • End-to-end visible (self-hosted) • Type any command
    </div>

    <script>
        const term = new Terminal({
            cursorBlink: true,
            theme: { background: '#0a0a0a', foreground: '#00ff9d', cursor: '#00ff9d' },
            fontFamily: 'Menlo, Monaco, "Courier New", monospace',
            fontSize: 15, lineHeight: 1.3, scrollback: 10000,
            allowTransparency: true
        });
        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        const socket = io();

        term.open(document.getElementById('terminal'));
        fitAddon.fit();

        window.addEventListener('resize', () => setTimeout(() => fitAddon.fit(), 100));

        // Input → server
        term.onData(data => socket.emit('input', data));

        // Output from shared PTY
        socket.on('output', data => term.write(data));

        // Chat (sshx-style real-time collaboration)
        const chatMessages = document.getElementById('chat-messages');
        const chatInput = document.getElementById('chat-input');

        socket.on('chat', (msg) => {
            const time = new Date().toLocaleTimeString('en-US', {hour12:false, hour:'2-digit', minute:'2-digit'});
            const html = `<span style="color:#00ff9d">[${time}] </span><strong>${msg.user}:</strong> ${msg.text}<br>`;
            chatMessages.innerHTML += html;
            chatMessages.scrollTop = chatMessages.scrollHeight;
        });

        chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && chatInput.value.trim()) {
                const text = chatInput.value.trim();
                if (text === '/help') {
                    term.writeln('\r\n\x1b[32mKS SSH commands:\x1b[0m');
                    term.writeln('  /clear     - Clear terminal');
                    term.writeln('  /users     - Show connected users');
                    term.writeln('  /ping      - Latency test');
                } else if (text === '/clear') {
                    term.clear();
                } else if (text === '/users') {
                    socket.emit('get-users');
                } else if (text === '/ping') {
                    const start = Date.now();
                    socket.emit('ping');
                    socket.once('pong', () => {
                        const latency = Date.now() - start;
                        term.writeln(`\r\n\x1b[32mPong! Latency: ${latency}ms\x1b[0m`);
                    });
                } else {
                    socket.emit('chat', { text });
                }
                chatInput.value = '';
            }
        });

        // Connected users (tmate/sshx-style presence)
        socket.on('users', (count) => {
            document.getElementById('users-count').textContent = `${count} connected`;
        });

        // Initial banner — feels exactly like a real SSH login
        term.writeln('\x1b[32m╔════════════════════════════════════════════════════╗');
        term.writeln('║               KS SSH — REAL TERMINAL               ║');
        term.writeln('║  You are now in a shared bash session (like SSH)   ║');
        term.writeln('╚════════════════════════════════════════════════════╝\x1b[0m');
        term.writeln('\r\n\x1b[90mConnected via Cloudflare Tunnel • All inputs are shared\x1b[0m\r\n');

        term.focus();

        // Auto-fit on load
        setTimeout(() => fitAddon.fit(), 300);
    </script>
</body>
</html>`; // ← Paste the entire HTML block I gave above here (it's long, so I put it separately for clarity)

app.get('/', (req, res) => res.send(terminalHTML));

// ======================
// SHARED PTY + REAL SSH PROMPT (the magic)
// ======================
let ptyProcess = null;
let connectedClients = 0;

io.on('connection', (socket) => {
    console.log(`[+] New client connected (${++connectedClients} total)`);
    io.emit('users', connectedClients);

    if (!ptyProcess) {
        console.log('Spawning shared bash PTY (real SSH-like session)...');
        ptyProcess = pty.spawn('bash', ['-i'], {    // -i = interactive login shell
            name: 'xterm-256color',
            cwd: process.env.HOME || '/root',
            env: { ...process.env, TERM: 'xterm-256color' }
        });

        // === REAL SSH PROMPT ===
        // This runs once when PTY starts → gives you exactly "${path} ~ $" style
        setTimeout(() => {
            ptyProcess.write(`PS1='\\[\\e[32m\\]\\u@ks-ssh\\[\\e[0m\\]:\\[\\e[34m\\]\\w\\[\\e[0m\\]\\$ '\n`);
            ptyProcess.write('clear\n'); // clean start
        }, 800);

        ptyProcess.onData((data) => io.emit('output', data));
    }

    // Input from any client goes to the shared PTY (tmate-style)
    socket.on('input', (data) => {
        if (ptyProcess) ptyProcess.write(data);
    });

    // Chat (sshx collaboration)
    socket.on('chat', (msg) => {
        const username = `guest-${socket.id.slice(0,6)}`;
        io.emit('chat', { user: username, text: msg.text });
    });

    socket.on('get-users', () => {
        socket.emit('users', connectedClients);
    });

    socket.on('ping', () => socket.emit('pong'));

    socket.on('disconnect', () => {
        console.log(`[-] Client disconnected (${--connectedClients} total)`);
        io.emit('users', connectedClients);
    });
});

// ======================
// Cloudflare Tunnel (unchanged)
// ======================
let tunnel = null;
let PORT = null;

function startTunnel(cloudflaredPath, port) {
    console.log(`Starting Cloudflare Tunnel on port ${port}...`);
    tunnel = spawn(cloudflaredPath, ['tunnel', '--url', `http://127.0.0.1:${port}`]);

    const checkForUrl = (data) => {
        const output = data.toString();
        const urlMatch = output.match(/https:\/\/([a-z0-9.-]+)\.trycloudflare\.com/);
        if (urlMatch) {
            const publicUrl = `https://${urlMatch[1]}.trycloudflare.com`;
            console.log('\n✅ TUNNEL READY');
            console.log('🔗 Your real SSH terminal link:');
            console.log(publicUrl);
            console.log('\nOpen in any browser — feels exactly like SSH!\n');
        }
    };

    tunnel.stdout.on('data', checkForUrl);
    tunnel.stderr.on('data', checkForUrl);
}

// Start server
server.listen(0, '127.0.0.1', async () => {
    const addr = server.address();
    PORT = addr.port;
    console.log(`Local server ready on http://127.0.0.1:${PORT}`);

    const cloudflaredPath = await ensureCloudflared();
    startTunnel(cloudflaredPath, PORT);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down KS SSH...');
    if (tunnel) tunnel.kill();
    if (ptyProcess) ptyProcess.kill();
    process.exit(0);
});
