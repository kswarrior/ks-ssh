package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gorilla/websocket"
	"github.com/user/ks-ssh-go/pkg/filemanager"
	"github.com/user/ks-ssh-go/pkg/portscan"
	"github.com/user/ks-ssh-go/pkg/sysmon"
	"github.com/user/ks-ssh-go/pkg/terminal"
	"github.com/user/ks-ssh-go/pkg/tunnel"
)

type Server struct {
	termMgr   *terminal.Manager
	tunnelMgr *tunnel.Manager
	upgrader  websocket.Upgrader
	assets    http.FileSystem
}

func NewServer(assets http.FileSystem, port int, subdomain string) *Server {
	tm := terminal.NewManager()
	tn := tunnel.NewManager(port, subdomain)

	s := &Server{
		termMgr:   tm,
		tunnelMgr: tn,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
		assets: assets,
	}

	tn.Start()
	return s
}

func (s *Server) Router() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/ksapi/ping", s.handlePing)
	mux.HandleFunc("/ksapi/system", s.handleSystem)
	mux.HandleFunc("/ksapi/resources", s.handleResources)
	mux.HandleFunc("/ksapi/tunnel", s.handleTunnel)
	mux.HandleFunc("/ksapi/ports", s.handlePorts)
	mux.HandleFunc("/ksapi/files", s.handleFilesList)
	mux.HandleFunc("/ksapi/files/read", s.handleFilesRead)
	mux.HandleFunc("/ksapi/files/write", s.handleFilesWrite)
	mux.HandleFunc("/ksapi/files/mkdir", s.handleFilesMkdir)
	mux.HandleFunc("/ksapi/files/delete", s.handleFilesDelete)
	mux.HandleFunc("/ksapi/files/rename", s.handleFilesRename)
	mux.HandleFunc("/ksapi/files/copy", s.handleFilesCopy)
	mux.HandleFunc("/ksapi/files/move", s.handleFilesMove)
	mux.HandleFunc("/ksapi/files/search", s.handleFilesSearch)
	mux.HandleFunc("/ksapi/files/download", s.handleFilesDownload)
	mux.HandleFunc("/ws", s.handleWS)

	// Fallback to static assets
	fileServer := http.FileServer(s.assets)
	mux.Handle("/", fileServer)

	return mux
}

func (s *Server) handlePing(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "ts": strings.Split(fmt.Sprintf("%v", os.Environ()), " ")})
}

func (s *Server) handleSystem(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(sysmon.GetSystemInfo())
}

func (s *Server) handleResources(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(sysmon.GetStats())
}

func (s *Server) handleTunnel(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(s.tunnelMgr.GetInfo())
}

func (s *Server) handlePorts(w http.ResponseWriter, r *http.Request) {
	ports, _ := portscan.Scan()
	json.NewEncoder(w).Encode(map[string]interface{}{"ports": ports})
}

func (s *Server) handleFilesList(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	hidden := r.URL.Query().Get("showHidden") == "true"
	res, err := filemanager.List(path, hidden)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	json.NewEncoder(w).Encode(res)
}

func (s *Server) handleFilesRead(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	content, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{"content": string(content)})
}

func (s *Server) handleFilesWrite(w http.ResponseWriter, r *http.Request) {
	var body struct {
		FilePath string `json:"filePath"`
		Content  string `json:"content"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	err := os.WriteFile(body.FilePath, []byte(body.Content), 0644)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true})
}

func (s *Server) handleFilesMkdir(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path string `json:"path"`
		Name string `json:"name"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	fullPath := filepath.Join(body.Path, body.Name)
	err := os.MkdirAll(fullPath, 0755)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true})
}

func (s *Server) handleFilesDelete(w http.ResponseWriter, r *http.Request) {
	var body struct {
		FilePath  string   `json:"filePath"`
		FilePaths []string `json:"filePaths"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	paths := body.FilePaths
	if len(paths) == 0 {
		paths = []string{body.FilePath}
	}
	for _, p := range paths {
		os.RemoveAll(p)
	}
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true})
}

func (s *Server) handleFilesRename(w http.ResponseWriter, r *http.Request) {
	var body struct {
		OldPath string `json:"oldPath"`
		NewName string `json:"newName"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	newPath := filepath.Join(filepath.Dir(body.OldPath), body.NewName)
	err := os.Rename(body.OldPath, newPath)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "newPath": newPath})
}

func (s *Server) handleFilesCopy(w http.ResponseWriter, r *http.Request) {
	// Simple copy, not recursive for files
	var body struct {
		Src  string `json:"src"`
		Dest string `json:"dest"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	in, _ := os.Open(body.Src)
	defer in.Close()
	out, _ := os.Create(body.Dest)
	defer out.Close()
	io.Copy(out, in)
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true})
}

func (s *Server) handleFilesMove(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Src  string `json:"src"`
		Dest string `json:"dest"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	os.Rename(body.Src, body.Dest)
	json.NewEncoder(w).Encode(map[string]interface{}{"success": true})
}

func (s *Server) handleFilesSearch(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	query := r.URL.Query().Get("query")
	hidden := r.URL.Query().Get("showHidden") == "true"
	files, _ := filemanager.Search(path, query, hidden)
	json.NewEncoder(w).Encode(map[string]interface{}{"files": files})
}

func (s *Server) handleFilesDownload(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	info, err := os.Stat(path)
	if err != nil {
		http.Error(w, err.Error(), 404)
		return
	}
	if info.IsDir() {
		// Zip and download
		tmpFile := filepath.Join(os.TempDir(), info.Name()+".zip")
		filemanager.Zip([]string{path}, tmpFile)
		defer os.Remove(tmpFile)
		w.Header().Set("Content-Disposition", "attachment; filename="+info.Name()+".zip")
		http.ServeFile(w, r, tmpFile)
	} else {
		w.Header().Set("Content-Disposition", "attachment; filename="+info.Name())
		http.ServeFile(w, r, path)
	}
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			break
		}

		var msg struct {
			Type string          `json:"type"`
			ID   string          `json:"id"`
			Cols uint16          `json:"cols"`
			Rows uint16          `json:"rows"`
			Cwd  string          `json:"cwd"`
			Data json.RawMessage `json:"data"`
		}

		if err := json.Unmarshal(message, &msg); err != nil {
			continue
		}

		switch msg.Type {
		case "terminal:create":
			session, err := s.termMgr.Create(msg.ID, msg.Cwd, msg.Cols, msg.Rows)
			if err != nil {
				continue
			}
			go func() {
				buf := make([]byte, 1024)
				for {
					n, err := session.Read(buf)
					if n > 0 {
						resp, _ := json.Marshal(map[string]interface{}{
							"type": "terminal:data",
							"id":   msg.ID,
							"data": string(buf[:n]),
						})
						conn.WriteMessage(websocket.TextMessage, resp)
					}
					if err != nil {
						break
					}
				}
			}()
		case "terminal:input":
			var input string
			json.Unmarshal(msg.Data, &input)
			session := s.termMgr.Get(msg.ID)
			if session != nil {
				session.Write([]byte(input))
			}
		case "terminal:resize":
			session := s.termMgr.Get(msg.ID)
			if session != nil {
				session.Resize(msg.Cols, msg.Rows)
			}
		}
	}
}
