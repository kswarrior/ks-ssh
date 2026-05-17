package terminal

import (
	"os"
	"os/exec"
	"sync"

	"github.com/creack/pty"
)

type Session struct {
	ID       string
	Pty      *os.File
	Cmd      *exec.Cmd
	Buffer   []byte
	BufferMu sync.Mutex
	mu       sync.Mutex
}

type Manager struct {
	sessions map[string]*Session
	mu       sync.Mutex
	maxBuf   int
}

func NewManager() *Manager {
	return &Manager{
		sessions: make(map[string]*Session),
		maxBuf:   128 * 1024,
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
		ID:  id,
		Pty: f,
		Cmd: cmd,
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

	return session, nil
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

func (s *Session) Read(p []byte) (int, error) {
	n, err := s.Pty.Read(p)
	if n > 0 {
		s.BufferMu.Lock()
		s.Buffer = append(s.Buffer, p[:n]...)
		if len(s.Buffer) > 128*1024 {
			s.Buffer = s.Buffer[len(s.Buffer)-64*1024:]
		}
		s.BufferMu.Unlock()
	}
	return n, err
}

func (s *Session) Kill() error {
	if s.Cmd.Process != nil {
		return s.Cmd.Process.Kill()
	}
	return nil
}
