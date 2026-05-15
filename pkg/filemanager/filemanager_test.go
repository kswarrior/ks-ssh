package filemanager

import (
	"os"
	"path/filepath"
	"testing"
)

func TestList(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "testlist")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir)

	os.Create(filepath.Join(tmpDir, "file1.txt"))
	os.Mkdir(filepath.Join(tmpDir, "dir1"), 0755)

	res, err := List(tmpDir, false)
	if err != nil {
		t.Fatal(err)
	}

	if len(res.Files) != 2 {
		t.Errorf("expected 2 files, got %d", len(res.Files))
	}
}
