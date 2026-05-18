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

# Build for standard Intel/AMD VPS
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o ks-ssh-go-amd64 main.go

# Build for ARM VPS
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o ks-ssh-go-arm64 main.go

echo "Build complete!"
