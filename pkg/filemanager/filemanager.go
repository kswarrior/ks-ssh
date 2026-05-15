package filemanager

import (
	"archive/zip"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type FileInfo struct {
	Name        string    `json:"name"`
	Path        string    `json:"path"`
	IsDirectory bool      `json:"isDirectory"`
	Size        int64     `json:"size"`
	Modified    time.Time `json:"modified"`
	Ext         string    `json:"ext"`
}

type ListResult struct {
	Path   string     `json:"path"`
	Parent string     `json:"parent"`
	Files  []FileInfo `json:"files"`
}

func List(dirPath string, showHidden bool) (*ListResult, error) {
	if dirPath == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		dirPath = home
	}

	absPath, err := filepath.Abs(dirPath)
	if err != nil {
		return nil, err
	}

	entries, err := os.ReadDir(absPath)
	if err != nil {
		return nil, err
	}

	var files []FileInfo
	for _, entry := range entries {
		name := entry.Name()
		if !showHidden && strings.HasPrefix(name, ".") {
			continue
		}

		fullPath := filepath.Join(absPath, name)
		info, err := entry.Info()
		var size int64
		var modified time.Time
		if err == nil {
			size = info.Size()
			modified = info.ModTime()
		}

		files = append(files, FileInfo{
			Name:        name,
			Path:        fullPath,
			IsDirectory: entry.IsDir(),
			Size:        size,
			Modified:    modified,
			Ext:         strings.ToLower(filepath.Ext(name)),
		})
	}

	sort.Slice(files, func(i, j int) bool {
		if files[i].IsDirectory && !files[j].IsDirectory {
			return true
		}
		if !files[i].IsDirectory && files[j].IsDirectory {
			return false
		}
		return strings.ToLower(files[i].Name) < strings.ToLower(files[j].Name)
	})

	return &ListResult{
		Path:   absPath,
		Parent: filepath.Dir(absPath),
		Files:  files,
	}, nil
}

func Search(baseDir, query string, showHidden bool) ([]FileInfo, error) {
	var results []FileInfo
	err := filepath.Walk(baseDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // ignore errors
		}
		if len(results) > 200 {
			return filepath.SkipDir
		}

		name := info.Name()
		if !showHidden && strings.HasPrefix(name, ".") && path != baseDir {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		if strings.Contains(strings.ToLower(name), strings.ToLower(query)) {
			results = append(results, FileInfo{
				Name:        name,
				Path:        path,
				IsDirectory: info.IsDir(),
				Size:        info.Size(),
				Modified:    info.ModTime(),
				Ext:         strings.ToLower(filepath.Ext(name)),
			})
		}
		return nil
	})
	return results, err
}

func Zip(paths []string, outPath string) error {
	zipFile, err := os.Create(outPath)
	if err != nil {
		return err
	}
	defer zipFile.Close()

	archive := zip.NewWriter(zipFile)
	defer archive.Close()

	for _, srcPath := range paths {
		err = filepath.Walk(srcPath, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return err
			}

			header, err := zip.FileInfoHeader(info)
			if err != nil {
				return err
			}

			rel, err := filepath.Rel(filepath.Dir(srcPath), path)
			if err != nil {
				return err
			}
			header.Name = rel

			if info.IsDir() {
				header.Name += "/"
			} else {
				header.Method = zip.Deflate
			}

			writer, err := archive.CreateHeader(header)
			if err != nil {
				return err
			}

			if !info.IsDir() {
				file, err := os.Open(path)
				if err != nil {
					return err
				}
				defer file.Close()
				_, err = io.Copy(writer, file)
				return err
			}
			return nil
		})
		if err != nil {
			return err
		}
	}
	return nil
}
