# Bug Notes

Captured during the UI overhaul pass. These are not fixed in this pass.

## High

- Team sidebar `Reset Team` appears to call `resetTeam(...)` inline, but `resetTeam` is module scoped and is not exported onto `window`. Clicking it should throw `ReferenceError` and do nothing.
  - `coral-go/internal/server/frontend/static/render.js`
  - `coral-go/internal/server/frontend/static/app.js`

- Custom data directories break `coral-board` and message-check state lookup. The server writes board state to `cfg.CoralDir()`, while CLI tools read only `~/.coral`. This affects local UI runs using `CORAL_DATA_DIR` or `--home`.
  - `coral-go/internal/server/routes/sessions.go`
  - `coral-go/cmd/coral-board/main.go`
  - `coral-go/cmd/coral-hook-message-check/main.go`

## Medium

- `coral-tray --home` creates and changes into the requested directory, but still loads config from default `~/.coral`. Local native test runs may accidentally use production sessions, settings, or auth.
  - `coral-go/cmd/coral-tray/main.go`
  - `coral-go/internal/config/config.go`

- Codex proxy certificate path can ignore custom Coral dirs on UI launches. The server generates the proxy CA bundle in `cfg.CoralDir()`, but Codex falls back to `~/.coral/proxy-ca-bundle.pem` unless `LaunchParams.CoralDir` is set.
  - `coral-go/internal/agent/codex.go`
  - `coral-go/internal/server/routes/sessions.go`

- Auth cookie security behavior does not match the comment. Query-param API key creates a session cookie, but `Secure` is set only when `r.TLS != nil`; remote HTTP LAN sessions get a non-secure cookie.
  - `coral-go/internal/auth/middleware.go`
  - `coral-go/internal/auth/keystore.go`

## Low Or Packaging

- The UI depends on remote Google Fonts and Material Icons. Offline or restricted networks can visibly degrade typography and icons.
  - `coral-go/internal/server/frontend/templates/index.html`

- The service worker app shell pre-caches `/static/style.css`, while the main app loads individual CSS files. I bumped the cache name as part of the UI work, but the broader offline shell strategy is still inconsistent.
  - `coral-go/internal/server/frontend/static/sw.js`
  - `coral-go/internal/server/frontend/templates/index.html`

- macOS packaging references old `scripts/...` paths instead of current `tools/...` paths, so bundling, minification, or smoke tests may be skipped.
  - `installers/build-macos.sh`
