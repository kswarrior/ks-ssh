package sysmon

import (
	"bufio"
	"fmt"
	"os"
	"os/user"
	"runtime"
	"strconv"
	"strings"
)

type CPUStats struct {
	Total uint64
	Idle  uint64
}

type RAMInfo struct {
	Total   float64 `json:"total"`
	Used    float64 `json:"used"`
	Percent float64 `json:"percent"`
}

type CPUInfo struct {
	Percent float64   `json:"percent"`
	Cores   []float64 `json:"cores"`
	Model   string    `json:"model"`
	Count   int       `json:"count"`
}

type Stats struct {
	RAM RAMInfo `json:"ram"`
	CPU CPUInfo `json:"cpu"`
}

type SystemInfo struct {
	Hostname string  `json:"hostname"`
	Platform string  `json:"platform"`
	Arch     string  `json:"arch"`
	Uptime   int64   `json:"uptime"`
	CPUs     int     `json:"cpus"`
	Home     string  `json:"home"`
	User     string  `json:"user"`
	OSName   string  `json:"osName"`
	Kernel   string  `json:"kernel"`
	Shell    string  `json:"shell"`
	Logo     string  `json:"logo"`
	IP       string  `json:"ip"`
	Packages string  `json:"packages"`
}

var lastCPUTotal uint64
var lastCPUIdle uint64

func GetStats() Stats {
	totalMem, freeMem := getMemInfo()
	usedMem := totalMem - freeMem
	ram := RAMInfo{
		Total:   float64(totalMem) / (1024 * 1024 * 1024),
		Used:    float64(usedMem) / (1024 * 1024 * 1024),
		Percent: (float64(usedMem) / float64(totalMem)) * 100,
	}

	cpuPercent := getCPUUsage()
	cpu := CPUInfo{
		Percent: cpuPercent,
		Count:   runtime.NumCPU(),
		Model:   getCPUModel(),
	}

	return Stats{RAM: ram, CPU: cpu}
}

func GetSystemInfo() SystemInfo {
	hostname, _ := os.Hostname()
	currUser, _ := user.Current()
	uptime := getUptime()

	return SystemInfo{
		Hostname: hostname,
		Platform: runtime.GOOS,
		Arch:     runtime.GOARCH,
		Uptime:   uptime,
		CPUs:     runtime.NumCPU(),
		Home:     currUser.HomeDir,
		User:     currUser.Username,
		OSName:   getOSName(),
		Kernel:   getKernelVersion(),
		Shell:    os.Getenv("SHELL"),
		Logo:     "🐧",
		IP:       "127.0.0.1", // Simplified
		Packages: "N/A",
	}
}

func getMemInfo() (total, free uint64) {
	file, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "MemTotal:") {
			fmt.Sscanf(line, "MemTotal: %d", &total)
			total *= 1024
		} else if strings.HasPrefix(line, "MemAvailable:") {
			fmt.Sscanf(line, "MemAvailable: %d", &free)
			free *= 1024
		}
	}
	return
}

func getCPUUsage() float64 {
	file, err := os.Open("/proc/stat")
	if err != nil {
		return 0
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	if scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 5 {
			return 0
		}
		user, _ := strconv.ParseUint(fields[1], 10, 64)
		nice, _ := strconv.ParseUint(fields[2], 10, 64)
		system, _ := strconv.ParseUint(fields[3], 10, 64)
		idle, _ := strconv.ParseUint(fields[4], 10, 64)
		iowait, _ := strconv.ParseUint(fields[5], 10, 64)
		irq, _ := strconv.ParseUint(fields[6], 10, 64)
		softirq, _ := strconv.ParseUint(fields[7], 10, 64)

		total := user + nice + system + idle + iowait + irq + softirq
		idleTotal := idle + iowait

		if lastCPUTotal > 0 {
			diffTotal := total - lastCPUTotal
			diffIdle := idleTotal - lastCPUIdle
			if diffTotal > 0 {
				usage := float64(diffTotal-diffIdle) / float64(diffTotal) * 100
				lastCPUTotal = total
				lastCPUIdle = idleTotal
				return usage
			}
		}
		lastCPUTotal = total
		lastCPUIdle = idleTotal
	}
	return 0
}

func getCPUModel() string {
	file, err := os.Open("/proc/cpuinfo")
	if err != nil {
		return "Unknown"
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "model name") {
			parts := strings.Split(line, ":")
			if len(parts) > 1 {
				return strings.TrimSpace(parts[1])
			}
		}
	}
	return "Unknown"
}

func getUptime() int64 {
	file, err := os.Open("/proc/uptime")
	if err != nil {
		return 0
	}
	defer file.Close()

	var uptime float64
	fmt.Fscanf(file, "%f", &uptime)
	return int64(uptime)
}

func getOSName() string {
	file, err := os.Open("/etc/os-release")
	if err != nil {
		return runtime.GOOS
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "PRETTY_NAME=") {
			return strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), "\"")
		}
	}
	return runtime.GOOS
}

func getKernelVersion() string {
	data, _ := os.ReadFile("/proc/version")
	parts := strings.Fields(string(data))
	if len(parts) > 2 {
		return parts[2]
	}
	return "Unknown"
}
