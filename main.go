package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"

	"github.com/user/ks-ssh-go/pkg/server"
)

//go:embed web/dist/*
var webAssets embed.FS

func main() {
	port := flag.Int("port", 3000, "Port to listen on")
	subdomain := flag.String("url", "", "Custom subdomain for the tunnel")
	flag.Parse()

	// Check if port is already in use
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", *port))
	if err != nil {
		fmt.Printf("\033[31mError: Port %d is already in use. Please select a different port.\033[0m\n", *port)
		os.Exit(1)
	}
	ln.Close()

	// Get the subtree for web/dist
	sub, err := fs.Sub(webAssets, "web/dist")
	if err != nil {
		fmt.Printf("Error getting sub FS: %v\n", err)
		os.Exit(1)
	}

	srv := server.NewServer(http.FS(sub), *port, *subdomain)

	fmt.Printf("Server starting on http://localhost:%d\n", *port)
	if err := http.ListenAndServe(fmt.Sprintf(":%d", *port), srv.Router()); err != nil {
		fmt.Printf("Server error: %v\n", err)
	}
}
