#!/bin/bash
set -e

echo "Starting build process..."

# 1. Build frontend
echo "Building frontend with Vite..."
cd web
npm install
npm run build
cd ..

# 2. Build Go backend
echo "Building Go backend..."
go mod tidy

# --- Linux Server Architectures ---
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o ks-ssh-go-linux-amd64 main.go
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o ks-ssh-go-linux-arm64 main.go
CGO_ENABLED=0 GOOS=linux GOARCH=386 go build -o ks-ssh-go-linux-386 main.go
CGO_ENABLED=0 GOOS=linux GOARCH=arm go build -o ks-ssh-go-linux-arm main.go

# --- Android / Mobile Environments (Termux) ---
CGO_ENABLED=0 GOOS=android GOARCH=arm64 go build -o ks-ssh-go-android-arm64 main.go
CGO_ENABLED=0 GOOS=android GOARCH=arm go build -o ks-ssh-go-android-arm main.go

# --- macOS Devices ---
CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -o ks-ssh-go-darwin-amd64 main.go
CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -o ks-ssh-go-darwin-arm64 main.go

# --- Windows Systems ---
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -o ks-ssh-go-windows-amd64.exe main.go
CGO_ENABLED=0 GOOS=windows GOARCH=arm64 go build -o ks-ssh-go-windows-arm64.exe main.go

echo "Build complete!"
