package tunnel

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
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
	port  int
	info  Info
	mu    sync.Mutex
	onUrl func(Info)
	quit  chan struct{}
}

func NewManager(port int) *Manager {
	return &Manager{
		port: port,
		quit: make(chan struct{}),
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
				// If establishTunnel returns nil, it means it finished normally (e.g. quit)
				return
			}
		}
	}
}

func (m *Manager) establishTunnel() error {
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get("https://localtunnel.me/?new")
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	var lt ltResponse
	if err := json.NewDecoder(resp.Body).Decode(&lt); err != nil {
		return err
	}

	// Token format: ks-lt-${complete url only without https:// or http://}
	cleanURL := lt.URL
	cleanURL = strings.TrimPrefix(cleanURL, "https://")
	cleanURL = strings.TrimPrefix(cleanURL, "http://")
	token := "ks-lt-" + cleanURL

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

	fmt.Printf("[Tunnel] Ready: %s (Token: %s)\n", lt.URL, token)

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
	// Use localtunnel.me as the proxy host
	remote, err := net.DialTimeout("tcp", fmt.Sprintf("localtunnel.me:%d", remotePort), 10*time.Second)
	if err != nil {
		return err
	}

	// Close connection if we quit
	go func() {
		<-m.quit
		remote.Close()
	}()
	defer remote.Close()

	local, err := net.DialTimeout("tcp", fmt.Sprintf("localhost:%d", m.port), 5*time.Second)
	if err != nil {
		return err
	}
	defer local.Close()

	done := make(chan struct{}, 2)
	go func() {
		io.Copy(remote, local)
		done <- struct{}{}
	}()
	go func() {
		io.Copy(local, remote)
		done <- struct{}{}
	}()

	select {
	case <-done:
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
