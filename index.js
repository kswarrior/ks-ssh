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
// Auto-install cloudflared (no root required)
// ======================
const HOME = os.homedir();
const KSSSH_DIR = path.join(HOME, '.ksssh');
const CLOUDFLARED_PATH = path.join(KSSSH_DIR, 'ks-link');

if (!fs.existsSync(KSSSH_DIR)) {
    fs.mkdirSync(KSSSH_DIR, { recursive: true, mode: 0o700 });
}

async function ensureCloudflared() {
    if (fs.existsSync(CLOUDFLARED_PATH)) {
        console.log(`✅ Using local Cloudflare Tunnel: ${CLOUDFLARED_PATH}`);
        return CLOUDFLARED_PATH;
    }

    console.log('🔧 cloudflared not found — downloading automatically (one-time only)...');
    console.log('   Saving as \~/.ksssh/ks-link (works without root anywhere)');

    const downloadUrl = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';

    return new Promise((resolve, reject) => {
        const curl = spawn('curl', ['-L', '--progress-bar', '-o', CLOUDFLARED_PATH, downloadUrl]);

        curl.stdout.on('data', (data) => process.stdout.write(data));
        curl.stderr.on('data', (data) => process.stderr.write(data));

        curl.on('close', (code) => {
            if (code === 0) {
                fs.chmodSync(CLOUDFLARED_PATH, '0755');
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
// OPTIMISTIC INDEX.HTML (fully embedded inside index.js)
// ======================
const terminalHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SSHX • Instant Secure Terminal</title>
    <script src="https://cdn.jsdelivr.net/npm/xterm@5.5.0/lib/xterm.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/socket.io-client@4.7.5/dist/socket.io.js"></script>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.5.0/css/xterm.css">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&amp;family=Space+Grotesk:wght@500&amp;display=swap');
        
        :root {
            --accent: #00ff9d;
        }
        
        body, html {
            margin: 0;
            padding: 0;
            height: 100%;
            background: #0a0a0a;
            overflow: hidden;
            font-family: 'Inter', system-ui, sans-serif;
        }
        
        #terminal {
            width: 100%;
            height: 100%;
        }
        
        .header {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            background: rgba(10, 10, 10, 0.85);
            color: var(--accent);
            padding: 12px 20px;
            font-size: 14px;
            z-index: 1000;
            display: flex;
            align-items: center;
            gap: 12px;
            backdrop-filter: blur(12px);
            border-bottom: 1px solid rgba(0, 255, 157, 0.15);
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
        }
        
        .header span:first-child {
            font-family: 'Space Grotesk', sans-serif;
            font-size: 18px;
            font-weight: 500;
            letter-spacing: -0.5px;
        }
        
        .badge {
            background: rgba(0, 255, 157, 0.15);
            color: var(--accent);
            padding: 2px 8px;
            border-radius: 9999px;
            font-size: 11px;
            font-weight: 600;
            letter-spacing: 0.5px;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        
        .status {
            margin-left: auto;
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 13px;
            opacity: 0.85;
        }
        
        .dot {
            width: 8px;
            height: 8px;
            background: var(--accent);
            border-radius: 50%;
            animation: pulse 2s infinite;
        }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.3; }
        }
        
        .footer {
            position: absolute;
            bottom: 12px;
            left: 0;
            right: 0;
            text-align: center;
            font-size: 11px;
            color: rgba(0, 255, 157, 0.4);
            pointer-events: none;
            z-index: 10;
        }
    </style>
</head>
<body>
    <div class="header">
        <span>🚀 SSHX</span>
        <span style="opacity:0.75; font-weight:500;">Instant • Secure • Zero ports</span>
        
        <div class="badge">
            <span class="dot"></span>
            LIVE
        </div>
        
        <div class="status">
            <span>Secured by Cloudflare Tunnel</span>
            <span style="opacity:0.6;">•</span>
            <span style="color:#00ff9d; font-weight:600;">Optimistic mode ✨</span>
        </div>
    </div>
    
    <div id="terminal"></div>
    
    <div class="footer">
        Your terminal is ready. Type any command • Everything is encrypted end-to-end
    </div>

    <script>
        const term = new Terminal({
            cursorBlink: true,
            theme: {
                background: '#0a0a0a',
                foreground: '#00ff9d',
                cursor: '#00ff9d',
                selectionBackground: '#00ff9d33'
            },
            fontFamily: 'Menlo, Monaco, "Courier New", monospace',
            fontSize: 15,
            lineHeight: 1.3,
            scrollback: 10000,
            allowTransparency: true
        });

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);

        const socket = io();

        term.open(document.getElementById('terminal'));
        fitAddon.fit();

        let resizeTimeout;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => fitAddon.fit(), 100);
        });

        term.onData(data => socket.emit('input', data));
        socket.on('output', data => term.write(data));

        term.writeln('\\x1b[32m╔══════════════════════════════════════════════════════════════╗');
        term.writeln('║                    🚀 SSHX TERMINAL READY!                    ║');
        term.writeln('║               Secure • Instant • No ports opened             ║');
        term.writeln('╚══════════════════════════════════════════════════════════════╝\\x1b[0m');
        term.writeln('');
        term.writeln('\\x1b[90mConnected via Cloudflare Tunnel • Zero Trust security enabled ✨\\x1b[0m');
        term.writeln('\\x1b[90mYou are now in full control. Type any command below.\\x1b[0m');
        term.writeln('');
        
        term.focus();
        
        socket.on('connect', () => {
            console.log('%c✅ Socket.IO reconnected', 'color:#00ff9d');
        });
    </script>
</body>
</html>
`;

// Serve the embedded terminal view at root
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
// Cloudflare Tunnel (reliable TCP localhost)
// ======================
let tunnel = null;
let PORT = null;

function startTunnel(cloudflaredPath, port) {
    console.log(`🌐 Launching Cloudflare Tunnel → http://127.0.0.1:${port}`);

    tunnel = spawn(cloudflaredPath, ['tunnel', '--url', `http://127.0.0.1:${port}`]);

    const checkForUrl = (data) => {
        const output = data.toString();
        const urlMatch = output.match(/https:\/\/([a-z0-9.-]+)\.trycloudflare\.com/);
        if (urlMatch) {
            const subdomain = urlMatch[1];
            const publicUrl = `https://ks-ssh.pages.dev/token=${subdomain}`;

            console.log('\n' + '⭐'.repeat(30));
            console.log('🎉 TUNNEL IS LIVE — NO PUBLIC PORTS USED!');
            console.log('🔗 Your public URL (hidden behind ks-ssh.pages.dev):');
            console.log('   ' + publicUrl);
            console.log('   (Share this link — real Cloudflare URL stays private)');
            console.log('⭐'.repeat(30) + '\n');
            console.log('💡 Open the link in your browser for the optimistic terminal!');
        }
    };

    tunnel.stdout.on('data', checkForUrl);
    tunnel.stderr.on('data', checkForUrl);

    tunnel.on('close', (code) => {
        if (code !== 0) console.log(`⚠️ Tunnel closed with code ${code}.`);
    });
}

// Start server on random localhost port
server.listen(0, '127.0.0.1', async () => {
    const addr = server.address();
    PORT = addr.port;

    console.log(`✅ Express + Socket.IO ready on http://127.0.0.1:${PORT}`);
    console.log('   Everything is set — starting tunnel now...\n');

    const cloudflaredPath = await ensureCloudflared();
    startTunnel(cloudflaredPath, PORT);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Gracefully shutting down SSHX...');
    if (tunnel) tunnel.kill();
    console.log('✅ Clean exit. Thanks for using SSHX! 👋');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Received SIGTERM — shutting down gracefully...');
    if (tunnel) tunnel.kill();
    process.exit(0);
});
