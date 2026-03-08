package main

import (
        "encoding/json"
        "fmt"
        "io"
        "log"
        "net/http"
        "os"
        "os/exec"
        "sync"

        "github.com/creack/pty"
        "github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
        CheckOrigin: func(r *http.Request) bool {
                return true // Allow all origins for the terminal
        },
}

type TerminalMessage struct {
        Type string `json:"type"`
        Rows uint16 `json:"rows,omitempty"`
        Cols uint16 `json:"cols,omitempty"`
}

func handleTerminal(w http.ResponseWriter, r *http.Request) {
        conn, err := upgrader.Upgrade(w, r, nil)
        if err != nil {
                log.Println("Upgrade error:", err)
                return
        }
        defer conn.Close()

        // Spawn the shell process
        shell := os.Getenv("SHELL")
        if shell == "" {
                shell = "bash" // Fallback to bash
        }

        cmd := exec.Command(shell)

        // Start the command with a pty
        ptmx, err := pty.Start(cmd)
        if err != nil {
                log.Println("PTY start error:", err)
                return
        }
        defer func() {
                _ = ptmx.Close()
                _ = cmd.Process.Kill()
                _ = cmd.Wait()
        }()

        var wg sync.WaitGroup
        wg.Add(2)

        // Copy from pty to websocket
        go func() {
                defer wg.Done()
                buf := make([]byte, 1024)
                for {
                        n, err := ptmx.Read(buf)
                        if err != nil {
                                if err != io.EOF {
                                        log.Println("PTY read error:", err)
                                }
                                break
                        }
                        err = conn.WriteMessage(websocket.BinaryMessage, buf[:n])
                        if err != nil {
                                log.Println("WS write error:", err)
                                break
                        }
                }
                conn.Close()
                ptmx.Close()
        }()

        // Copy from websocket to pty
        go func() {
                defer wg.Done()
                for {
                        messageType, p, err := conn.ReadMessage()
                        if err != nil {
                                log.Println("WS read error:", err)
                                break
                        }

                        if messageType == websocket.TextMessage && len(p) > 0 && p[0] == '{' && p[len(p)-1] == '}' {
                                var msg TerminalMessage
                                if err := json.Unmarshal(p, &msg); err == nil && msg.Type == "resize" {
                                        pty.Setsize(ptmx, &pty.Winsize{
                                                Rows: msg.Rows,
                                                Cols: msg.Cols,
                                        })
                                        continue
                                }
                        }

                        _, err = ptmx.Write(p)
                        if err != nil {
                                log.Println("PTY write error:", err)
                                break
                        }
                }
                conn.Close()
                ptmx.Close()
        }()

        wg.Wait()
}

func main() {
        // Serve static files
        fs := http.FileServer(http.Dir("./static"))
        http.Handle("/", fs)

        // WebSocket endpoint
        http.HandleFunc("/ws", handleTerminal)

        port := "0.0.0.0:5000"
        fmt.Printf("KS SSH Server starting on http://localhost:5000\n")

        err := http.ListenAndServe(port, nil)
        if err != nil {
                log.Fatal("Server error:", err)
        }
}
