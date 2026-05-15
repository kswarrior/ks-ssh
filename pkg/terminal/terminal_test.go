package terminal

import "testing"

func TestManager(t *testing.T) {
	m := NewManager()
	s, err := m.Create("test", "", 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Kill()

	if m.Get("test") == nil {
		t.Error("Session not found")
	}
}
