const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const pty = require('node-pty');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ======================
// Configuration & State
// ======================
const HOME = os.homedir();
const KSSSH_DIR = path.join(HOME, '.ksssh');
const CLOUDFLARED_PATH = path.join(KSSSH_DIR, 'ks-link');
const SESSION_ID = crypto.randomBytes(8).toString('hex');
const START_TIME = Date.now();

// Session state
let ptyProcess = null;
let currentPath = HOME || '/root';
let connectedClients = new Map(); // socket.id -> { name, cursor, joinedAt }
let clientCounter = 0;
let tunnelUrl = null;
let pingInterval = null;

if (!fs.existsSync(KSSSH_DIR)) {
    fs.mkdirSync(KSSSH_DIR, { recursive: true, mode: 0o700 });
}

// ======================
// Auto-install cloudflared
// ======================
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
// Enhanced HTML Terminal (sshx.io + tmate style)
// ======================
const terminalHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>KS SSH — ${SESSION_ID}</title>
    <script src="https://cdn.jsdelivr.net/npm/xterm@5.5.0/lib/xterm.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/socket.io-client@4.7.5/dist/socket.io.js"></script>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.5.0/css/xterm.css">
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
        :root { 
            --accent: #00ff9d; 
            --accent-dim: rgba(0, 255, 157, 0.3);
            --bg: #0a0a0a;
            --bg-light: #141414;
            --text: #e0e0e0;
            --text-dim: #888;
            --border: rgba(0, 255, 157, 0.15);
            --error: #ff5f56;
            --warning: #ffbd2e;
        }
        
        * { box-sizing: border-box; }
        
        body, html {
            margin: 0; 
            padding: 0; 
            height: 100%; 
            background: var(--bg); 
            overflow: hidden;
            font-family: 'Inter', system-ui, sans-serif;
            color: var(--text);
        }

        /* Header Bar - tmate/sshx style */
        .header {
            position: fixed;
            top: 0; 
            left: 0; 
            right: 0; 
            height: 48px;
            background: rgba(10, 10, 10, 0.95);
            border-bottom: 1px solid var(--border);
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 20px;
            z-index: 1000;
            backdrop-filter: blur(12px);
        }

        .header-left {
            display: flex;
            align-items: center;
            gap: 16px;
        }

        .logo {
            font-size: 16px;
            font-weight: 600;
            color: var(--accent);
            letter-spacing: -0.5px;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .logo::before {
            content: '●';
            animation: pulse 2s infinite;
        }

        @keyframes pulse { 
            0%, 100% { opacity: 1; } 
            50% { opacity: 0.3; } 
        }

        .session-info {
            display: flex;
            align-items: center;
            gap: 12px;
            font-size: 12px;
            color: var(--text-dim);
        }

        .badge {
            background: var(--bg-light);
            padding: 4px 10px;
            border-radius: 4px;
            border: 1px solid var(--border);
            font-family: 'JetBrains Mono', monospace;
            font-size: 11px;
        }

        .badge.link {
            color: var(--accent);
            cursor: pointer;
            transition: all 0.2s;
        }

        .badge.link:hover {
            background: var(--accent-dim);
        }

        /* Ping Display */
        .ping-display {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 12px;
            color: var(--text-dim);
            font-family: 'JetBrains Mono', monospace;
        }

        .ping-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--accent);
        }

        .ping-dot.slow { background: var(--warning); }
        .ping-dot.bad { background: var(--error); }

        /* Users Display (sshx style) */
        .users-display {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .user-avatar {
            width: 24px;
            height: 24px;
            border-radius: 50%;
            background: linear-gradient(135deg, var(--accent), #00cc7d);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 11px;
            font-weight: 600;
            color: var(--bg);
            border: 2px solid var(--bg);
            margin-left: -8px;
            transition: transform 0.2s;
        }

        .user-avatar:first-child { margin-left: 0; }
        .user-avatar:hover { transform: scale(1.1); z-index: 10; }

        /* Main Layout */
        .main-container {
            display: flex;
            height: 100%;
            padding-top: 48px;
        }

        /* Terminal Area */
        .terminal-wrapper {
            flex: 1;
            position: relative;
            background: var(--bg);
        }

        #terminal {
            width: 100%;
            height: 100%;
            padding: 8px;
        }

        /* Status Bar - showing path ~$ style */
        .status-bar {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            height: 28px;
            background: var(--bg-light);
            border-top: 1px solid var(--border);
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 16px;
            font-size: 12px;
            font-family: 'JetBrains Mono', monospace;
            z-index: 1000;
        }

        .path-display {
            color: var(--accent);
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .path-display .prompt {
            color: var(--text-dim);
        }

        .status-right {
            display: flex;
            align-items: center;
            gap: 16px;
            color: var(--text-dim);
        }

        .status-item {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        /* Remote Cursors (sshx style) */
        .remote-cursor {
            position: absolute;
            width: 2px;
            height: 20px;
            background: var(--accent);
            pointer-events: none;
            z-index: 100;
            transition: all 0.1s ease-out;
        }

        .remote-cursor::after {
            content: attr(data-name);
            position: absolute;
            top: -20px;
            left: 0;
            background: var(--accent);
            color: var(--bg);
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 10px;
            font-weight: 600;
            white-space: nowrap;
        }

        /* Chat Panel (sshx style) */
        .chat-panel {
            width: 280px;
            background: var(--bg-light);
            border-left: 1px solid var(--border);
            display: flex;
            flex-direction: column;
            transition: transform 0.3s ease;
        }

        .chat-panel.collapsed {
            transform: translateX(100%);
            width: 0;
        }

        .chat-header {
            padding: 12px 16px;
            border-bottom: 1px solid var(--border);
            font-size: 13px;
            font-weight: 600;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .chat-messages {
            flex: 1;
            overflow-y: auto;
            padding: 12px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .chat-message {
            background: var(--bg);
            padding: 8px 12px;
            border-radius: 8px;
            font-size: 12px;
            border-left: 2px solid var(--accent);
        }

        .chat-message .author {
            color: var(--accent);
            font-weight: 600;
            margin-bottom: 4px;
        }

        .chat-input-wrapper {
            padding: 12px;
            border-top: 1px solid var(--border);
        }

        .chat-input {
            width: 100%;
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 8px 12px;
            color: var(--text);
            font-size: 12px;
            outline: none;
        }

        .chat-input:focus {
            border-color: var(--accent);
        }

        /* Toggle Chat Button */
        .toggle-chat {
            position: fixed;
            right: 20px;
            bottom: 40px;
            width: 40px;
            height: 40px;
            border-radius: 50%;
            background: var(--accent);
            color: var(--bg);
            border: none;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 18px;
            box-shadow: 0 4px 12px rgba(0, 255, 157, 0.3);
            transition: all 0.2s;
            z-index: 1001;
        }

        .toggle-chat:hover {
            transform: scale(1.1);
        }

        /* Connection Status Overlay */
        .conn-status {
            position: fixed;
            top: 60px;
            right: 20px;
            padding: 8px 16px;
            background: var(--bg-light);
            border: 1px solid var(--border);
            border-radius: 6px;
            font-size: 12px;
            display: flex;
            align-items: center;
            gap: 8px;
            opacity: 0;
            transition: opacity 0.3s;
            z-index: 999;
        }

        .conn-status.show { opacity: 1; }
        .conn-status.reconnecting { border-color: var(--warning); }
        .conn-status.error { border-color: var(--error); }

        /* Scrollbar Styling */
        ::-webkit-scrollbar {
            width: 8px;
            height: 8px;
        }

        ::-webkit-scrollbar-track {
            background: var(--bg);
        }

        ::-webkit-scrollbar-thumb {
            background: var(--border);
            border-radius: 4px;
        }

        ::-webkit-scrollbar-thumb:hover {
            background: var(--accent-dim);
        }
    </style>
</head>
<body>
    <!-- Header -->
    <div class="header">
        <div class="header-left">
            <div class="logo">KS SSH</div>
            <div class="session-info">
                <span class="badge">${SESSION_ID}</span>
                <span class="badge link" onclick="copyLink()" title="Click to copy">📋 Copy Link</span>
            </div>
        </div>
        
        <div class="header-right" style="display: flex; align-items: center; gap: 20px;">
            <div class="users-display" id="usersDisplay" title="Connected users"></div>
            <div class="ping-display" id="pingDisplay">
                <span class="ping-dot" id="pingDot"></span>
                <span id="pingValue">--</span>ms
            </div>
        </div>
    </div>

    <!-- Connection Status -->
    <div class="conn-status" id="connStatus">
        <span id="connIcon">🔄</span>
        <span id="connText">Reconnecting...</span>
    </div>

    <!-- Main Container -->
    <div class="main-container">
        <div class="terminal-wrapper">
            <div id="terminal"></div>
        </div>
        
        <!-- Chat Panel -->
        <div class="chat-panel" id="chatPanel">
            <div class="chat-header">
                <span>💬 Session Chat</span>
                <span style="color: var(--text-dim); font-size: 11px;" id="userCount">0 online</span>
            </div>
            <div class="chat-messages" id="chatMessages"></div>
            <div class="chat-input-wrapper">
                <input type="text" class="chat-input" id="chatInput" 
                       placeholder="Send message..." maxlength="200">
            </div>
        </div>
    </div>

    <!-- Toggle Chat -->
    <button class="toggle-chat" id="toggleChat" onclick="toggleChat()">💬</button>

    <!-- Status Bar -->
    <div class="status-bar">
        <div class="path-display">
            <span id="currentPath">~</span>
            <span class="prompt">$</span>
        </div>
        <div class="status-right">
            <div class="status-item">
                <span>🖥️</span>
                <span id="shellInfo">bash</span>
            </div>
            <div class="status-item">
                <span>👥</span>
                <span id="clientCount">1</span>
            </div>
            <div class="status-item">
                <span>⏱️</span>
                <span id="uptime">0m</span>
            </div>
        </div>
    </div>

    <script>
        // Initialize Terminal
        const term = new Terminal({
            cursorBlink: true,
            theme: { 
                background: '#0a0a0a', 
                foreground: '#00ff9d', 
                cursor: '#00ff9d',
                selectionBackground: 'rgba(0, 255, 157, 0.3)',
                black: '#0a0a0a',
                red: '#ff5f56',
                green: '#00ff9d',
                yellow: '#ffbd2e',
                blue: '#00aaff',
                magenta: '#ff00ff',
                cyan: '#00ffff',
                white: '#e0e0e0'
            },
            fontFamily: 'JetBrains Mono, Menlo, Monaco, monospace',
            fontSize: 14,
            lineHeight: 1.4,
            scrollback: 10000,
            allowProposedApi: true
        });
        
        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        
        const terminalContainer = document.getElementById('terminal');
        term.open(terminalContainer);
        fitAddon.fit();

        // Socket Connection
        const socket = io({
            reconnection: true,
            reconnectionAttempts: 5,
            reconnectionDelay: 1000
        });

        // State
        let myClientId = null;
        let myName = '';
        let currentPath = '~';
        let pingStart = 0;
        let chatOpen = true;

        // Generate random name like sshx
        const adjectives = ['Swift', 'Bright', 'Cool', 'Happy', 'Clever', 'Kind', 'Brave', 'Calm'];
        const nouns = ['Fox', 'Bear', 'Eagle', 'Wolf', 'Tiger', 'Lion', 'Hawk', 'Owl'];
        myName = adjectives[Math.floor(Math.random() * adjectives.length)] + ' ' + 
                 nouns[Math.floor(Math.random() * nouns.length)];

        // Welcome Banner
        term.writeln('\\x1b[32m╔════════════════════════════════════════════════════════════╗\\x1b[0m');
        term.writeln('\\x1b[32m║\\x1b[0m           \\x1b[1;32mKS SSH — Collaborative Terminal\\x1b[0m                  \\x1b[32m║\\x1b[0m');
        term.writeln('\\x1b[32m╠════════════════════════════════════════════════════════════╣\\x1b[0m');
        term.writeln('\\x1b[32m║\\x1b[0m  Session: \\x1b[33m${SESSION_ID}\\x1b[0m                                    \\x1b[32m║\\x1b[0m');
        term.writeln('\\x1b[32m║\\x1b[0m  Share:   \\x1b[36m' + window.location.href + '\\x1b[0m     \\x1b[32m║\\x1b[0m');
        term.writeln('\\x1b[32m╚════════════════════════════════════════════════════════════╝\\x1b[0m');
        term.writeln('');
        term.writeln('\\x1b[90mFeatures: Real-time collaboration • Chat • Remote cursors • Ping\\x1b[0m');
        term.writeln('');

        // Input Handling
        term.onData(data => {
            socket.emit('input', data);
            
            // Track cursor position for collaboration
            const buffer = term.buffer.active;
            socket.emit('cursor', {
                row: buffer.cursorY,
                col: buffer.cursorX
            });
        });

        // Output Handling
        socket.on('output', data => {
            term.write(data);
            extractPath(data);
        });

        // Path Extraction for status bar
        function extractPath(data) {
            // Match common prompt patterns
            const patterns = [
                /\\[([^\\]]+)\\][\\$#]/,           # [user@host path]$
                /([^\\s]+)\\s*[\\$#]\\s*$/,        # path $ 
                /~?[\\w\\/]+[\\$#]/,               # ~/path$
            ];
            
            for (const pattern of patterns) {
                const match = data.match(pattern);
                if (match) {
                    let newPath = match[1] || match[0].replace(/[\\$#\\s]/g, '');
                    if (newPath !== currentPath && !newPath.includes('\\x1b')) {
                        currentPath = newPath;
                        document.getElementById('currentPath').textContent = currentPath;
                    }
                    break;
                }
            }
        }

        // Ping System (like sshx)
        function measurePing() {
            pingStart = Date.now();
            socket.emit('ping_check');
        }

        socket.on('pong_check', () => {
            const latency = Date.now() - pingStart;
            const pingValue = document.getElementById('pingValue');
            const pingDot = document.getElementById('pingDot');
            
            pingValue.textContent = latency;
            
            if (latency < 100) {
                pingDot.className = 'ping-dot';
            } else if (latency < 300) {
                pingDot.className = 'ping-dot slow';
            } else {
                pingDot.className = 'ping-dot bad';
            }
        });

        setInterval(measurePing, 2000);
        measurePing();

        // User Management
        socket.on('init', (data) => {
            myClientId = data.clientId;
            socket.emit('join', { name: myName });
        });

        socket.on('users', (users) => {
            updateUsersDisplay(users);
            document.getElementById('userCount').textContent = users.length + ' online';
            document.getElementById('clientCount').textContent = users.length;
        });

        function updateUsersDisplay(users) {
            const container = document.getElementById('usersDisplay');
            container.innerHTML = '';
            
            users.forEach((user, index) => {
                const avatar = document.createElement('div');
                avatar.className = 'user-avatar';
                avatar.textContent = user.name.split(' ').map(n => n[0]).join('');
                avatar.title = user.name + (user.id === myClientId ? ' (You)' : '');
                avatar.style.background = stringToColor(user.name);
                container.appendChild(avatar);
            });
        }

        function stringToColor(str) {
            let hash = 0;
            for (let i = 0; i < str.length; i++) {
                hash = str.charCodeAt(i) + ((hash << 5) - hash);
            }
            const hue = Math.abs(hash % 360);
            return \\`hsl(\\${hue}, 70%, 60%)\\`;
        }

        // Chat System
        function toggleChat() {
            chatOpen = !chatOpen;
            document.getElementById('chatPanel').classList.toggle('collapsed', !chatOpen);
        }

        document.getElementById('chatInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && e.target.value.trim()) {
                socket.emit('chat', {
                    text: e.target.value.trim(),
                    author: myName
                });
                e.target.value = '';
            }
        });

        socket.on('chat', (msg) => {
            const container = document.getElementById('chatMessages');
            const div = document.createElement('div');
            div.className = 'chat-message';
            div.innerHTML = \\`<div class="author">\\${msg.author}</div><div>\\${escapeHtml(msg.text)}</div>\\`;
            container.appendChild(div);
            container.scrollTop = container.scrollHeight;
        });

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        // Remote Cursors
        const remoteCursors = new Map();

        socket.on('cursor', (data) => {
            if (data.id === myClientId) return;
            
            let cursor = remoteCursors.get(data.id);
            if (!cursor) {
                cursor = document.createElement('div');
                cursor.className = 'remote-cursor';
                cursor.setAttribute('data-name', data.name);
                cursor.style.background = stringToColor(data.name);
                document.querySelector('.xterm-screen').appendChild(cursor);
                remoteCursors.set(data.id, cursor);
            }
            
            // Convert terminal coords to pixel coords
            const cellWidth = term._core._renderService._renderer._cellWidth || 9;
            const cellHeight = term._core._renderService._renderer._cellHeight || 17;
            cursor.style.left = (data.col * cellWidth + 20) + 'px';
            cursor.style.top = (data.row * cellHeight + 20) + 'px';
        });

        socket.on('user_left', (id) => {
            const cursor = remoteCursors.get(id);
            if (cursor) {
                cursor.remove();
                remoteCursors.delete(id);
            }
        });

        // Connection Status
        socket.on('connect', () => {
            document.getElementById('connStatus').classList.remove('show');
            socket.emit('join', { name: myName });
        });

        socket.on('disconnect', () => {
            const status = document.getElementById('connStatus');
            status.className = 'conn-status show error';
            document.getElementById('connIcon').textContent = '⚠️';
            document.getElementById('connText').textContent = 'Disconnected';
        });

        socket.on('reconnecting', () => {
            const status = document.getElementById('connStatus');
            status.className = 'conn-status show reconnecting';
            document.getElementById('connIcon').textContent = '🔄';
            document.getElementById('connText').textContent = 'Reconnecting...';
        });

        // Copy Link
        function copyLink() {
            navigator.clipboard.writeText(window.location.href).then(() => {
                const badge = document.querySelector('.badge.link');
                const original = badge.textContent;
                badge.textContent = '✅ Copied!';
                setTimeout(() => badge.textContent = original, 2000);
            });
        }

        // Uptime Counter
        setInterval(() => {
            const uptime = Math.floor((Date.now() - ${START_TIME}) / 60000);
            document.getElementById('uptime').textContent = uptime + 'm';
        }, 60000);

        // Resize Handling
        window.addEventListener('resize', () => {
            setTimeout(() => fitAddon.fit(), 100);
            socket.emit('resize', { 
                cols: term.cols, 
                rows: term.rows 
            });
        });

        // Focus terminal on load
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
// Shared PTY with Collaboration Features
// ======================
io.on('connection', (socket) => {
    const clientId = crypto.randomBytes(4).toString('hex');
    const clientNum = ++clientCounter;
    const clientName = `User ${clientNum}`;
    
    console.log(`Client connected: ${clientId} (${clientName})`);
    
    // Send initialization
    socket.emit('init', { clientId });
    
    // Handle join
    socket.on('join', (data) => {
        const name = data.name || clientName;
        connectedClients.set(clientId, {
            id: clientId,
            name: name,
            socket: socket,
            joinedAt: new Date()
        });
        
        // Broadcast user list to all
        broadcastUsers();
        
        // Welcome message to chat
        io.emit('chat', {
            author: 'System',
            text: `${name} joined the session`
        });
    });

    // Spawn shared PTY on first client
    if (!ptyProcess) {
        spawnPty();
    }

    // Input handling
    socket.on('input', (data) => {
        if (ptyProcess) {
            ptyProcess.write(data);
        }
    });

    // Cursor position tracking (sshx style)
    socket.on('cursor', (data) => {
        const client = connectedClients.get(clientId);
        if (client) {
            socket.broadcast.emit('cursor', {
                id: clientId,
                name: client.name,
                row: data.row,
                col: data.col
            });
        }
    });

    // Terminal resize
    socket.on('resize', (data) => {
        if (ptyProcess) {
            ptyProcess.resize(data.cols, data.rows);
        }
    });

    // Chat messages
    socket.on('chat', (data) => {
        io.emit('chat', {
            author: data.author || 'Anonymous',
            text: data.text
        });
    });

    // Ping/pong for latency
    socket.on('ping_check', () => {
        socket.emit('pong_check');
    });

    // Disconnect handling
    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${clientId}`);
        const client = connectedClients.get(clientId);
        
        if (client) {
            io.emit('chat', {
                author: 'System',
                text: `${client.name} left the session`
            });
        }
        
        connectedClients.delete(clientId);
        socket.broadcast.emit('user_left', clientId);
        broadcastUsers();
    });
});

function spawnPty() {
    ptyProcess = pty.spawn('bash', [], {
        name: 'xterm-256color',
        cwd: process.env.HOME || '/root',
        env: {
            ...process.env,
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor'
        }
    });

    ptyProcess.onData((data) => {
        io.emit('output', data);
        
        // Try to extract current path from prompt
        const pathMatch = data.match(/\\[([^\\]]+)\\][\\$#]/);
        if (pathMatch) {
            currentPath = pathMatch[1];
        }
    });

    ptyProcess.onExit(() => {
        console.log('PTY exited, respawning...');
        ptyProcess = null;
        // Respawn if clients still connected
        if (connectedClients.size > 0) {
            setTimeout(spawnPty, 1000);
        }
    });
}

function broadcastUsers() {
    const users = Array.from(connectedClients.values()).map(c => ({
        id: c.id,
        name: c.name
    }));
    io.emit('users', users);
}

// ======================
// Cloudflare Tunnel
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
            tunnelUrl = `https://${urlMatch[1]}.trycloudflare.com`;
            console.log('\n✅ TUNNEL READY');
            console.log('🔗 HTTPS Link:', tunnelUrl);
            console.log(`📋 Session ID: ${SESSION_ID}`);
            console.log(`👥 Connected: ${connectedClients.size} users`);
            console.log('\nShare this link for collaborative terminal access\n');
        }
    };

    tunnel.stdout.on('data', checkForUrl);
    tunnel.stderr.on('data', checkForUrl);
    
    tunnel.on('exit', (code) => {
        console.log(`Tunnel exited with code ${code}`);
    });
}

// Start server
server.listen(0, '127.0.0.1', async () => {
    const addr = server.address();
    PORT = addr.port;
    console.log(`Server ready on http://127.0.0.1:${PORT}`);

    const cloudflaredPath = await ensureCloudflared();
    startTunnel(cloudflaredPath, PORT);
    
    // Start ping broadcast for all clients
    pingInterval = setInterval(() => {
        io.emit('server_time', Date.now());
    }, 5000);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down...');
    clearInterval(pingInterval);
    if (tunnel) tunnel.kill();
    if (ptyProcess) ptyProcess.kill();
    process.exit(0);
});

process.on('SIGTERM', () => {
    clearInterval(pingInterval);
    if (tunnel) tunnel.kill();
    if (ptyProcess) ptyProcess.kill();
    process.exit(0);
});
