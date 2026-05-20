package logger

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Manager struct {
	dir string
	mu  sync.Mutex
}

func NewManager() *Manager {
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".ks-ssh", "logs")
	os.MkdirAll(dir, 0755)
	return &Manager{dir: dir}
}

func (m *Manager) LogTerminal(id string, data []byte) {
	m.mu.Lock()
	defer m.mu.Unlock()

	f, err := os.OpenFile(filepath.Join(m.dir, id+".log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return
	}
	defer f.Close()

	// Prepend timestamp
	ts := time.Now().Format("2006-01-02 15:04:05")
	f.Write([]byte(fmt.Sprintf("[%s] %s\n", ts, string(data))))
}
