package tunnel

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"time"
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
	subdomain string
	info      Info
	mu        sync.Mutex
	onUrl     func(Info)
	quit      chan struct{}
}

func NewManager(port int, subdomain string) *Manager {
	return &Manager{
		port:      port,
		subdomain: subdomain,
		quit:      make(chan struct{}),
	}
}

func (m *Manager) SetOnUrl(f func(Info)) {
	m.onUrl = f
}

func (m *Manager) Start() {
	go m.run()
}

type ltResponse struct {
	ID           string `json:"id"`
	Port         int    `json:"port"`
	MaxConnCount int    `json:"max_conn_count"`
	URL          string `json:"url"`
}

func (m *Manager) run() {
	for {
		select {
		case <-m.quit:
			return
		default:
			err := m.establishTunnel()
			if err != nil {
				fmt.Printf("[Tunnel] Error: %v. Retrying in 5s...\n", err)
				select {
				case <-m.quit:
					return
				case <-time.After(5 * time.Second):
				}
			} else {
				return
			}
		}
	}
}

func (m *Manager) establishTunnel() error {
	client := &http.Client{Timeout: 10 * time.Second}
	url := "https://localtunnel.me/?new"
	if m.subdomain != "" {
		url = "https://localtunnel.me/" + m.subdomain
	}
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	var lt ltResponse
	if err := json.NewDecoder(resp.Body).Decode(&lt); err != nil {
		return err
	}

	// Token format: ks-lt-${subdomain}
	token := "ks-lt-" + lt.ID

	m.mu.Lock()
	m.info = Info{
		Active:    true,
		URL:       lt.URL,
		ShareURL:  fmt.Sprintf("https://ssh.ksw.workers.dev/?token=%s", token),
		Token:     token,
		Subdomain: lt.ID,
	}
	info := m.info
	m.mu.Unlock()

	if m.onUrl != nil {
		m.onUrl(info)
	}

	banner := fmt.Sprintf("\n\x1b[32m  ✓ Tunnel ready!\x1b[0m\n\x1b[36m  ┌──────────────────────────────────────────────┐\x1b[0m\n\x1b[36m  │\x1b[0m  \x1b[1mToken:\x1b[0m  \x1b[93m%s\x1b[0m\n\x1b[36m  └──────────────────────────────────────────────┘\x1b[0m\n", token)
	fmt.Print(banner)

	var wg sync.WaitGroup
	conns := lt.MaxConnCount
	if conns <= 0 {
		conns = 10
	}
	if conns > 10 {
		conns = 10
	}

	for i := 0; i < conns; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-m.quit:
					return
				default:
					if err := m.proxy(lt.Port); err != nil {
						select {
						case <-m.quit:
							return
						case <-time.After(1 * time.Second):
						}
					}
				}
			}
		}()
	}

	wg.Wait()
	return nil
}

func (m *Manager) proxy(remotePort int) error {
	remote, err := net.DialTimeout("tcp", fmt.Sprintf("localtunnel.me:%d", remotePort), 10*time.Second)
	if err != nil {
		return err
	}

	done := make(chan struct{})
	go func() {
		select {
		case <-m.quit:
			remote.Close()
		case <-done:
		}
	}()
	defer func() {
		close(done)
		remote.Close()
	}()

	local, err := net.DialTimeout("tcp", fmt.Sprintf("localhost:%d", m.port), 5*time.Second)
	if err != nil {
		return err
	}
	defer local.Close()

	doneProxy := make(chan struct{}, 2)
	go func() {
		io.Copy(remote, local)
		doneProxy <- struct{}{}
	}()
	go func() {
		io.Copy(local, remote)
		doneProxy <- struct{}{}
	}()

	select {
	case <-doneProxy:
	case <-m.quit:
	}
	return nil
}

func (m *Manager) GetInfo() Info {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.info
}

func (m *Manager) Stop() {
	m.mu.Lock()
	defer m.mu.Unlock()
	select {
	case <-m.quit:
		// already closed
	default:
		close(m.quit)
		m.info = Info{}
	}
}
