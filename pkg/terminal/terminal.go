package terminal

import (
	"os"
	"os/exec"
	"sync"

	"github.com/creack/pty"
)

type Session struct {
	ID        string
	Pty       *os.File
	Cmd       *exec.Cmd
	Buffer    []byte
	BufferMu  sync.Mutex
	listeners map[chan []byte]bool
	mu        sync.Mutex
}

type Manager struct {
	sessions map[string]*Session
	mu       sync.Mutex
}

func NewManager() *Manager {
	return &Manager{
		sessions: make(map[string]*Session),
	}
}

func (m *Manager) Create(id, cwd string, cols, rows uint16) (*Session, error) {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/bash"
	}

	// -i for interactive mode to enable job control
	cmd := exec.Command(shell, "-i")
	if cwd != "" {
		cmd.Dir = cwd
	}
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")

	f, err := pty.StartWithAttrs(cmd, &pty.Winsize{Cols: cols, Rows: rows}, nil)
	if err != nil {
		return nil, err
	}

	session := &Session{
		ID:        id,
		Pty:       f,
		Cmd:       cmd,
		listeners: make(map[chan []byte]bool),
	}

	m.mu.Lock()
	m.sessions[id] = session
	m.mu.Unlock()

	// Handle exit
	go func() {
		cmd.Wait()
		m.mu.Lock()
		delete(m.sessions, id)
		m.mu.Unlock()
		f.Close()
	}()

	// Start central reader
	go session.readLoop()

	return session, nil
}

func (s *Session) readLoop() {
	buf := make([]byte, 4096)
	for {
		n, err := s.Pty.Read(buf)
		if n > 0 {
			data := make([]byte, n)
			copy(data, buf[:n])

			// Update buffer
			s.BufferMu.Lock()
			s.Buffer = append(s.Buffer, data...)
			if len(s.Buffer) > 128*1024 {
				s.Buffer = s.Buffer[len(s.Buffer)-64*1024:]
			}
			s.BufferMu.Unlock()

			// Broadcast
			s.mu.Lock()
			for l := range s.listeners {
				select {
				case l <- data:
				default:
					// Drop if listener is too slow
				}
			}
			s.mu.Unlock()
		}
		if err != nil {
			break
		}
	}
}

func (s *Session) Attach() chan []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := make(chan []byte, 100)
	s.listeners[c] = true
	return c
}

func (s *Session) Detach(c chan []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.listeners, c)
}

func (m *Manager) Get(id string) *Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[id]
}

func (s *Session) Write(data []byte) (int, error) {
	return s.Pty.Write(data)
}

func (s *Session) Resize(cols, rows uint16) error {
	return pty.Setsize(s.Pty, &pty.Winsize{Cols: cols, Rows: rows})
}

func (s *Session) Kill() error {
	if s.Cmd.Process != nil {
		return s.Cmd.Process.Kill()
	}
	return nil
}
