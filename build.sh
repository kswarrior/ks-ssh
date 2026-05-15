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
go build -o ks-ssh-go main.go

echo "Build complete! Binary: ./ks-ssh-go"
