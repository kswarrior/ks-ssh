// Initialize xterm.js
const term = new Terminal({
    cursorBlink: true,
    theme: {
        background: '#000000',
        foreground: '#ffffff'
    },
    fontFamily: 'Menlo, Monaco, "Courier New", monospace'
});

const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);

term.open(document.getElementById('terminal-container'));
fitAddon.fit();

// Connect to WebSocket
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${protocol}//${window.location.host}/ws`;
const socket = new WebSocket(wsUrl);

socket.binaryType = 'arraybuffer';

socket.onopen = () => {
    term.focus();
    // Send initial size
    sendResize(term.rows, term.cols);
};

socket.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
        // Read binary data from server
        term.write(new Uint8Array(event.data));
    } else {
        // Fallback for text data
        term.write(event.data);
    }
};

socket.onclose = () => {
    term.write('\r\n\x1b[31mConnection closed. Please refresh to reconnect.\x1b[0m\r\n');
};

socket.onerror = (error) => {
    console.error('WebSocket Error:', error);
};

// Handle input from xterm.js
term.onData((data) => {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(data);
    }
});

// Handle resize
window.addEventListener('resize', () => {
    fitAddon.fit();
    sendResize(term.rows, term.cols);
});

function sendResize(rows, cols) {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'resize',
            rows: rows,
            cols: cols
        }));
    }
}
