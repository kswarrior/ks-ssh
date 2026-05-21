package settings

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

type Settings struct {
	CustomActions []interface{} `json:"customActions"`
	Bookmarks     []interface{} `json:"bookmarks"`
	DefaultCwd    string        `json:"defaultCwd"`
	HUDSettings   interface{}   `json:"hudSettings"`
}

type Manager struct {
	path string
	mu   sync.Mutex
}

func NewManager() *Manager {
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".ks-ssh")
	os.MkdirAll(dir, 0755)
	return &Manager{
		path: filepath.Join(dir, "settings.json"),
	}
}

func (m *Manager) Load() (Settings, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	var s Settings
	data, err := os.ReadFile(m.path)
	if err != nil {
		return s, err
	}

	err = json.Unmarshal(data, &s)
	return s, err
}

func (m *Manager) Save(s Settings) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(m.path, data, 0644)
}
