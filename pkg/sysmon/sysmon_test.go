package sysmon

import (
	"testing"
)

func TestGetStats(t *testing.T) {
	// Since it depends on /proc, it might fail on non-linux
	stats := GetStats()
	if stats.RAM.Total == 0 {
		t.Log("RAM Total is 0, possibly not on Linux or /proc not available")
	}
}

func TestGetSystemInfo(t *testing.T) {
	info := GetSystemInfo()
	if info.Hostname == "" {
		t.Error("Hostname is empty")
	}
}
