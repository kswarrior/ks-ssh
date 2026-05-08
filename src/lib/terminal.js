'use strict';

const pty = require('node-pty');
const { v4: uuidv4 } = require('uuid');
const os = require('os');

class TerminalManager {
  constructor(io) {
    this.io = io;
    this.sessions = new Map();
    this.GRACE_PERIOD = 5 * 60 * 1000; // 5 mins
    this.MAX_BUFFER = 128 * 1024;
    this.TRIM_SIZE = 64 * 1024;
  }

  create(socket, data = {}) {
    const id = data.id || uuidv4();
    const shell = process.env.SHELL || '/bin/bash';
    const cols = data.cols || 80;
    const rows = data.rows || 24;

    try {
      const ptyProc = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols, rows,
        cwd: data.cwd || os.homedir(),
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
      });

      const session = {
        pty: ptyProc,
        socketId: socket.id,
        buffer: '',
        killTimer: null,
        dataListener: null
      };

      this.sessions.set(id, session);
      this.attach(id, socket);

      ptyProc.onExit(({ exitCode }) => {
        socket.emit('terminal:exit', { id, exitCode });
        this.sessions.delete(id);
      });

      socket.emit('terminal:created', { id });
      return id;
    } catch (err) {
      socket.emit('terminal:error', { id, error: err.message });
      return null;
    }
  }

  attach(id, socket) {
    const session = this.sessions.get(id);
    if (!session) return;

    if (session.dataListener) {
      try { session.dataListener.dispose(); } catch {}
    }

    session.socketId = socket.id;
    session.dataListener = session.pty.onData((chunk) => {
      session.buffer += chunk;
      if (session.buffer.length > this.MAX_BUFFER) {
        session.buffer = session.buffer.slice(-this.TRIM_SIZE);
      }
      socket.emit('terminal:data', { id, data: chunk });
    });
  }

  reconnect(socket, { id, cols, rows }) {
    const session = this.sessions.get(id);
    if (!session) {
      socket.emit('terminal:reconnect:fail', { id });
      return;
    }

    if (session.killTimer) {
      clearTimeout(session.killTimer);
      session.killTimer = null;
    }

    if (cols && rows) {
      try { session.pty.resize(cols, rows); } catch {}
    }

    this.attach(id, socket);
    socket.emit('terminal:replay', { id, buffer: session.buffer });
  }

  write(id, data) {
    const s = this.sessions.get(id);
    if (s) { try { s.pty.write(data); } catch {} }
  }

  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (s) { try { s.pty.resize(cols, rows); } catch {} }
  }

  kill(id) {
    const s = this.sessions.get(id);
    if (s) {
      if (s.killTimer) clearTimeout(s.killTimer);
      try { s.pty.kill(); } catch {}
      this.sessions.delete(id);
    }
  }

  handleDisconnect(socketId) {
    for (const [id, s] of this.sessions.entries()) {
      if (s.socketId === socketId) {
        s.socketId = null;
        s.killTimer = setTimeout(() => {
          const ss = this.sessions.get(id);
          if (ss && !ss.socketId) {
            this.kill(id);
          }
        }, this.GRACE_PERIOD);
      }
    }
  }
}

module.exports = TerminalManager;
