package portscan

import "testing"

func TestScan(t *testing.T) {
	ports, err := Scan()
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("Found %d listening ports", len(ports))
}
