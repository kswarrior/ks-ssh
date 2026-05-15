package portscan

import (
	"bufio"
	"os"
	"sort"
	"strconv"
	"strings"
)

type PortInfo struct {
	Port    int    `json:"port"`
	Process string `json:"process"`
	Address string `json:"address"`
}

func Scan() ([]PortInfo, error) {
	ports := make([]PortInfo, 0)
	seen := make(map[int]bool)

	// Scanning /proc/net/tcp and /proc/net/tcp6
	files := []string{"/proc/net/tcp", "/proc/net/tcp6"}
	for _, file := range files {
		f, err := os.Open(file)
		if err != nil {
			continue
		}
		defer f.Close()

		scanner := bufio.NewScanner(f)
		if scanner.Scan() { // skip header
			for scanner.Scan() {
				line := scanner.Text()
				fields := strings.Fields(line)
				if len(fields) < 4 {
					continue
				}

				// Status 0A means LISTEN
				if fields[3] != "0A" {
					continue
				}

				localAddr := fields[1]
				parts := strings.Split(localAddr, ":")
				if len(parts) < 2 {
					continue
				}

				port64, _ := strconv.ParseInt(parts[1], 16, 32)
				port := int(port64)

				if port > 0 && port <= 65535 && !seen[port] {
					seen[port] = true
					address := "127.0.0.1"
					if parts[0] == "00000000" || parts[0] == "00000000000000000000000000000000" {
						address = "0.0.0.0"
					}
					ports = append(ports, PortInfo{
						Port:    port,
						Process: "unknown",
						Address: address,
					})
				}
			}
		}
	}

	sort.Slice(ports, func(i, j int) bool {
		return ports[i].Port < ports[j].Port
	})

	return ports, nil
}
