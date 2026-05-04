package routes

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/cdknorow/coral/internal/config"
)

const maxLocalPreviewBytes int64 = 10 << 20

var localPreviewExtensions = map[string]bool{
	".bash":   true,
	".c":      true,
	".cpp":    true,
	".cs":     true,
	".css":    true,
	".csv":    true,
	".go":     true,
	".h":      true,
	".hpp":    true,
	".html":   true,
	".java":   true,
	".js":     true,
	".json":   true,
	".jsonl":  true,
	".jsx":    true,
	".kt":     true,
	".log":    true,
	".md":     true,
	".ndjson": true,
	".py":     true,
	".rb":     true,
	".rs":     true,
	".scss":   true,
	".sh":     true,
	".sql":    true,
	".swift":  true,
	".toml":   true,
	".ts":     true,
	".tsx":    true,
	".tsv":    true,
	".txt":    true,
	".xml":    true,
	".yaml":   true,
	".yml":    true,
	".zsh":    true,
}

// LocalFilesHandler serves read-only previews for local text artifacts linked
// from terminal output. It intentionally does not expose a save endpoint.
type LocalFilesHandler struct {
	cfg *config.Config
}

func NewLocalFilesHandler(cfg *config.Config) *LocalFilesHandler {
	return &LocalFilesHandler{cfg: cfg}
}

// Preview returns a small text file under the user's local Coral roots.
// GET /api/files/local-preview?path=/absolute/path/file.json
// GET /api/files/local-preview?path=relative/file.json&base=/agent/workdir
func (h *LocalFilesHandler) Preview(w http.ResponseWriter, r *http.Request) {
	rawPath := strings.TrimSpace(r.URL.Query().Get("path"))
	if rawPath == "" || strings.HasPrefix(rawPath, "-") || strings.Contains(rawPath, "\x00") {
		errBadRequest(w, "path is required")
		return
	}

	requestedPath, err := expandLocalPath(rawPath, strings.TrimSpace(r.URL.Query().Get("base")))
	if err != nil {
		errBadRequest(w, "invalid path")
		return
	}
	info, err := os.Stat(requestedPath)
	if err != nil || info.IsDir() {
		errNotFound(w, "File not found")
		return
	}
	fullPath, err := filepath.EvalSymlinks(requestedPath)
	if err != nil {
		errNotFound(w, "File not found")
		return
	}
	if !h.isAllowedLocalPath(fullPath) {
		errForbidden(w, "Path is outside the configured local preview roots")
		return
	}
	if !localPreviewExtensions[strings.ToLower(filepath.Ext(requestedPath))] {
		errForbidden(w, "Only text-like files can be previewed")
		return
	}
	if info.Size() > maxLocalPreviewBytes {
		errBadRequest(w, "File is too large to preview")
		return
	}

	content, err := os.ReadFile(fullPath)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	if !utf8.Valid(content) {
		errBadRequest(w, "File is not valid UTF-8 text")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"filepath": fullPath,
		"content":  string(content),
		"size":     info.Size(),
		"readonly": true,
	})
}

func expandLocalPath(rawPath string, basePath string) (string, error) {
	if strings.HasPrefix(rawPath, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		rawPath = filepath.Join(home, rawPath[2:])
	}
	if filepath.IsAbs(rawPath) {
		absPath, err := filepath.Abs(rawPath)
		if err != nil {
			return "", err
		}
		return absPath, nil
	}

	candidates := make([]string, 0, 2)
	if basePath != "" && !strings.Contains(basePath, "\x00") {
		if baseAbs, err := expandLocalPath(basePath, ""); err == nil {
			candidates = append(candidates, filepath.Join(baseAbs, rawPath))
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates, filepath.Join(home, rawPath))
	}
	if len(candidates) == 0 {
		return "", os.ErrInvalid
	}

	for _, candidate := range candidates {
		absPath, err := filepath.Abs(candidate)
		if err != nil {
			continue
		}
		if _, err := os.Stat(absPath); err == nil {
			return absPath, nil
		}
	}
	return filepath.Abs(candidates[0])
}

func (h *LocalFilesHandler) isAllowedLocalPath(fullPath string) bool {
	for _, root := range h.localPreviewRoots() {
		rel, err := filepath.Rel(root, fullPath)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
			return true
		}
	}
	return false
}

func (h *LocalFilesHandler) localPreviewRoots() []string {
	home, _ := os.UserHomeDir()
	candidates := []string{home}
	if h.cfg != nil {
		candidates = append(candidates, h.cfg.CoralRoot, h.cfg.CoralDir())
	}

	roots := make([]string, 0, len(candidates))
	seen := make(map[string]bool, len(candidates))
	for _, root := range candidates {
		if root == "" {
			continue
		}
		absRoot, err := filepath.Abs(root)
		if err != nil {
			continue
		}
		if resolved, err := filepath.EvalSymlinks(absRoot); err == nil {
			absRoot = resolved
		}
		if !seen[absRoot] {
			roots = append(roots, absRoot)
			seen[absRoot] = true
		}
	}
	return roots
}
