package tunnel

import (
	"bufio"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

type Info struct {
	Active    bool   `json:"active"`
	URL       string `json:"url"`
	ShareURL  string `json:"shareUrl"`
	Token     string `json:"token"`
	Subdomain string `json:"subdomain"`
}

type Manager struct {
	port      int
	child     *exec.Cmd
	info      Info
	mu        sync.Mutex
	onUrl     func(Info)
}

func NewManager(port int) *Manager {
	return &Manager{port: port}
}

func (m *Manager) SetOnUrl(f func(Info)) {
	m.onUrl = f
}

func (m *Manager) Start() {
	go m.run()
}

func (m *Manager) run() {
	bin, err := m.findOrDownloadLinker()
	if err != nil {
		fmt.Printf("[Tunnel] Error: %v\n", err)
		return
	}

	cmd := exec.Command(bin, "tunnel", "--url", fmt.Sprintf("http://localhost:%d", m.port), "--no-autoupdate", "--protocol", "http2")
	m.child = cmd

	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()

	if err := cmd.Start(); err != nil {
		fmt.Printf("[Tunnel] Failed to start: %v\n", err)
		return
	}

	reader := io.MultiReader(stdout, stderr)
	scanner := bufio.NewScanner(reader)

	for scanner.Scan() {
		line := scanner.Text()
		if strings.Contains(line, "https://") && strings.Contains(line, ".trycloudflare.com") {
			m.mu.Lock()
			url := extractUrl(line)
			if url != "" {
				sub := strings.TrimSuffix(strings.TrimPrefix(url, "https://"), ".trycloudflare.com")
				m.info = Info{
					Active:    true,
					URL:       url,
					ShareURL:  fmt.Sprintf("https://ssh.ksw.workers.dev/?token=%s", sub),
					Token:     sub,
					Subdomain: sub,
				}
				if m.onUrl != nil {
					m.onUrl(m.info)
				}
				fmt.Printf("[Tunnel] Ready: %s\n", url)
			}
			m.mu.Unlock()
		}
	}

	cmd.Wait()
	m.mu.Lock()
	m.info = Info{}
	m.mu.Unlock()
}

func extractUrl(line string) string {
	parts := strings.Fields(line)
	for _, p := range parts {
		if strings.HasPrefix(p, "https://") && strings.HasSuffix(p, ".trycloudflare.com") {
			return p
		}
	}
	// Fallback to searching the whole line
	start := strings.Index(line, "https://")
	if start == -1 {
		return ""
	}
	end := strings.Index(line[start:], ".trycloudflare.com")
	if end == -1 {
		return ""
	}
	return line[start : start+end+18]
}

func (m *Manager) findOrDownloadLinker() (string, error) {
	binName := "ks-ssh-linker"
	home, _ := os.UserHomeDir()
	path := filepath.Join(home, ".local", "bin", binName)

	if _, err := os.Stat(path); err == nil {
		return path, nil
	}

	if _, err := exec.LookPath(binName); err == nil {
		return binName, nil
	}

	// Download
	fmt.Println("[Tunnel] Downloading ks-ssh-linker...")
	err := downloadLinker(path)
	if err != nil {
		return "", err
	}
	os.Chmod(path, 0755)
	return path, nil
}

func downloadLinker(dest string) error {
	arch := "amd64"
	if runtime.GOARCH == "arm64" {
		arch = "arm64"
	}
	url := fmt.Sprintf("https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-%s", arch)

	os.MkdirAll(filepath.Dir(dest), 0755)
	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer out.Close()

	resp, err := http.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("bad status: %s", resp.Status)
	}

	_, err = io.Copy(out, resp.Body)
	return err
}

func (m *Manager) GetInfo() Info {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.info
}

func (m *Manager) Stop() {
	if m.child != nil && m.child.Process != nil {
		m.child.Process.Signal(os.Interrupt)
	}
}
