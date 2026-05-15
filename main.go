package main

import (
	"embed"
	"fmt"
	"io/fs"
	"net/http"
	"os"

	"github.com/user/ks-ssh-go/pkg/server"
)

//go:embed web/dist/*
var webAssets embed.FS

func main() {
	port := 3000

	// Get the subtree for web/dist
	sub, err := fs.Sub(webAssets, "web/dist")
	if err != nil {
		fmt.Printf("Error getting sub FS: %v\n", err)
		os.Exit(1)
	}

	srv := server.NewServer(http.FS(sub), port)

	fmt.Printf("Server starting on http://localhost:%d\n", port)
	if err := http.ListenAndServe(fmt.Sprintf(":%d", port), srv.Router()); err != nil {
		fmt.Printf("Server error: %v\n", err)
	}
}
