package agent

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// CodexAgent implements the Agent interface for OpenAI Codex CLI.
type CodexAgent struct{}

func (a *CodexAgent) AgentType() string    { return "codex" }
func (a *CodexAgent) SupportsResume() bool { return true }

func (a *CodexAgent) HistoryBasePath() string {
	if v := os.Getenv("CODEX_HOME"); v != "" {
		return filepath.Join(v, "sessions")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".codex", "sessions")
}

func (a *CodexAgent) HistoryGlobPattern() string { return "rollout-*.jsonl" }

func detectCodexModel() string {
	return readCodexConfigString("model")
}

func detectCodexContextWindow() int {
	value := readCodexConfigString("model_context_window")
	if value == "" {
		return 0
	}
	n, err := strconv.Atoi(value)
	if err != nil || n < 0 {
		return 0
	}
	return n
}

func readCodexConfigString(key string) string {
	home, _ := os.UserHomeDir()
	codexHome := os.Getenv("CODEX_HOME")
	if codexHome == "" {
		codexHome = filepath.Join(home, ".codex")
	}
	f, err := os.Open(filepath.Join(codexHome, "config.toml"))
	if err != nil {
		return ""
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, "[") {
			break
		}
		if idx := strings.IndexByte(line, '#'); idx >= 0 {
			line = strings.TrimSpace(line[:idx])
		}
		name, raw, ok := strings.Cut(line, "=")
		if !ok || strings.TrimSpace(name) != key {
			continue
		}
		raw = strings.TrimSpace(raw)
		raw = strings.Trim(raw, `"'`)
		return strings.TrimSpace(raw)
	}
	return ""
}

// ExtractSessions scans Codex history files under basePath and returns indexed sessions.
// Files whose mtime matches knownMtimes are skipped.
func (a *CodexAgent) ExtractSessions(basePath string, knownMtimes map[string]float64) ([]IndexedSession, error) {
	if basePath == "" {
		return nil, nil
	}
	if _, err := os.Stat(basePath); os.IsNotExist(err) {
		return nil, nil
	}
	// Codex stores sessions in YYYY/MM/DD/rollout-*.jsonl
	var sessions []IndexedSession
	err := filepath.Walk(basePath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // skip errors
		}
		if info.IsDir() {
			return nil
		}
		if !strings.HasPrefix(filepath.Base(path), "rollout-") || !strings.HasSuffix(path, ".jsonl") {
			return nil
		}
		mtime := float64(info.ModTime().Unix())
		if prev, ok := knownMtimes[path]; ok && prev == mtime {
			return nil // file unchanged since last index
		}
		sess, err := parseCodexSession(path, mtime)
		if err != nil {
			slog.Debug("codex: failed to parse session file", "path", path, "error", err)
			return nil
		}
		if sess != nil {
			sessions = append(sessions, *sess)
		}
		return nil
	})
	if err != nil {
		return sessions, err
	}
	return sessions, nil
}

// parseCodexSession parses a Codex JSONL session file.
func parseCodexSession(fpath string, mtime float64) (*IndexedSession, error) {
	f, err := os.Open(fpath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	// Derive session ID from filename: rollout-<timestamp>-<id>.jsonl
	sessionID := strings.TrimSuffix(filepath.Base(fpath), ".jsonl")

	var firstTS, lastTS *string
	var msgCount int
	var summary string

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}
		ts, _ := entry["timestamp"].(string)
		if ts != "" {
			if firstTS == nil {
				firstTS = &ts
			}
			tsCopy := ts
			lastTS = &tsCopy
		}
		role, _ := entry["role"].(string)
		if role == "user" || role == "assistant" {
			msgCount++
		}
		if summary == "" && role == "assistant" {
			if text := extractFirstText(entry["content"]); text != "" {
				if len(text) > 200 {
					text = text[:200]
				}
				summary = text
			}
		}
	}
	if msgCount == 0 {
		return nil, nil
	}
	return &IndexedSession{
		SessionID:      sessionID,
		SourceType:     "codex",
		SourceFile:     fpath,
		FileMtime:      mtime,
		FirstTimestamp: firstTS,
		LastTimestamp:  lastTS,
		MessageCount:   msgCount,
		DisplaySummary: summary,
	}, nil
}

func (a *CodexAgent) BuildLaunchCommand(params LaunchParams) string {
	bin := resolveBinary(params.CLIPath, "codex")
	var parts []string

	// Export env vars so child processes (coral-board, hooks) inherit them.
	// Single quotes prevent shell expansion; SanitizeShellValue strips metacharacters.
	if params.SessionName != "" {
		parts = append(parts, coralManagedCodexEnvReset()...)
	}
	if params.SessionName != "" {
		parts = append(parts, fmt.Sprintf(`export CORAL_SESSION_NAME='%s' &&`, SanitizeShellValue(params.SessionName)))
	}
	if params.Role != "" {
		parts = append(parts, fmt.Sprintf(`export CORAL_SUBSCRIBER_ID='%s' &&`, SanitizeShellValue(params.Role)))
	}
	if codexHome := prepareCoralManagedCodexHome(params); codexHome != "" {
		parts = append(parts, fmt.Sprintf(`export CODEX_HOME=%s &&`, shellQuote(codexHome)))
	}
	// Route LLM traffic through the Coral MITM proxy for transparent cost tracking.
	// HTTPS_PROXY must be exported BEFORE the binary (it's an env var, not a flag).
	if params.ProxyBaseURL != "" {
		proxyHost := extractProxyHost(params.ProxyBaseURL)
		if proxyHost != "" {
			parts = append(parts, fmt.Sprintf(`export HTTPS_PROXY='%s' &&`, proxyHost))
		}
		// Point SSL_CERT_FILE to a combined bundle (system CAs + Coral MITM CA)
		// so the Rust HTTP client trusts our dynamically generated certs.
		coralDir := params.CoralDir
		if coralDir == "" {
			if home, err := os.UserHomeDir(); err == nil {
				coralDir = filepath.Join(home, ".coral")
			}
		}
		if coralDir != "" {
			bundlePath := filepath.Join(coralDir, "proxy-ca-bundle.pem")
			parts = append(parts, fmt.Sprintf(`export SSL_CERT_FILE='%s' &&`, bundlePath))
		}
	}

	// NOTE: PATH injection is handled by callers via WrapWithBundlePath()

	// Binary and resume
	if params.ResumeSessionID != "" {
		parts = append(parts, bin, "resume", params.ResumeSessionID)
	} else {
		parts = append(parts, bin)
	}

	parts = append(parts, coralManagedCodexIsolationFlags(params)...)

	// Codex -c flags for MITM proxy (must come AFTER the binary)
	if params.ProxyBaseURL != "" {
		// Also set base URL for non-CONNECT fallback (direct HTTP proxy mode)
		if isCodexOAuthMode() {
			parts = append(parts, fmt.Sprintf(`-c chatgpt_base_url="%s"`, sanitizeURL(params.ProxyBaseURL)))
		} else {
			parts = append(parts, fmt.Sprintf(`-c openai_base_url="%s"`, sanitizeURL(params.ProxyBaseURL)))
		}
	}

	// System prompt injection via -c developer_instructions
	// Combines protocol file + board system prompt (CLI usage, role instructions)
	// Note: The $(cat '...') pattern shell-expands the file path but not its content.
	// The temp file path is from os.TempDir() (safe). Content sources (protocol files,
	// board prompts) are trusted internal strings.
	var sysParts []string
	if proto := readProtocolFile(params.ProtocolPath); proto != "" {
		sysParts = append(sysParts, proto)
	}
	boardSysPrompt := BuildBoardSystemPrompt(params.BoardName, params.Role, "", params.PromptOverrides, params.BoardType)
	if boardSysPrompt != "" {
		sysParts = append(sysParts, boardSysPrompt)
	}

	if len(sysParts) > 0 {
		sysFile := writeTempFile("codex_instructions", params.SessionID, "md", []byte(strings.Join(sysParts, "\n\n")))
		parts = append(parts, fmt.Sprintf(`-c developer_instructions="$(cat '%s')"`, sysFile))
	}

	// Note: Codex's sandbox may strip env vars from child processes.
	// coral-board handles this via board_state file fallback (reads job_title
	// from ~/.coral/board_state_{session}.json when CORAL_SUBSCRIBER_ID is unavailable).

	// Permission flags from capabilities
	userBypassSandbox := false
	for _, flag := range params.Flags {
		if flag == "--dangerously-skip-permissions" || flag == "--full-auto" || flag == "--dangerously-bypass-approvals-and-sandbox" {
			userBypassSandbox = true
			break
		}
	}

	bypassSandbox := userBypassSandbox
	if userBypassSandbox {
		parts = append(parts, "--dangerously-bypass-approvals-and-sandbox")
	}
	if perms := TranslateToCodexPermissions(params.Capabilities); perms != nil {
		if userBypassSandbox {
			// Team/user permission flags take precedence over per-agent capability
			// defaults. Keep web search below, but do not add conflicting sandbox flags.
		} else if perms.BypassSandbox {
			bypassSandbox = true
			parts = append(parts, "--dangerously-bypass-approvals-and-sandbox")
		} else if perms.FullAuto {
			parts = append(parts, "--sandbox", "workspace-write", "-a", "on-request")
		} else {
			if perms.SandboxMode != "" {
				parts = append(parts, "--sandbox", perms.SandboxMode)
			}
			if perms.ApprovalPolicy != "" {
				parts = append(parts, "-a", perms.ApprovalPolicy)
			}
		}
		if perms.Search {
			parts = append(parts, "--search")
		}
	}

	// User-provided flags — translate or drop Claude-specific flags
	claudeOnlyFlags := map[string]bool{
		"--settings": true, "--session-id": true, "--resume": true, "--permission-mode": true,
	}
	claudeOnlyFlagsWithValue := map[string]bool{
		"--settings": true, "--session-id": true, "--permission-mode": true,
	}
	for i := 0; i < len(params.Flags); i++ {
		flag := params.Flags[i]
		if flag == "--dangerously-skip-permissions" || flag == "--full-auto" || flag == "--dangerously-bypass-approvals-and-sandbox" {
			// Translate legacy/high-autonomy flags to the current Codex bypass flag.
			if !bypassSandbox {
				parts = append(parts, "--dangerously-bypass-approvals-and-sandbox")
				bypassSandbox = true
			}
			continue
		}
		if bypassSandbox && (flag == "--sandbox" || flag == "-a") {
			if i+1 < len(params.Flags) {
				i++
			}
			continue
		}
		if claudeOnlyFlags[flag] {
			slog.Warn("dropping Claude-specific flag for Codex agent", "flag", flag)
			if claudeOnlyFlagsWithValue[flag] && i+1 < len(params.Flags) && !strings.HasPrefix(params.Flags[i+1], "-") {
				i++
			}
			continue
		}
		if strings.HasPrefix(flag, "--permission-mode=") {
			slog.Warn("dropping Claude-specific flag for Codex agent", "flag", "--permission-mode")
			continue
		}
		parts = append(parts, flag)
	}

	// Action prompt as separate positional argument
	actionPrompt := BuildBoardActionPrompt(params.BoardName, params.Role, params.Prompt, params.PromptOverrides, params.BoardType)
	if actionPrompt == "" {
		actionPrompt = params.Prompt
	}

	if actionPrompt != "" {
		promptFile := writeTempFile("codex_prompt", params.SessionID, "txt", []byte(actionPrompt))
		parts = append(parts, FormatPromptFileArg(promptFile))
	}

	return strings.Join(ShellQuoteParts(parts), " ")
}

// coralManagedCodexIsolationFlags prevents Coral-launched Codex agents from
// inheriting user-global MCP/plugin startup. Failed MCP logins can suspend the
// Codex TUI under zsh before Coral can deliver input to it.
func coralManagedCodexIsolationFlags(params LaunchParams) []string {
	if params.SessionName == "" {
		return nil
	}
	flags := []string{"-c", "mcp_servers={}"}
	for _, name := range configuredCodexMCPServerNames() {
		if isCodexBareConfigKey(name) {
			flags = append(flags, "-c", fmt.Sprintf("mcp_servers.%s.enabled=false", name))
		}
	}
	for _, feature := range []string{
		"apps",
		"plugins",
		"plugin_sharing",
		"skill_mcp_dependency_install",
		"tool_search",
		"tool_suggest",
		"tool_call_mcp_elicitation",
		"browser_use",
		"browser_use_external",
		"in_app_browser",
		"computer_use",
		"image_generation",
		"workspace_dependencies",
		"multi_agent",
		"hooks",
		"plugin_hooks",
		"external_migration",
	} {
		flags = append(flags, "--disable", feature)
	}
	return flags
}

func configuredCodexMCPServerNames() []string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return nil
	}
	data, err := os.ReadFile(filepath.Join(home, ".codex", "config.toml"))
	if err != nil {
		return nil
	}
	names := make(map[string]bool)
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "[") || !strings.HasSuffix(line, "]") {
			continue
		}
		parts := tomlSectionPath(strings.TrimSpace(strings.Trim(line, "[]")))
		if len(parts) >= 2 && parts[0] == "mcp_servers" {
			names[parts[1]] = true
		}
	}
	out := make([]string, 0, len(names))
	for name := range names {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

func tomlSectionPath(section string) []string {
	var parts []string
	for i := 0; i < len(section); {
		for i < len(section) && (section[i] == ' ' || section[i] == '\t' || section[i] == '.') {
			i++
		}
		if i >= len(section) {
			break
		}
		if section[i] == '"' {
			i++
			var b strings.Builder
			for i < len(section) {
				if section[i] == '\\' && i+1 < len(section) {
					i++
					b.WriteByte(section[i])
					i++
					continue
				}
				if section[i] == '"' {
					i++
					break
				}
				b.WriteByte(section[i])
				i++
			}
			parts = append(parts, b.String())
			continue
		}
		start := i
		for i < len(section) && section[i] != '.' {
			i++
		}
		if part := strings.TrimSpace(section[start:i]); part != "" {
			parts = append(parts, part)
		}
	}
	return parts
}

func isCodexBareConfigKey(name string) bool {
	if name == "" {
		return false
	}
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') ||
			r == '_' || r == '-' {
			continue
		}
		return false
	}
	return true
}

func coralManagedCodexEnvReset() []string {
	return []string{
		"unset CODEX_CI CODEX_SHELL CODEX_THREAD_ID CODEX_INTERNAL_ORIGINATOR_OVERRIDE CODEX_ROLLOUT_TRACE_ROOT CODEX_TUI_RECORD_SESSION CODEX_TUI_SESSION_LOG_PATH CODEX_EXEC_SERVER_REMOTE_BEARER_TOKEN CODEX_ESCALATE_SOCKET CODEX_NETWORK_PROXY_ACTIVE &&",
	}
}

func prepareCoralManagedCodexHome(params LaunchParams) string {
	if params.SessionName == "" {
		return ""
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	coralDir := params.CoralDir
	if coralDir == "" {
		coralDir = filepath.Join(home, ".coral")
	}
	codexHome := filepath.Join(coralDir, "codex-home", coralManagedCodexHomeID(params))
	if err := os.MkdirAll(codexHome, 0700); err != nil {
		slog.Warn("codex: failed to create Coral Codex home", "path", codexHome, "error", err)
		return ""
	}

	userCodexHome := filepath.Join(home, ".codex")
	config := filterCodexConfigForCoral(filepath.Join(userCodexHome, "config.toml"))
	config = appendCoralCodexProjectTrust(config, params.WorkingDir)
	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte(config), 0600); err != nil {
		slog.Warn("codex: failed to write Coral Codex config", "path", codexHome, "error", err)
	}
	linkOrCopyCodexFile(filepath.Join(userCodexHome, "auth.json"), filepath.Join(codexHome, "auth.json"))
	linkCodexDir(filepath.Join(userCodexHome, "sessions"), filepath.Join(codexHome, "sessions"))
	return codexHome
}

func coralManagedCodexHomeID(params LaunchParams) string {
	id := params.SessionID
	if id == "" {
		id = params.SessionName
	}
	var b strings.Builder
	for _, r := range id {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') ||
			r == '-' || r == '_' || r == '.' {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	if b.Len() == 0 {
		return "session"
	}
	return b.String()
}

func appendCoralCodexProjectTrust(config, workingDir string) string {
	workingDir = strings.TrimSpace(workingDir)
	if workingDir == "" {
		return config
	}
	if abs, err := filepath.Abs(workingDir); err == nil {
		workingDir = abs
	}
	section := fmt.Sprintf("[projects.%q]", filepath.Clean(workingDir))
	if strings.Contains(config, section) {
		return config
	}
	base := strings.TrimSpace(config)
	trust := section + "\ntrust_level = \"trusted\"\n"
	if base == "" {
		return trust
	}
	return base + "\n\n" + trust
}

func filterCodexConfigForCoral(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return coralCodexFeatureConfig()
	}
	var out []string
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	skipSection := false
	for scanner.Scan() {
		line := scanner.Text()
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			skipSection = shouldDropCoralCodexConfigSection(trimmed)
			if skipSection {
				continue
			}
		}
		if skipSection {
			continue
		}
		out = append(out, line)
	}
	base := strings.TrimSpace(strings.Join(out, "\n"))
	if base != "" {
		base += "\n\n"
	}
	return base + coralCodexFeatureConfig()
}

func shouldDropCoralCodexConfigSection(section string) bool {
	return section == "[features]" ||
		section == "[skills]" ||
		section == "[mcp_servers]" ||
		section == "[plugins]" ||
		section == "[marketplaces]" ||
		section == "[apps]" ||
		strings.HasPrefix(section, "[mcp_servers.") ||
		strings.HasPrefix(section, "[plugins.") ||
		strings.HasPrefix(section, "[marketplaces.") ||
		strings.HasPrefix(section, "[apps.") ||
		strings.HasPrefix(section, "[skills.")
}

func coralCodexFeatureConfig() string {
	return strings.TrimSpace(`
[features]
apps = false
plugins = false
plugin_sharing = false
skill_mcp_dependency_install = false
tool_search = false
tool_suggest = false
tool_call_mcp_elicitation = false
browser_use = false
browser_use_external = false
in_app_browser = false
computer_use = false
image_generation = false
workspace_dependencies = false
multi_agent = false
hooks = false
plugin_hooks = false
external_migration = false

[skills]
include_instructions = false
`) + "\n"
}

func linkOrCopyCodexFile(src, dst string) {
	if _, err := os.Stat(src); err != nil {
		return
	}
	_ = os.Remove(dst)
	if err := os.Symlink(src, dst); err == nil {
		return
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return
	}
	if err := os.WriteFile(dst, data, 0600); err != nil {
		slog.Warn("codex: failed to copy file into Coral Codex home", "path", dst, "error", err)
	}
}

func linkCodexDir(src, dst string) {
	if info, err := os.Stat(src); err != nil || !info.IsDir() {
		return
	}
	_ = os.Remove(dst)
	if err := os.Symlink(src, dst); err != nil {
		slog.Debug("codex: failed to symlink directory into Coral Codex home", "src", src, "dst", dst, "error", err)
	}
}

// isCodexOAuthMode checks if the Codex CLI is configured to use ChatGPT OAuth
// auth (as opposed to an API key). Reads ~/.codex/auth.json and checks auth_mode.
func isCodexOAuthMode() bool {
	home, err := os.UserHomeDir()
	if err != nil {
		return false
	}
	data, err := os.ReadFile(filepath.Join(home, ".codex", "auth.json"))
	if err != nil {
		return false
	}
	var auth struct {
		AuthMode string `json:"auth_mode"`
	}
	if err := json.Unmarshal(data, &auth); err != nil {
		return false
	}
	return auth.AuthMode == "chatgpt"
}

// extractProxyHost extracts the scheme://host:port from a proxy URL.
// e.g. "http://127.0.0.1:8420/proxy/abc" → "http://127.0.0.1:8420"
func extractProxyHost(proxyURL string) string {
	u, err := url.Parse(proxyURL)
	if err != nil {
		return ""
	}
	return fmt.Sprintf("%s://%s", u.Scheme, u.Host)
}
