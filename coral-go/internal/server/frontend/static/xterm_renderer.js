/* xterm.js terminal renderer — streams raw ANSI output via WebSocket */

import { state } from './state.js';
import { dbg, escapeHtml, openExternalUrl, renderMarkdown, showToast } from './utils.js';
import { LOCAL_PREVIEW_EXT_PATTERN, extractLocalPreviewLinks, openLocalFilePreview } from './changed_files.js';

let terminal = null;
let fitAddon = null;
let terminalWs = null;
let _selectionDisposable = null;
let _fileLinkProviderDisposable = null;
let _onDataDisposable = null;
let _onResizeDisposable = null;
let _onRenderDisposable = null;
let _onScrollDisposable = null;
let _resizeObserver = null;
let _terminalFocused = false;
let _submittedCommandDecorations = [];
let _fallbackSubmittedMarkerTimer = null;
let _submittedCommandRenderTimer = null;
let _submittedCommandRenderNeedsSearch = false;
let _operatorInputBuffer = "";
let _operatorInputStartAnchor = null;
let _operatorInputStartMarker = null;
let _markdownAssistTimer = null;
let _markdownAssistState = null;

const SUBMITTED_COMMAND_STORAGE_KEY = "coral.submittedCommands.v1";
const SUBMITTED_COMMAND_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_SUBMITTED_COMMANDS_PER_SESSION = 80;
const MAX_RESTORED_COMMAND_DECORATIONS = 10;
const MAX_STORED_COMMAND_CHARS = 12000;
const TERMINAL_REPLAY_CHUNK_BYTES = 12 * 1024;
const MARKDOWN_TABLE_SCAN_MARGIN = 10;
const SUBMITTED_COMMAND_VALIDATION_DELAYS = [90, 220, 420, 760, 1250, 2100, 3600];

// Input queue: buffers keystrokes while WebSocket is disconnected
let _inputQueue = [];
const MAX_INPUT_QUEUE = 256;

function _getXtermTheme() {
    // Read xterm colors from CSS custom properties (set by theme configurator or variables.css)
    const s = getComputedStyle(document.documentElement);
    const v = (name) => s.getPropertyValue(name).trim();
    return {
        background:          v('--xterm-background')           || '#0d1117',
        foreground:          v('--xterm-foreground')           || '#e6edf3',
        cursor:              v('--xterm-cursor')               || '#e6edf3',
        selectionBackground: v('--xterm-selection-background') || '#264f78',
        black:               v('--xterm-black')                || '#484f58',
        red:                 v('--xterm-red')                  || '#f85149',
        green:               v('--xterm-green')                || '#3fb950',
        yellow:              v('--xterm-yellow')               || '#d29922',
        blue:                v('--xterm-blue')                 || '#58a6ff',
        magenta:             v('--xterm-magenta')              || '#bc8cff',
        cyan:                v('--xterm-cyan')                 || '#39d2c0',
        white:               v('--xterm-white')                || '#e6edf3',
        brightBlack:         v('--xterm-bright-black')         || '#6e7681',
        brightRed:           v('--xterm-bright-red')           || '#ffa198',
        brightGreen:         v('--xterm-bright-green')         || '#56d364',
        brightYellow:        v('--xterm-bright-yellow')        || '#e3b341',
        brightBlue:          v('--xterm-bright-blue')          || '#79c0ff',
        brightMagenta:       v('--xterm-bright-magenta')       || '#d2a8ff',
        brightCyan:          v('--xterm-bright-cyan')          || '#56d4dd',
        brightWhite:         v('--xterm-bright-white')         || '#f0f6fc',
    };
}

function _isTerminalContainerMeasurable(container) {
    if (!container || !container.isConnected) return false;
    if (container.offsetWidth < 40 || container.offsetHeight < 40) return false;
    const style = window.getComputedStyle(container);
    return style.display !== "none" && style.visibility !== "hidden";
}

function _fitTerminalSafely(reason = "fit") {
    const container = _getXtermContainer();
    if (!terminal || !fitAddon || !_isTerminalContainerMeasurable(container)) return false;

    try {
        fitAddon.fit();
        return true;
    } catch (err) {
        dbg("terminal fit failed", reason, err);
        return false;
    }
}

/** Update the live terminal theme (called when user switches theme). */
export function updateTerminalTheme() {
    if (terminal) {
        terminal.options.theme = _getXtermTheme();
    }
}

// Track which session_id the terminal WS is currently connected to,
// and a generation counter to suppress stale onclose reconnects.
let _connectedSessionId = null;
let _wsGeneration = 0;
let _paneClosed = false;  // true when server reports pane is gone
let _restarting = false;  // true when a restart is in progress
let _needsScrollToBottom = false;  // set on connect, cleared after settling
let _scrollSettleTimer = null;
let _pendingTerminalReplay = false;
let _terminalReplayStatusTimer = null;

export function setRestarting(value) {
    _restarting = value;
    if (value) {
        // Show restarting overlay immediately
        _setSessionEndedOverlay(true);
    }
}

function _setSessionEndedOverlay(visible) {
    const overlay = document.getElementById("session-ended-overlay");
    if (!overlay) return;

    if (visible && !_restarting) {
        // Before showing "Session ended", check if we can reach the server.
        // If we can't, show "Lost connection" instead of "Restart Agent".
        fetch("/api/sessions", { method: "GET", signal: AbortSignal.timeout(3000) })
            .then(() => {
                overlay.style.display = "";
                const defaultContent = document.getElementById("session-ended-default");
                const lostConn = document.getElementById("session-lost-connection");
                if (defaultContent) defaultContent.style.display = "";
                if (lostConn) lostConn.style.display = "none";
            })
            .catch(() => {
                overlay.style.display = "";
                const defaultContent = document.getElementById("session-ended-default");
                const lostConn = document.getElementById("session-lost-connection");
                if (defaultContent) defaultContent.style.display = "none";
                if (lostConn) lostConn.style.display = "";
            });
    } else if (visible && _restarting) {
        overlay.style.display = "";
        const defaultContent = document.getElementById("session-ended-default");
        const restartingContent = document.getElementById("session-restarting");
        const lostConn = document.getElementById("session-lost-connection");
        if (defaultContent) defaultContent.style.display = "none";
        if (restartingContent) restartingContent.style.display = "";
        if (lostConn) lostConn.style.display = "none";
    } else {
        overlay.style.display = "none";
    }
}

function _setDisconnectedBadge(visible) {
    const badge = document.getElementById("xterm-disconnected-badge");
    if (badge) {
        badge.style.display = visible ? "" : "none";
    }
}

function _setTerminalReplayStatus(visible, text = "Restoring terminal scrollback...") {
    const container = _getXtermContainer();
    if (!container) return;

    let badge = container.querySelector(".xterm-replay-status");
    if (!badge && visible) {
        badge = document.createElement("div");
        badge.className = "xterm-replay-status";
        container.appendChild(badge);
    }
    if (!badge) return;

    badge.textContent = text;
    badge.classList.toggle("is-visible", visible);
}

function _beginTerminalReplayWait() {
    clearTimeout(_terminalReplayStatusTimer);
    _terminalReplayStatusTimer = setTimeout(() => {
        if (_pendingTerminalReplay) {
            _setTerminalReplayStatus(true, "Restoring terminal scrollback...");
        }
    }, 140);
}

function _finishTerminalReplayWait() {
    clearTimeout(_terminalReplayStatusTimer);
    _terminalReplayStatusTimer = null;
    _pendingTerminalReplay = false;
    _setTerminalReplayStatus(false);
}

function _refreshTerminalViewport() {
    if (!terminal) return;
    requestAnimationFrame(() => {
        if (!terminal) return;
        try {
            _fitTerminalSafely("refresh");
            terminal.refresh(0, Math.max(0, terminal.rows - 1));
            if (_needsScrollToBottom) terminal.scrollToBottom();
        } catch (err) {
            dbg("terminal viewport refresh failed", err);
        }
    });
}

function _writeTerminalData(data, onSettled, options = {}) {
    if (!terminal) return;

    let settled = false;
    const shouldContinue = typeof options.shouldContinue === "function"
        ? options.shouldContinue
        : () => true;
    const finish = (completed = true) => {
        if (settled) return;
        settled = true;
        onSettled?.(completed);
    };

    const bytes = data instanceof Uint8Array
        ? data
        : (data instanceof ArrayBuffer ? new Uint8Array(data) : null);
    if (options.chunked && bytes && bytes.byteLength > TERMINAL_REPLAY_CHUNK_BYTES) {
        _writeTerminalDataInChunks(bytes, finish, shouldContinue);
        return;
    }

    try {
        if (!shouldContinue()) {
            finish(false);
            return;
        }
        terminal.write(data, () => {
            finish(shouldContinue());
        });
    } catch (err) {
        terminal.write(data);
        finish(shouldContinue());
    }

    // Older xterm builds may ignore the callback argument.
    setTimeout(() => finish(shouldContinue()), 80);
}

function _writeTerminalDataInChunks(bytes, finish, shouldContinue) {
    let offset = 0;

    const writeNextChunk = () => {
        if (!terminal || !shouldContinue()) {
            finish(false);
            return;
        }
        if (offset >= bytes.byteLength) {
            finish(true);
            return;
        }

        const end = Math.min(offset + TERMINAL_REPLAY_CHUNK_BYTES, bytes.byteLength);
        const chunk = bytes.subarray(offset, end);
        offset = end;

        let chunkSettled = false;
        const afterChunk = () => {
            if (chunkSettled) return;
            chunkSettled = true;
            if (offset >= bytes.byteLength) {
                finish(shouldContinue());
            } else {
                requestAnimationFrame(writeNextChunk);
            }
        };

        try {
            terminal.write(chunk, afterChunk);
        } catch (err) {
            terminal.write(chunk);
            afterChunk();
        }

        // Older xterm builds may ignore the callback argument.
        setTimeout(afterChunk, 80);
    };

    writeNextChunk();
}

/** Reuse the existing terminal if possible.
 *  Destroying and recreating the xterm canvas causes blank renders in macOS
 *  WebKit webview (webview_go). Keep the old buffer visible until the next
 *  session replay arrives so switching chats never looks like history was lost. */
export function createTerminal(containerEl) {
    dbg('createTerminal called, existing terminal:', !!terminal);

    if (typeof Terminal === 'undefined') {
        console.warn('xterm.js not loaded, falling back to semantic renderer');
        return null;
    }

    // Reuse existing terminal. Do not clear immediately; connectTerminalWs()
    // resets the buffer only after the new session's first frame arrives.
    if (terminal) {
        disconnectTerminalWs();
        dbg('createTerminal: reusing existing terminal, preserving buffer until replay');
        requestAnimationFrame(() => _fitTerminalSafely("reuse"));
        return terminal;
    }

    const scrollback = parseInt((state.settings || {}).terminal_scrollback, 10) || 20000;
    const fontSize = parseInt((state.settings || {}).terminal_font_size, 10) || 13;
    terminal = new Terminal({
        allowProposedApi: true,
        cursorBlink: true,
        cursorStyle: 'block',
        disableStdin: false,
        scrollback: scrollback,
        fontSize: fontSize,
        fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
        theme: _getXtermTheme(),
    });

    fitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);

    if (typeof WebLinksAddon !== 'undefined') {
        const webLinksAddon = new WebLinksAddon.WebLinksAddon((_event, uri) => {
            openExternalUrl(uri);
        });
        terminal.loadAddon(webLinksAddon);
    }
    _registerLocalFileLinkProvider();

    _selectionDisposable = terminal.onSelectionChange(() => {
        state.isSelecting = terminal.hasSelection();
    });

    // Forward all keyboard input via xterm.js onData → WebSocket → tmux.
    // Keystrokes are batched over a short window (12ms) so rapid typing
    // produces fewer WebSocket messages and tmux subprocess calls.
    let _inputBuf = "";
    let _inputTimer = null;
    const INPUT_BATCH_MS = 12;

    function _flushInput() {
        _inputTimer = null;
        const batch = _inputBuf;
        _inputBuf = "";
        if (!batch) return;

        if (terminalWs && terminalWs.readyState === WebSocket.OPEN) {
            terminalWs.send(JSON.stringify({
                type: "terminal_input",
                data: batch,
            }));
        } else {
            // Queue input for delivery when WebSocket reconnects
            if (_inputQueue.length < MAX_INPUT_QUEUE) {
                _inputQueue.push(batch);
            }
        }
    }

    _onDataDisposable = terminal.onData((data) => {
        if (!state.currentSession || state.currentSession.type !== "live") return;
        _trackOperatorTerminalInput(data);

        // Control chars / escape sequences flush immediately (no batching delay)
        const isControl = data.length === 1 && data.charCodeAt(0) < 32;
        const isEscSeq = data.startsWith("\x1b");
        if (isControl || isEscSeq) {
            // Flush any pending literal text first, then send the control
            if (_inputBuf) {
                clearTimeout(_inputTimer);
                _flushInput();
            }
            _inputBuf = data;
            _flushInput();
            return;
        }

        // Literal text: accumulate and debounce
        _inputBuf += data;
        if (!_inputTimer) {
            _inputTimer = setTimeout(_flushInput, INPUT_BATCH_MS);
        }
    });

    // Escape hatch: Ctrl+Shift+Escape unfocuses terminal
    // (attachCustomKeyEventHandler can be called before open)
    terminal.attachCustomKeyEventHandler((ev) => {
        if (ev.type === 'keydown' && ev.key === 'Escape' && ev.ctrlKey && ev.shiftKey) {
            terminal.blur();
            return false;
        }
        return true;
    });

    terminal.open(containerEl);
    _onRenderDisposable = typeof terminal.onRender === "function"
        ? terminal.onRender(() => {
            _queueSubmittedCommandOverlayRender({ delay: 48, allowSearch: false });
            _queueMarkdownAssistScan(220);
        })
        : null;
    _onScrollDisposable = typeof terminal.onScroll === "function"
        ? terminal.onScroll(() => {
            _queueSubmittedCommandOverlayRender({ delay: 64, allowSearch: false });
            _queueMarkdownAssistScan(160);
        })
        : null;
    dbg('terminal.open() done, container:', containerEl.offsetWidth, 'x', containerEl.offsetHeight,
        'display:', containerEl.style.display, 'cols:', terminal.cols, 'rows:', terminal.rows);

    // Defer fit() to allow the layout engine to settle. In macOS WebKit
    // webview (used by coral-app), synchronous fit() right after open()
    // computes 0 cols/rows because the container hasn't been laid out yet.
    // Using rAF + a small fallback timeout ensures the terminal gets sized
    // correctly in both browsers and embedded webviews.
    requestAnimationFrame(() => {
        if (_fitTerminalSafely("open")) {
            dbg('rAF fit() done, cols:', terminal?.cols, 'rows:', terminal?.rows,
                'container:', containerEl.offsetWidth, 'x', containerEl.offsetHeight);
        }
    });

    // ResizeObserver catches layout changes that rAF misses (e.g. when the
    // container transitions from display:none to flex, or sidebar resizes).
    if (typeof ResizeObserver !== 'undefined') {
        if (_resizeObserver) _resizeObserver.disconnect();
        _resizeObserver = new ResizeObserver(() => {
            _fitTerminalSafely("resize-observer");
        });
        _resizeObserver.observe(containerEl);
    }

    // Focus management: track terminal focus state
    // (terminal.textarea is only available after open())
    if (terminal.textarea) {
        terminal.textarea.addEventListener('focus', () => {
            _terminalFocused = true;
            containerEl.classList.add('xterm-focused');
        });
        terminal.textarea.addEventListener('blur', () => {
            _terminalFocused = false;
            containerEl.classList.remove('xterm-focused');
        });
    }

    // Sync tmux pane dimensions when xterm resizes (e.g. after fitAddon.fit())
    _onResizeDisposable = terminal.onResize(({ cols, rows }) => {
        if (cols >= 10 && rows >= 5 && terminalWs && terminalWs.readyState === WebSocket.OPEN) {
            terminalWs.send(JSON.stringify({
                type: "terminal_resize",
                cols: cols,
                rows: rows,
            }));
        }
    });

    return terminal;
}

function _registerLocalFileLinkProvider() {
    if (!terminal || typeof terminal.registerLinkProvider !== 'function' || _fileLinkProviderDisposable) return;

    _fileLinkProviderDisposable = terminal.registerLinkProvider({
        provideLinks(bufferLineNumber, callback) {
            callback(_computeLocalFileLinks(bufferLineNumber));
        },
    });
}

function _computeLocalFileLinks(bufferLineNumber) {
    if (!terminal?.buffer?.active) return [];

    const { text, firstLineIndex } = _getWindowedTerminalLine(bufferLineNumber - 1);
    const matches = extractLocalPreviewLinks(text);
    if (matches.length === 0) {
        return _computeHardSplitLocalFileLinks(bufferLineNumber - 1);
    }

    const links = [];
    for (const match of matches) {
        const start = _mapStringIndexToBufferCell(firstLineIndex, 0, match.start);
        const end = _mapStringIndexToBufferCell(start.lineIndex, start.cellIndex, match.end - match.start);
        if (!start.valid || !end.valid) continue;
        links.push({
            text: match.filepath,
            range: {
                start: { x: start.cellIndex + 1, y: start.lineIndex + 1 },
                end: { x: end.cellIndex, y: end.lineIndex + 1 },
            },
            activate: () => openLocalFilePreview(match.filepath),
        });
    }
    return links;
}

function _computeHardSplitLocalFileLinks(lineIndex) {
    const buffer = terminal?.buffer?.active;
    if (!buffer) return [];

    const direct = _buildHardSplitLocalFileLink(lineIndex, lineIndex + 1)
        || _buildHardSplitLocalFileLink(lineIndex - 1, lineIndex);
    return direct ? [direct] : [];
}

function _buildHardSplitLocalFileLink(prefixLineIndex, filenameLineIndex) {
    const buffer = terminal?.buffer?.active;
    if (!buffer || prefixLineIndex < 0 || filenameLineIndex < 0) return null;

    const filenameLine = buffer.getLine(filenameLineIndex)?.translateToString(true) || "";
    const filenameMatch = filenameLine.match(new RegExp(`^(\\s*)([^\\s"'<>]+?\\.(?:${LOCAL_PREVIEW_EXT_PATTERN}))(?=$|[\\s),.;:\\]\\}])`, "i"));
    if (!filenameMatch) return null;

    const filenameIndent = filenameMatch[1] || "";
    const filenamePart = filenameMatch[2] || "";
    const prefixes = [];
    let startLineIndex = prefixLineIndex;
    let startCellIndex = 0;

    for (let i = prefixLineIndex; i >= Math.max(0, prefixLineIndex - 3); i--) {
        const value = buffer.getLine(i)?.translateToString(true) || "";
        const prefix = _extractTrailingPathPrefix(value);
        if (!prefix) break;
        prefixes.unshift(prefix.text);
        startLineIndex = i;
        startCellIndex = prefix.start;
    }

    if (prefixes.length === 0) return null;

    const filepath = `${prefixes.join("")}${filenamePart}`;
    if (!extractLocalPreviewLinks(` ${filepath} `).some(link => link.filepath === filepath)) return null;

    return {
        text: filepath,
        range: {
            start: { x: startCellIndex + 1, y: startLineIndex + 1 },
            end: { x: filenameIndent.length + filenamePart.length, y: filenameLineIndex + 1 },
        },
        activate: () => openLocalFilePreview(filepath),
    };
}

function _extractTrailingPathPrefix(lineText) {
    const trimmedRight = String(lineText || "").trimEnd();
    if (!trimmedRight.endsWith("/")) return null;

    const match = trimmedRight.match(/(^|[\s([{"'`])((?:~\/|\/|\.{1,2}\/|[A-Za-z0-9_.-]+\/)[^\s"'<>]*\/)$/i);
    if (!match) return null;

    const prefix = match[1] || "";
    const text = match[2] || "";
    if (!text || text.includes("://")) return null;
    return { text, start: match.index + prefix.length };
}

function _getWindowedTerminalLine(lineIndex) {
    const buffer = terminal.buffer.active;
    const lines = [];
    let firstLineIndex = lineIndex;
    let line = buffer.getLine(lineIndex);
    let collected = 0;

    if (!line) return { text: '', firstLineIndex };

    if (line.isWrapped && line.translateToString(true)[0] !== ' ') {
        let probeIndex = lineIndex;
        let probeLine;
        const previous = [];
        while ((probeLine = buffer.getLine(--probeIndex)) && collected < 2048) {
            const value = probeLine.translateToString(true);
            collected += value.length;
            previous.push(value);
            firstLineIndex = probeIndex;
            if (!probeLine.isWrapped || value.includes(' ')) break;
        }
        previous.reverse();
        lines.push(...previous);
    }

    lines.push(line.translateToString(true));

    collected = 0;
    let nextIndex = lineIndex;
    let nextLine;
    while ((nextLine = buffer.getLine(++nextIndex)) && nextLine.isWrapped && collected < 2048) {
        const value = nextLine.translateToString(true);
        collected += value.length;
        lines.push(value);
        if (value.includes(' ')) break;
    }

    return { text: lines.join(''), firstLineIndex };
}

function _mapStringIndexToBufferCell(lineIndex, cellIndex, remainingChars) {
    const buffer = terminal.buffer.active;
    const cell = buffer.getNullCell();
    let col = cellIndex;

    while (remainingChars > 0) {
        const line = buffer.getLine(lineIndex);
        if (!line) return { valid: false, lineIndex: -1, cellIndex: -1 };

        for (let i = col; i < line.length; i++) {
            line.getCell(i, cell);
            const chars = cell.getChars();
            if (cell.getWidth()) {
                remainingChars -= chars.length || 1;
                if (i === line.length - 1 && chars === '') {
                    const nextLine = buffer.getLine(lineIndex + 1);
                    if (nextLine && nextLine.isWrapped) {
                        nextLine.getCell(0, cell);
                        if (cell.getWidth() === 2) remainingChars += 1;
                    }
                }
            }
            if (remainingChars < 0) return { valid: true, lineIndex, cellIndex: i };
        }
        lineIndex++;
        col = 0;
    }

    return { valid: true, lineIndex, cellIndex: col };
}

export function connectTerminalWs(name, agentType, sessionId) {
    dbg('connectTerminalWs', { name, agentType, sessionId, currentConnected: _connectedSessionId });

    // Skip if already connected to this exact session
    if (_connectedSessionId === sessionId && terminalWs && terminalWs.readyState === WebSocket.OPEN) {
        dbg('connectTerminalWs: already connected, skipping');
        return;
    }

    disconnectTerminalWs();

    // Bump generation so any pending onclose from the old WS is suppressed
    const myGeneration = ++_wsGeneration;
    _connectedSessionId = sessionId;
    _paneClosed = false;
    _needsScrollToBottom = true;
    _pendingTerminalReplay = true;
    _setSessionEndedOverlay(false);
    _beginTerminalReplayWait();

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams();
    if (agentType) params.set("agent_type", agentType);
    if (sessionId) params.set("session_id", sessionId);
    _fitTerminalSafely("connect");
    if (terminal?.cols >= 10 && terminal?.rows >= 5) {
        params.set("cols", String(terminal.cols));
        params.set("rows", String(terminal.rows));
    }
    const qs = params.toString() ? `?${params}` : "";

    terminalWs = new WebSocket(
        `${proto}//${location.host}/ws/terminal/${encodeURIComponent(name)}${qs}`
    );
    terminalWs.binaryType = 'arraybuffer';

    terminalWs.onopen = () => {
        dbg('terminalWs OPEN', { sessionId, url: terminalWs.url });
        _setDisconnectedBadge(false);
        _fitTerminalSafely("ws-open");
        if (terminal?.cols >= 10 && terminal?.rows >= 5) {
            terminalWs.send(JSON.stringify({
                type: 'terminal_resize',
                cols: terminal.cols,
                rows: terminal.rows,
            }));
        }
        // Flush any input queued while disconnected
        if (_inputQueue.length > 0) {
            const queued = _inputQueue.join("");
            _inputQueue = [];
            terminalWs.send(JSON.stringify({
                type: "terminal_input",
                data: queued,
            }));
        }
    };

    let _msgCount = 0;
    terminalWs.onmessage = (event) => {
        if (myGeneration !== _wsGeneration) return;
        if (sessionId && state.currentSession?.session_id !== sessionId) return;

        _msgCount++;

        if (event.data instanceof ArrayBuffer) {
            if (_msgCount <= 3 || _msgCount % 50 === 0) {
                dbg('terminalWs msg #' + _msgCount, { type: 'binary', hasTerminal: !!terminal,
                    byteLen: event.data.byteLength,
                    cols: terminal?.cols, rows: terminal?.rows });
            }
            if (terminal) {
                _paneClosed = false;
                _restarting = false;
                _setSessionEndedOverlay(false);
                const wasReplaySeed = _pendingTerminalReplay;
                if (wasReplaySeed) {
                    terminal.clear();
                    terminal.reset();
                    _clearSubmittedCommandDecorations();
                    _hideMarkdownAssist();
                }
                _writeTerminalData(new Uint8Array(event.data), (completed) => {
                    if (!completed || myGeneration !== _wsGeneration || state.currentSession?.session_id !== sessionId) {
                        return;
                    }
                    if (wasReplaySeed) {
                        _finishTerminalReplayWait();
                        _restoreSubmittedCommandDecorations();
                    } else {
                        _queueSubmittedCommandOverlayRender();
                    }
                    _refreshTerminalViewport();
                    _queueMarkdownAssistScan(wasReplaySeed ? 260 : 180);
                    if (_needsScrollToBottom) {
                        terminal.scrollToBottom();
                        // Keep scrolling to bottom for 500ms after connect
                        // to cover replay seed + any follow-up chunks
                        clearTimeout(_scrollSettleTimer);
                        _scrollSettleTimer = setTimeout(() => {
                            _needsScrollToBottom = false;
                        }, 500);
                    }
                }, {
                    chunked: wasReplaySeed,
                    shouldContinue: () => myGeneration === _wsGeneration
                        && state.currentSession?.session_id === sessionId,
                });
            }
            return;
        }

        const data = JSON.parse(event.data);
        if (_msgCount <= 3 || _msgCount % 50 === 0) {
            dbg('terminalWs msg #' + _msgCount, { type: data.type, hasTerminal: !!terminal,
                cols: terminal?.cols, rows: terminal?.rows });
        }
        if (data.type === "terminal_closed") {
            _paneClosed = true;
            _finishTerminalReplayWait();
            _setDisconnectedBadge(false);
            _setSessionEndedOverlay(true);
        }
    };

    terminalWs.onclose = (ev) => {
        dbg('terminalWs CLOSE', { code: ev.code, reason: ev.reason, sessionId, generation: myGeneration, current: _wsGeneration, paneClosed: _paneClosed });
        // Don't reconnect if the server told us the pane is gone.
        if (_paneClosed) return;

        // Only reconnect if this WS is still the current generation.
        // If disconnectTerminalWs() was called (intentional close) or
        // connectTerminalWs() was called for a different session, the
        // generation will have been bumped and we should NOT reconnect.
        if (myGeneration !== _wsGeneration) return;

        if (state.currentSession && state.currentSession.type === "live"
            && state.currentSession.session_id === sessionId) {
            _setDisconnectedBadge(true);
            setTimeout(() => {
                // Re-check: generation still current AND session still matches
                if (myGeneration === _wsGeneration
                    && state.currentSession
                    && state.currentSession.session_id === sessionId) {
                    connectTerminalWs(
                        state.currentSession.name,
                        state.currentSession.agent_type,
                        state.currentSession.session_id,
                    );
                }
            }, 3000);
        }
    };
}

export function disconnectTerminalWs() {
    dbg('disconnectTerminalWs', { hadWs: !!terminalWs, connectedSession: _connectedSessionId });
    // Bump generation BEFORE closing so the old onclose handler is suppressed
    _wsGeneration++;
    _connectedSessionId = null;
    _inputQueue = [];
    _finishTerminalReplayWait();
    _setDisconnectedBadge(false);
    if (terminalWs) {
        terminalWs.close();
        terminalWs = null;
    }
}

export function showSleepingTerminalState() {
    disconnectTerminalWs();
    _paneClosed = true;
    _restarting = false;
    _needsScrollToBottom = false;
    _pendingTerminalReplay = false;
    _finishTerminalReplayWait();
    _setDisconnectedBadge(false);
    _setSessionEndedOverlay(false);
    _clearSubmittedCommandDecorations();
    _hideMarkdownAssist();
    if (terminal) {
        terminal.clear();
        terminal.reset();
    }
}

export function disposeTerminal() {
    dbg('disposeTerminal', { hadTerminal: !!terminal });
    disconnectTerminalWs();
    if (_selectionDisposable) {
        _selectionDisposable.dispose();
        _selectionDisposable = null;
    }
    if (_fileLinkProviderDisposable) {
        _fileLinkProviderDisposable.dispose();
        _fileLinkProviderDisposable = null;
    }
    if (_onDataDisposable) {
        _onDataDisposable.dispose();
        _onDataDisposable = null;
    }
    if (_onResizeDisposable) {
        _onResizeDisposable.dispose();
        _onResizeDisposable = null;
    }
    if (_onRenderDisposable) {
        _onRenderDisposable.dispose();
        _onRenderDisposable = null;
    }
    if (_onScrollDisposable) {
        _onScrollDisposable.dispose();
        _onScrollDisposable = null;
    }
    _terminalFocused = false;
    _inputQueue = [];
    _operatorInputBuffer = "";
    _operatorInputStartAnchor = null;
    _disposeOperatorInputStartMarker();
    _finishTerminalReplayWait();
    _clearSubmittedCommandDecorations();
    if (_resizeObserver) {
        _resizeObserver.disconnect();
        _resizeObserver = null;
    }
    if (terminal) {
        terminal.dispose();
        terminal = null;
        fitAddon = null;
    }
}

export function fitTerminal() {
    _fitTerminalSafely("external");
}

export function getTerminalCols() {
    return terminal ? terminal.cols : null;
}

export function getTerminal() {
    return terminal;
}

export function isTerminalFocused() {
    return _terminalFocused;
}

export function focusTerminal() {
    if (terminal) {
        terminal.focus();
    }
}

export function markCommandSubmitted(command) {
    return _markCommandSubmitted(command, null);
}

function _markCommandSubmitted(command, startAnchor = null, startMarker = null) {
    const label = "YOU SENT";
    const container = _getXtermContainer();
    _rememberSubmittedCommandForSession(command);
    if (!terminal || !container) {
        _showFallbackSubmittedMarker(label);
        return;
    }

    const anchor = startAnchor || _getCurrentTerminalCursorAnchor();
    const marker = startMarker || _createCurrentTerminalMarker();
    const entry = {
        command: String(command || ""),
        normalized: _normalizeTerminalSearchText(command),
        compact: _compactTerminalSearchText(command),
        label,
        lineCount: _estimateSubmittedCommandHeight(command, anchor?.column),
        needles: _buildSubmittedCommandNeedles(command),
        startRange: _getSubmittedCommandStartRange(command, anchor),
        startMarker: marker,
        decoration: null,
        bufferRange: null,
        scanAttempted: false,
        freshHighlight: true,
        hasBeenVisible: false,
        element: null,
        retryTimers: [],
    };
    entry.decoration = _createSubmittedCommandDecoration(entry);
    if (!entry.decoration) {
        entry.element = _createSubmittedCommandOverlay(entry);
        container.appendChild(entry.element);
    }

    _submittedCommandDecorations.push(entry);
    while (_submittedCommandDecorations.length > 60) {
        _disposeSubmittedCommandDecoration(_submittedCommandDecorations.shift());
    }

    if (entry.decoration) {
        terminal?.refresh?.(0, Math.max(0, (terminal.rows || 1) - 1));
        _scheduleSubmittedCommandDecorationValidation(entry);
    } else {
        _renderSubmittedCommandOverlay(entry, { allowSearch: true });
        _scheduleSubmittedCommandOverlayRenders(entry);
    }
}

function _restoreSubmittedCommandDecorations() {
    if (!terminal) return;

    const container = _getXtermContainer();
    const records = _loadSubmittedCommandsForCurrentSession();
    if (!container) return;
    if (records.length === 0) {
        _clearSubmittedCommandDecorations();
        return;
    }

    _clearSubmittedCommandDecorations();
    for (const record of records.slice(0, MAX_RESTORED_COMMAND_DECORATIONS).reverse()) {
        const entry = {
            command: String(record.command || ""),
            normalized: _normalizeTerminalSearchText(record.command),
            compact: _compactTerminalSearchText(record.command),
            label: "YOU SENT",
            lineCount: _estimateSubmittedCommandHeight(record.command),
            needles: _buildSubmittedCommandNeedles(record.command),
            startRange: null,
            startMarker: null,
            decoration: null,
            bufferRange: null,
            scanAttempted: false,
            freshHighlight: false,
            hasBeenVisible: false,
            element: null,
            retryTimers: [],
        };
        if (!entry.normalized) continue;
        entry.element = _createSubmittedCommandOverlay(entry);
        container.appendChild(entry.element);
        _submittedCommandDecorations.push(entry);
    }

    while (_submittedCommandDecorations.length > MAX_SUBMITTED_COMMANDS_PER_SESSION) {
        _disposeSubmittedCommandDecoration(_submittedCommandDecorations.shift());
    }
    _scheduleSubmittedCommandOverlayBatchRender();
}

function _disposeSubmittedCommandDecoration(entry) {
    if (!entry) return;
    for (const timer of entry.retryTimers || []) clearTimeout(timer);
    entry.retryTimers = [];
    entry.decoration?.dispose?.();
    entry.decoration = null;
    entry.startMarker?.dispose?.();
    entry.startMarker = null;
    entry.element?.remove?.();
    entry.element = null;
}

function _clearSubmittedCommandDecorations() {
    clearTimeout(_submittedCommandRenderTimer);
    _submittedCommandRenderTimer = null;
    _submittedCommandRenderNeedsSearch = false;
    for (const entry of _submittedCommandDecorations.splice(0)) {
        _disposeSubmittedCommandDecoration(entry);
    }
    const container = _getXtermContainer();
    container?.querySelectorAll(".xterm-operator-send-marker").forEach(el => el.remove());
}

function _getSubmittedCommandSessionKeys() {
    const session = state.currentSession || {};
    const id = session.session_id || _connectedSessionId || "";
    const agentType = session.agent_type || "agent";
    const keys = [];

    if (id) {
        keys.push(`${agentType}:${id}`, `live:${id}`, `id:${id}`);
    }

    const tmuxName = session.tmux_session || session.name || "";
    if (tmuxName) keys.push(`tmux:${tmuxName}`);
    if (session.name) keys.push(`name:${session.name}`);

    return [...new Set(keys.filter(Boolean))];
}

function _readSubmittedCommandStore() {
    try {
        const raw = window.localStorage?.getItem(SUBMITTED_COMMAND_STORAGE_KEY);
        if (!raw) return { sessions: {} };
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" && parsed.sessions
            ? parsed
            : { sessions: {} };
    } catch (_) {
        return { sessions: {} };
    }
}

function _writeSubmittedCommandStore(store) {
    try {
        window.localStorage?.setItem(SUBMITTED_COMMAND_STORAGE_KEY, JSON.stringify(store));
    } catch (_) {
        // Best effort only: the terminal still works if storage is full/disabled.
    }
}

function _pruneSubmittedCommandStore(store) {
    const now = Date.now();
    const cutoff = now - SUBMITTED_COMMAND_TTL_MS;
    const sessions = store.sessions || {};

    for (const [key, records] of Object.entries(sessions)) {
        const kept = Array.isArray(records)
            ? records
                .filter(record => typeof record?.command === "string" && record.command.trim() && (record.at || 0) >= cutoff)
                .sort((a, b) => (b.at || 0) - (a.at || 0))
                .slice(0, MAX_SUBMITTED_COMMANDS_PER_SESSION)
            : [];
        if (kept.length) {
            sessions[key] = kept;
        } else {
            delete sessions[key];
        }
    }

    store.sessions = sessions;
    return store;
}

function _readSubmittedCommandMemoryStore() {
    const store = { sessions: state.submittedTerminalCommands || {} };
    const pruned = _pruneSubmittedCommandStore(store);
    state.submittedTerminalCommands = pruned.sessions || {};
    return pruned;
}

function _writeSubmittedCommandMemoryStore(store) {
    state.submittedTerminalCommands = (store && store.sessions) || {};
}

function _writeSubmittedCommandEntryToStore(store, sessionKeys, entry, normalized) {
    store.sessions = store.sessions || {};
    for (const sessionKey of sessionKeys) {
        const records = store.sessions[sessionKey] || [];
        store.sessions[sessionKey] = [
            entry,
            ...records.filter(record => _normalizeTerminalSearchText(record.command) !== normalized),
        ].slice(0, MAX_SUBMITTED_COMMANDS_PER_SESSION);
    }
}

function _rememberSubmittedCommandForSession(command) {
    const sessionKeys = _getSubmittedCommandSessionKeys();
    const normalized = _normalizeTerminalSearchText(command);
    if (sessionKeys.length === 0 || !normalized) return;

    const commandText = String(command || "").slice(0, MAX_STORED_COMMAND_CHARS);
    const entry = { command: commandText, at: Date.now() };

    const memoryStore = _readSubmittedCommandMemoryStore();
    _writeSubmittedCommandEntryToStore(memoryStore, sessionKeys, entry, normalized);
    _writeSubmittedCommandMemoryStore(memoryStore);

    const persistentStore = _pruneSubmittedCommandStore(_readSubmittedCommandStore());
    _writeSubmittedCommandEntryToStore(persistentStore, sessionKeys, entry, normalized);
    _writeSubmittedCommandStore(persistentStore);
}

function _loadSubmittedCommandsForCurrentSession() {
    const sessionKeys = _getSubmittedCommandSessionKeys();
    if (sessionKeys.length === 0) return [];

    const memoryStore = _readSubmittedCommandMemoryStore();
    const persistentStore = _pruneSubmittedCommandStore(_readSubmittedCommandStore());
    const byCommand = new Map();
    for (const store of [memoryStore, persistentStore]) {
        for (const sessionKey of sessionKeys) {
            for (const record of store.sessions[sessionKey] || []) {
                const normalized = _normalizeTerminalSearchText(record.command);
                if (!normalized) continue;
                const existing = byCommand.get(normalized);
                if (!existing || (record.at || 0) > (existing.at || 0)) {
                    byCommand.set(normalized, record);
                }
            }
        }
    }
    const records = [...byCommand.values()]
        .sort((a, b) => (b.at || 0) - (a.at || 0))
        .slice(0, MAX_SUBMITTED_COMMANDS_PER_SESSION);
    _writeSubmittedCommandMemoryStore(memoryStore);
    _writeSubmittedCommandStore(persistentStore);
    return records;
}

function _trackOperatorTerminalInput(data) {
    if (!state.currentSession || state.currentSession.type !== "live") return;
    const text = String(data || "");
    if (!text) return;

    const normalizedText = text
        .replace(/\x1b\[200~/g, "")
        .replace(/\x1b\[201~/g, "");

    for (let i = 0; i < normalizedText.length; i++) {
        const ch = normalizedText[i];
        if (ch === "\r" || ch === "\n") {
            const command = _operatorInputBuffer.trim();
            const startAnchor = _operatorInputStartAnchor;
            const startMarker = _operatorInputStartMarker;
            _operatorInputBuffer = "";
            _operatorInputStartAnchor = null;
            _operatorInputStartMarker = null;
            if (command) {
                _markCommandSubmitted(command, startAnchor, startMarker);
            } else {
                startMarker?.dispose?.();
            }
            continue;
        }
        if (ch === "\x7f" || ch === "\b") {
            _operatorInputBuffer = _operatorInputBuffer.slice(0, -1);
            if (!_operatorInputBuffer) {
                _operatorInputStartAnchor = null;
                _disposeOperatorInputStartMarker();
            }
            continue;
        }
        if (ch === "\x03" || ch === "\x15") {
            _operatorInputBuffer = "";
            _operatorInputStartAnchor = null;
            _disposeOperatorInputStartMarker();
            continue;
        }
        if (ch === "\x1b") {
            const remaining = normalizedText.slice(i);
            const csi = remaining.match(/^\x1b\[[0-?]*[ -/]*[@-~]/);
            if (csi) {
                i += csi[0].length - 1;
                continue;
            }
            continue;
        }
        if (ch === "\t" || ch >= " ") {
            if (!_operatorInputBuffer && !_operatorInputStartAnchor) {
                _operatorInputStartAnchor = _getCurrentTerminalCursorAnchor();
                _operatorInputStartMarker = _createCurrentTerminalMarker();
            }
            _operatorInputBuffer += ch;
            if (_operatorInputBuffer.length > MAX_STORED_COMMAND_CHARS) {
                _operatorInputBuffer = _operatorInputBuffer.slice(-MAX_STORED_COMMAND_CHARS);
            }
        }
    }
}

function _estimateSubmittedCommandHeight(command, startColumn = 4) {
    const cols = Math.max(terminal?.cols || 80, 1);
    const safeStartColumn = Math.max(0, Math.min(cols - 1, Number(startColumn) || 0));
    const lines = String(command || "").split(/\r?\n/);
    const wrappedRows = lines.reduce((total, line, index) => {
        const initialColumn = index === 0 ? safeStartColumn : 0;
        return total + Math.max(1, Math.ceil((initialColumn + line.length) / cols));
    }, 0);
    return _clampSubmittedCommandHeight(wrappedRows);
}

function _clampSubmittedCommandHeight(value) {
    return Math.max(1, Math.min(32, Number.isFinite(value) ? Math.ceil(value) : 1));
}

function _getCurrentTerminalCursorAnchor() {
    const buffer = terminal?.buffer?.active;
    if (!buffer) return null;

    const baseY = Number(buffer.baseY || 0);
    const cursorY = Number(buffer.cursorY || 0);
    const cursorX = Number(buffer.cursorX || 0);
    if (!Number.isFinite(baseY) || !Number.isFinite(cursorY) || !Number.isFinite(cursorX)) return null;

    return {
        line: Math.max(0, baseY + cursorY),
        column: Math.max(0, cursorX),
    };
}

function _createCurrentTerminalMarker() {
    if (!terminal || typeof terminal.registerMarker !== "function") return null;
    try {
        return terminal.registerMarker(0) || null;
    } catch (err) {
        console.warn("Failed to register submitted command marker", err);
        return null;
    }
}

function _disposeOperatorInputStartMarker() {
    _operatorInputStartMarker?.dispose?.();
    _operatorInputStartMarker = null;
}

function _getSubmittedCommandStartRange(command, startAnchor) {
    if (!startAnchor || !Number.isFinite(Number(startAnchor.line))) return null;
    const startLine = Math.max(0, Number(startAnchor.line));
    const lineCount = _estimateSubmittedCommandHeight(command, startAnchor.column);
    return {
        startLine,
        endLine: startLine + lineCount - 1,
        source: "input-start",
    };
}

function _normalizeTerminalSearchText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function _compactTerminalSearchText(value) {
    return _normalizeTerminalSearchText(value).replace(/\s+/g, "");
}

function _getXtermContainer() {
    return document.getElementById("xterm-container") || terminal?.element?.parentElement || null;
}

function _queueMarkdownAssistScan(delay = 180) {
    clearTimeout(_markdownAssistTimer);
    _markdownAssistTimer = setTimeout(() => {
        _markdownAssistTimer = null;
        _scanMarkdownAssist();
    }, delay);
}

function _scanMarkdownAssist() {
    const container = _getXtermContainer();
    if (!terminal || !_isTerminalContainerMeasurable(container)) {
        _hideMarkdownAssist();
        return;
    }

    const tables = _findVisibleMarkdownTables();
    _markdownAssistState = tables[0] || null;
    _renderMarkdownAssistChips(tables);
}

export function openMarkdownTableReader() {
    const table = _findVisibleMarkdownTable() || _findLatestMarkdownTable();
    if (!table) {
        showToast("No Markdown table found in this terminal", true);
        return false;
    }
    _markdownAssistState = table;
    _renderMarkdownAssistChips(_findVisibleMarkdownTables());
    _openMarkdownTableReader(table);
    return true;
}

function _hideMarkdownAssist() {
    _markdownAssistState = null;
    const container = _getXtermContainer();
    container?.querySelectorAll(".xterm-markdown-reader-chip").forEach(chip => chip.remove());
}

function _renderMarkdownAssistChips(tables) {
    const container = _getXtermContainer();
    if (!container) return;

    const positioned = _positionMarkdownAssistTables(tables);
    const existing = Array.from(container.querySelectorAll(".xterm-markdown-reader-chip"));
    existing.forEach(chip => chip.remove());

    positioned.forEach(({ table, top }, index) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "xterm-markdown-reader-chip is-localized is-visible";
        chip.style.top = `${top}px`;
        chip.dataset.tableIndex = String(index);
        chip.addEventListener("click", () => {
            _markdownAssistState = table;
            _openMarkdownTableReader(table);
        });
        chip.innerHTML = `
            <span class="material-icons" aria-hidden="true">table_chart</span>
            <strong>View table</strong>
            <small>${escapeHtml(String(table.dataRows))} rows</small>
        `;
        container.appendChild(chip);
    });
}

function _positionMarkdownAssistTables(tables) {
    if (!tables?.length) return [];
    const container = _getXtermContainer();
    const rowsContainer = terminal?.element?.querySelector(".xterm-rows")
        || document.querySelector("#xterm-container .xterm-rows");
    if (!container || !rowsContainer) return [];

    const rows = Array.from(rowsContainer.children).filter(row => row instanceof HTMLElement);
    if (!rows.length) return [];

    const viewportY = terminal?.buffer?.active?.viewportY || 0;
    const containerRect = container.getBoundingClientRect();
    const minTop = 18;
    const maxTop = Math.max(minTop, container.offsetHeight - 52);
    const usedTops = [];

    return tables.map((table) => {
        const visibleStart = Math.max(0, table.startLine - viewportY);
        const visibleEnd = Math.min(rows.length - 1, table.endLine - viewportY);
        const rowIndex = Math.max(0, Math.min(rows.length - 1, visibleStart <= visibleEnd ? visibleStart : table.startLine - viewportY));
        const row = rows[rowIndex];
        if (!row) return null;

        const rowRect = row.getBoundingClientRect();
        let top = rowRect.top - containerRect.top - 6;
        top = Math.max(minTop, Math.min(maxTop, top));
        while (usedTops.some(used => Math.abs(used - top) < 38)) top = Math.min(maxTop, top + 38);
        usedTops.push(top);
        return { table, top };
    }).filter(Boolean);
}

function _openMarkdownTableReader(table = _markdownAssistState) {
    if (!table) {
        showToast("No Markdown table is visible in the terminal", true);
        return;
    }

    const container = _getXtermContainer();
    if (!container) return;

    let overlay = container.querySelector(".xterm-markdown-reader");
    if (!overlay) {
        overlay = document.createElement("div");
        overlay.className = "xterm-markdown-reader";
        container.appendChild(overlay);
    }

    overlay.innerHTML = `
        <section class="xterm-markdown-reader-panel" role="dialog" aria-modal="false" aria-label="Rendered Markdown table">
            <header class="xterm-markdown-reader-header">
                <span>
                    <small>Terminal reader</small>
                    <strong>Markdown table</strong>
                </span>
                <div class="xterm-markdown-reader-actions">
                    <button type="button" class="xterm-markdown-reader-copy">Copy Markdown</button>
                    <button type="button" class="xterm-markdown-reader-close" aria-label="Close table reader">
                        <span class="material-icons" aria-hidden="true">close</span>
                    </button>
                </div>
            </header>
            <div class="xterm-markdown-reader-body markdown-body">
                ${renderMarkdown(table.markdown)}
            </div>
        </section>
    `;

    overlay.querySelector(".xterm-markdown-reader-close")?.addEventListener("click", () => overlay.remove());
    overlay.querySelector(".xterm-markdown-reader-copy")?.addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(table.markdown);
            showToast("Copied table Markdown");
        } catch {
            showToast("Failed to copy table", true);
        }
    });
    overlay.onclick = (event) => {
        if (event.target === overlay) overlay.remove();
    };
}

function _findVisibleMarkdownTable() {
    const tables = _findVisibleMarkdownTables();
    return tables[0] || null;
}

function _findVisibleMarkdownTables() {
    const buffer = terminal?.buffer?.active;
    if (!buffer) return [];

    const viewportY = Number(buffer.viewportY) || 0;
    const rows = Number(terminal?.rows) || 0;
    const lineCount = buffer.length || (buffer.baseY || 0) + rows;
    const start = Math.max(0, viewportY - MARKDOWN_TABLE_SCAN_MARGIN);
    const end = Math.min(lineCount, viewportY + rows + MARKDOWN_TABLE_SCAN_MARGIN);
    return _findMarkdownTablesInRange(start, end).filter(table => (
        table.endLine >= viewportY && table.startLine <= viewportY + rows
    ));
}

function _findLatestMarkdownTable() {
    const buffer = terminal?.buffer?.active;
    if (!buffer) return null;
    const rows = Number(terminal?.rows) || 0;
    const lineCount = buffer.length || (buffer.baseY || 0) + rows;
    const start = Math.max(0, lineCount - 2500);
    return _findMarkdownTablesInRange(start, lineCount).at(-1) || null;
}

function _findMarkdownTablesInRange(start, end) {
    const logicalLines = _getLogicalTerminalLines(start, end);
    const tables = [];
    for (let i = 1; i < logicalLines.length; i += 1) {
        const separator = _normaliseMarkdownTableRow(logicalLines[i].text);
        if (!_isMarkdownTableSeparator(separator)) continue;

        const header = _buildWrappedTableHeader(logicalLines, i);
        if (!_isMarkdownTableRow(header)) continue;

        const expectedCells = _markdownTableCellCount(separator);
        const rowsOut = [header, separator];
        let j = i + 1;
        let tableEndLine = logicalLines[i].lineIndex;
        while (j < logicalLines.length) {
            const built = _buildWrappedTableDataRow(logicalLines, j, expectedCells);
            const row = _normaliseMarkdownTableRow(built.text);
            if (!_isMarkdownTableRow(row) || _isMarkdownTableSeparator(row)) break;
            rowsOut.push(row);
            tableEndLine = built.endLine ?? logicalLines[j].lineIndex;
            j = Math.max(j + 1, built.nextIndex);
        }

        if (rowsOut.length < 3) continue;
        const table = {
            markdown: rowsOut.join("\n"),
            dataRows: rowsOut.length - 2,
            startLine: logicalLines[Math.max(0, i - 1)].lineIndex,
            endLine: tableEndLine,
        };
        tables.push(table);
        i = Math.max(i, j - 1);
    }
    return tables;
}

function _buildWrappedTableHeader(lines, separatorIndex) {
    const parts = [];
    for (let i = separatorIndex - 1; i >= 0 && i >= separatorIndex - 3; i -= 1) {
        const text = String(lines[i]?.text || "").trim();
        if (!text || !text.includes("|") || _isMarkdownTableSeparator(_normaliseMarkdownTableRow(text))) break;
        parts.unshift(text);
        if (text.startsWith("|")) break;
    }
    return _normaliseMarkdownTableRow(parts.join(" "));
}

function _buildWrappedTableDataRow(lines, startIndex, expectedCells = 0) {
    const parts = [];
    let nextIndex = startIndex + 1;
    let endLine = lines[startIndex]?.lineIndex ?? startIndex;
    for (let i = startIndex; i < lines.length && i < startIndex + 6; i += 1) {
        const text = String(lines[i]?.text || "").trim();
        if (!text) break;
        const hasPipe = text.includes("|");
        const startsNextRow = parts.length > 0 && text.startsWith("|") && _isCompleteMarkdownTableRow(_normaliseMarkdownTableRow(parts.join(" ")), expectedCells);
        if (startsNextRow) break;
        if (!hasPipe && parts.length === 0) break;
        if (!hasPipe && _isCompleteMarkdownTableRow(_normaliseMarkdownTableRow(parts.join(" ")), expectedCells)) break;
        parts.push(text);
        nextIndex = i + 1;
        endLine = lines[i]?.lineIndex ?? endLine;
        const row = _normaliseMarkdownTableRow(parts.join(" "));
        if (_isCompleteMarkdownTableRow(row, expectedCells)) break;
    }
    return { text: parts.join(" "), nextIndex, endLine };
}

function _getLogicalTerminalLines(start, end) {
    const buffer = terminal?.buffer?.active;
    const lines = [];
    let current = null;

    for (let i = start; i < end; i += 1) {
        const line = buffer?.getLine(i);
        if (!line) continue;
        const text = line.translateToString(true);
        if (current && line.isWrapped) {
            current.text += text;
            current.lineIndex = i;
        } else {
            if (current) lines.push(current);
            current = { text, lineIndex: i };
        }
    }
    if (current) lines.push(current);
    return lines;
}

function _normaliseMarkdownTableRow(line) {
    let text = String(line || "").trim();
    const firstPipe = text.indexOf("|");
    const lastPipe = text.lastIndexOf("|");
    if (firstPipe < 0 || lastPipe <= firstPipe) return text;
    text = text.slice(firstPipe, lastPipe + 1);
    return text.replace(/\s+/g, " ").trim();
}

function _markdownTableCells(line) {
    const text = String(line || "").trim();
    if (!text.includes("|")) return [];
    const cells = text.split("|").map(cell => cell.trim());
    if (text.startsWith("|")) cells.shift();
    if (text.endsWith("|")) cells.pop();
    return cells;
}

function _markdownTableCellCount(line) {
    return _markdownTableCells(line).length;
}

function _isMarkdownTableRow(line) {
    const text = String(line || "").trim();
    if (!text.includes("|")) return false;
    const cells = _markdownTableCells(text);
    const contentCells = cells.filter(Boolean);
    return contentCells.length >= 2;
}

function _isMarkdownTableSeparator(line) {
    const text = String(line || "").trim();
    if (!text.includes("|")) return false;
    const cells = _markdownTableCells(text).filter(Boolean);
    return cells.length >= 2 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function _isCompleteMarkdownTableRow(line, expectedCells = 0) {
    const text = String(line || "").trim();
    if (!_isMarkdownTableRow(text) || _isMarkdownTableSeparator(text)) return false;
    const cells = _markdownTableCellCount(text);
    if (expectedCells > 0 && cells < expectedCells) return false;
    if (text.startsWith("|") && text.endsWith("|")) return true;
    return expectedCells > 0 && cells >= expectedCells && (text.match(/\|/g) || []).length >= expectedCells;
}

function _buildSubmittedCommandNeedles(command) {
    const normalized = _normalizeTerminalSearchText(command);
    const compact = _compactTerminalSearchText(command);
    const needles = [];
    if (normalized) needles.push({ value: normalized, compact: false, exact: true });
    if (compact.length >= 16) needles.push({ value: compact, compact: true, exact: true });

    const prefixLength = Math.min(normalized.length, normalized.length < 44 ? normalized.length : 44);
    const compactPrefixLength = Math.min(compact.length, compact.length < 28 ? compact.length : 28);
    if (prefixLength >= 16) needles.push({ value: normalized.slice(0, prefixLength), compact: false, exact: false });
    if (compactPrefixLength >= 14) needles.push({ value: compact.slice(0, compactPrefixLength), compact: true, exact: false });

    return needles;
}

function _createSubmittedCommandOverlay(entry) {
    const el = document.createElement("div");
    el.className = "xterm-operator-send-marker";
    el.setAttribute("aria-label", "Submitted by you");
    el.dataset.operatorLabel = entry.label;
    return el;
}

function _createSubmittedCommandDecoration(entry) {
    if (!terminal || typeof terminal.registerDecoration !== "function" || !entry?.startMarker) return null;
    if (entry.startMarker.isDisposed) return null;

    try {
        const decoration = terminal.registerDecoration({
            marker: entry.startMarker,
            x: 0,
            width: Math.max(1, terminal.cols || 1),
            height: Math.max(1, entry.lineCount || 1),
            layer: "top",
        });
        if (!decoration) return null;

        decoration.onRender((el) => {
            if (!el) return;
            entry.element = el;
            el.classList.add("xterm-operator-send-marker", "is-visible", "is-buffer-decoration");
            el.setAttribute("aria-label", "Submitted by you");
            el.dataset.operatorLabel = entry.label;
            if (!entry.hasBeenVisible) {
                entry.hasBeenVisible = true;
                if (entry.freshHighlight) {
                    el.classList.add("is-fresh");
                    entry.retryTimers.push(setTimeout(() => {
                        el.classList.remove("is-fresh");
                    }, 1800));
                }
            }
        });
        return decoration;
    } catch (err) {
        console.warn("Failed to register submitted command decoration", err);
        return null;
    }
}

function _scheduleSubmittedCommandDecorationValidation(entry) {
    for (let i = 0; i < SUBMITTED_COMMAND_VALIDATION_DELAYS.length; i += 1) {
        const delay = SUBMITTED_COMMAND_VALIDATION_DELAYS[i];
        const finalPass = i === SUBMITTED_COMMAND_VALIDATION_DELAYS.length - 1;
        const timer = setTimeout(() => {
            _validateSubmittedCommandDecoration(entry, { finalPass });
        }, delay);
        entry.retryTimers.push(timer);
    }
}

function _getSubmittedCommandMarkerRange(entry) {
    if (!entry?.startMarker || entry.startMarker.isDisposed) return null;
    const startLine = Number(entry.startMarker.line);
    if (!Number.isFinite(startLine) || startLine < 0) return null;
    const lineCount = Math.max(1, entry.lineCount || 1);
    return {
        startLine,
        endLine: startLine + lineCount - 1,
        source: "marker",
    };
}

function _validateSubmittedCommandDecoration(entry, { finalPass = false } = {}) {
    if (!entry || !entry.decoration || !terminal) return false;

    const markerRange = _getSubmittedCommandMarkerRange(entry);
    if (markerRange && _submittedCommandRangeMatches(entry, markerRange)) {
        entry.bufferRange = _expandSubmittedCommandBufferRange(markerRange, entry.lineCount);
        return true;
    }

    const searchedRange = _findSubmittedCommandBufferRange(entry);
    entry.scanAttempted = true;
    if (searchedRange) {
        entry.bufferRange = _expandSubmittedCommandBufferRange(searchedRange, entry.lineCount);
        _convertSubmittedCommandDecorationToOverlay(entry);
        _renderSubmittedCommandOverlay(entry, { allowSearch: true });
        _scheduleSubmittedCommandOverlayRenders(entry);
        return true;
    }

    // A bad decoration is worse than no decoration: it can label model/status
    // rows as user input. After the terminal has settled, remove it and let the
    // normal restore/search path rehydrate the marker when the command is found.
    if (finalPass && markerRange) {
        _convertSubmittedCommandDecorationToOverlay(entry);
        _renderSubmittedCommandOverlay(entry, { allowSearch: true });
        _scheduleSubmittedCommandOverlayRenders(entry);
    }
    return false;
}

function _convertSubmittedCommandDecorationToOverlay(entry) {
    if (!entry) return null;
    const container = _getXtermContainer();

    entry.decoration?.dispose?.();
    entry.decoration = null;
    entry.startMarker?.dispose?.();
    entry.startMarker = null;
    entry.element?.remove?.();
    entry.element = null;

    if (!container) return null;
    entry.element = _createSubmittedCommandOverlay(entry);
    container.appendChild(entry.element);
    return entry.element;
}

function _scheduleSubmittedCommandOverlayRenders(entry) {
    for (const delay of [20, 60, 120, 240, 420, 700, 1100, 1700, 2600, 4000, 6000]) {
        const timer = setTimeout(() => _renderSubmittedCommandOverlay(entry, { allowSearch: true }), delay);
        entry.retryTimers.push(timer);
    }
}

function _scheduleSubmittedCommandOverlayBatchRender() {
    const passes = [
        { delay: 80, allowSearch: true },
        { delay: 260, allowSearch: false },
        { delay: 700, allowSearch: false },
        { delay: 1500, allowSearch: false },
    ];
    for (const pass of passes) {
        setTimeout(() => _queueSubmittedCommandOverlayRender(pass), pass.delay);
    }
}

function _queueSubmittedCommandOverlayRender(options = {}) {
    const delay = typeof options === "number" ? options : (options.delay ?? 32);
    const allowSearch = typeof options === "object" && !!options.allowSearch;
    _submittedCommandRenderNeedsSearch = _submittedCommandRenderNeedsSearch || allowSearch;
    if (_submittedCommandRenderTimer || _submittedCommandDecorations.length === 0) return;
    _submittedCommandRenderTimer = setTimeout(() => {
        _submittedCommandRenderTimer = null;
        const shouldSearch = _submittedCommandRenderNeedsSearch;
        _submittedCommandRenderNeedsSearch = false;
        for (const entry of _submittedCommandDecorations) {
            _renderSubmittedCommandOverlay(entry, { allowSearch: shouldSearch });
        }
    }, delay);
}

function _renderSubmittedCommandOverlay(entry, { allowSearch = false } = {}) {
    if (!entry || !entry.element) return false;
    if (entry.decoration) return true;

    const container = _getXtermContainer();
    const range = _findSubmittedCommandDomRange(entry, { allowSearch });
    if (!container || !range) {
        entry.element.classList.remove("is-visible");
        return false;
    }

    const containerRect = container.getBoundingClientRect();
    const rowsRect = range.rowsContainer.getBoundingClientRect();
    const startRect = range.startRow.getBoundingClientRect();
    const endRect = range.endRow.getBoundingClientRect();
    const left = Math.max(0, rowsRect.left - containerRect.left - 6);
    const right = Math.max(16, containerRect.right - rowsRect.right + 8);
    const top = startRect.top - containerRect.top - 2;
    const height = Math.max(terminal?.options?.lineHeight || 16, endRect.bottom - startRect.top + 4);

    entry.element.style.left = `${left}px`;
    entry.element.style.right = `${right}px`;
    entry.element.style.top = `${top}px`;
    entry.element.style.height = `${height}px`;
    entry.element.classList.add("is-visible");
    if (!entry.hasBeenVisible) {
        entry.hasBeenVisible = true;
        if (entry.freshHighlight) {
            entry.element.classList.add("is-fresh");
            entry.retryTimers.push(setTimeout(() => {
                entry.element?.classList.remove("is-fresh");
            }, 1800));
        }
    }
    return true;
}

function _findSubmittedCommandDomRange(entry, { allowSearch = false } = {}) {
    const rowsContainer = terminal?.element?.querySelector(".xterm-rows")
        || document.querySelector("#xterm-container .xterm-rows");
    if (!rowsContainer || !entry?.needles?.length) return null;

    const rows = Array.from(rowsContainer.children).filter(row => row instanceof HTMLElement);
    const shouldSearchVisibleRows = allowSearch || !entry.bufferRange || entry.hasBeenVisible;
    if (shouldSearchVisibleRows) {
        const visibleRange = _findSubmittedCommandVisibleRowRange(entry, rowsContainer, rows);
        if (visibleRange) return visibleRange;
    }

    const bufferRange = _getSubmittedCommandBufferRange(entry, allowSearch);
    if (bufferRange) {
        const viewportY = terminal?.buffer?.active?.viewportY || 0;
        const startVisibleRow = bufferRange.startLine - viewportY;
        const endVisibleRow = bufferRange.endLine - viewportY;
        if (endVisibleRow < 0 || startVisibleRow >= rows.length) return null;

        const startRow = rows[Math.max(0, startVisibleRow)];
        const endRow = rows[Math.min(rows.length - 1, endVisibleRow)];
        if (startRow && endRow) return { rowsContainer, startRow, endRow };
    }

    return null;
}

function _findSubmittedCommandVisibleRowRange(entry, rowsContainer, rows) {
    if (!rows?.length) return null;
    const maxSampleHeight = Math.max(entry.lineCount + 6, 12);
    const candidates = [];

    for (let start = rows.length - 1; start >= 0; start--) {
        const parts = [];
        for (let i = 0; i < maxSampleHeight && start + i < rows.length; i++) {
            parts.push(rows[start + i].textContent || "");

            const height = i + 1;
            const sample = _normalizeTerminalSearchText(parts.join(" "));
            if (!sample) continue;
            const sampleCompact = _compactTerminalSearchText(sample);
            const match = _findSubmittedCommandNeedleMatch(entry, sample, sampleCompact);
            if (match) {
                const matchOffset = _findSubmittedCommandRowOffset(entry, (offset) => rows[start + offset]?.textContent || "", height);
                const anchorStart = Math.min(rows.length - 1, start + matchOffset);
                const measuredHeight = match.exact
                    ? Math.max(1, height - matchOffset)
                    : Math.max(entry.lineCount, height - matchOffset);
                const end = Math.min(rows.length - 1, anchorStart + measuredHeight - 1);
                const rowRect = rows[anchorStart].getBoundingClientRect();
                candidates.push({
                    rowsContainer,
                    startRow: rows[anchorStart],
                    endRow: rows[end],
                    score:
                        (matchOffset === 0 ? 100000 : 0)
                        + (match.exact ? 10000 : 0)
                        - (matchOffset * 1000)
                        - (measuredHeight * 100)
                        + rowRect.top,
                });
                break;
            }
        }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.score - a.score);
    const { rowsContainer: bestRowsContainer, startRow, endRow } = candidates[0];
    return { rowsContainer: bestRowsContainer, startRow, endRow };
}

function _getSubmittedCommandBufferRange(entry, allowSearch) {
    if (allowSearch) {
        const range = _findSubmittedCommandBufferRange(entry);
        entry.scanAttempted = true;
        if (range) {
            entry.bufferRange = _expandSubmittedCommandBufferRange(range, entry.lineCount);
            return entry.bufferRange;
        }
    }

    if (entry.bufferRange) {
        return _expandSubmittedCommandBufferRange(entry.bufferRange, entry.lineCount);
    }

    if (entry.startRange && _submittedCommandRangeMatches(entry, entry.startRange)) {
        entry.bufferRange = _expandSubmittedCommandBufferRange(entry.startRange, entry.lineCount);
        return entry.bufferRange;
    }

    return null;
}

function _submittedCommandRangeMatches(entry, range) {
    const buffer = terminal?.buffer?.active;
    if (!buffer || !range || !entry?.needles?.length) return false;

    const lineCount = buffer.length || ((buffer.baseY || 0) + (terminal?.rows || 0));
    const startLine = Math.max(0, Math.min(lineCount - 1, range.startLine));
    const endLine = Math.max(startLine, Math.min(lineCount - 1, range.endLine));
    const parts = [];
    for (let i = startLine; i <= endLine; i += 1) {
        parts.push(buffer.getLine(i)?.translateToString(true) || "");
    }
    const sample = _normalizeTerminalSearchText(parts.join(" "));
    if (!sample) return false;
    return !!_findSubmittedCommandNeedleMatch(entry, sample, _compactTerminalSearchText(sample));
}

function _expandSubmittedCommandBufferRange(range, expectedRows = 1) {
    const buffer = terminal?.buffer?.active;
    const lineCount = buffer?.length || ((buffer?.baseY || 0) + (terminal?.rows || 0));
    if (!buffer || !lineCount || !range) return range;

    let startLine = Math.max(0, Math.min(lineCount - 1, range.startLine));
    let endLine = Math.max(startLine, Math.min(lineCount - 1, range.endLine));
    const maxExpansion = Math.max(2, Math.min(32, _clampSubmittedCommandHeight(expectedRows) + 4));

    let expandedUp = 0;
    while (startLine > 0 && expandedUp < maxExpansion) {
        const line = buffer.getLine(startLine);
        if (!line?.isWrapped) break;
        startLine -= 1;
        expandedUp += 1;
    }

    let expandedDown = 0;
    while (endLine + 1 < lineCount && expandedDown < maxExpansion) {
        const nextLine = buffer.getLine(endLine + 1);
        if (!nextLine?.isWrapped) break;
        endLine += 1;
        expandedDown += 1;
    }

    return { ...range, startLine, endLine };
}

function _findSubmittedCommandBufferRange(entry) {
    const buffer = terminal?.buffer?.active;
    const lineCount = buffer?.length || ((buffer?.baseY || 0) + (terminal?.rows || 0));
    if (!buffer || !lineCount || !entry?.needles?.length) return null;

    const maxSampleHeight = Math.max(entry.lineCount + 6, 12);
    const candidates = [];

    for (let start = lineCount - 1; start >= 0; start--) {
        const parts = [];
        for (let i = 0; i < maxSampleHeight && start + i < lineCount; i++) {
            const line = buffer.getLine(start + i);
            if (!line) break;
            parts.push(line.translateToString(true) || "");

            const height = i + 1;
            const sample = _normalizeTerminalSearchText(parts.join(" "));
            if (!sample) continue;
            const sampleCompact = _compactTerminalSearchText(sample);
            const match = _findSubmittedCommandNeedleMatch(entry, sample, sampleCompact);
            if (!match) continue;

            const rowText = _normalizeTerminalSearchText(buffer.getLine(start)?.translateToString(true) || "");
            const rowCompact = _compactTerminalSearchText(rowText);
            const firstRowMatch = !!_findSubmittedCommandNeedleMatch(entry, rowText, rowCompact);
            const matchOffset = firstRowMatch ? 0 : _findSubmittedCommandRowOffset(entry, (offset) => (
                buffer.getLine(start + offset)?.translateToString(true) || ""
            ), height);
            const anchorStart = Math.min(lineCount - 1, start + matchOffset);
            const measuredHeight = match.exact
                ? Math.max(1, height - matchOffset)
                : Math.max(entry.lineCount, height - matchOffset);
            candidates.push({
                startLine: anchorStart,
                endLine: Math.min(lineCount - 1, anchorStart + measuredHeight - 1),
                score:
                    (matchOffset === 0 ? 100000 : 0)
                    + (match.exact ? 10000 : 0)
                    - (matchOffset * 1000)
                    - (measuredHeight * 100)
                    + anchorStart,
            });
            break;
        }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
}

function _findSubmittedCommandNeedleMatch(entry, sample, sampleCompact) {
    return entry.needles.find(needle => {
        return needle.compact ? sampleCompact.includes(needle.value) : sample.includes(needle.value);
    });
}

function _findSubmittedCommandRowOffset(entry, readRow, maxRows) {
    for (let offset = 0; offset < maxRows; offset += 1) {
        const rowText = _normalizeTerminalSearchText(readRow(offset) || "");
        if (!rowText) continue;
        const rowCompact = _compactTerminalSearchText(rowText);
        if (_findSubmittedCommandNeedleMatch(entry, rowText, rowCompact)) return offset;
    }
    return 0;
}

function _showFallbackSubmittedMarker(label) {
    const container = document.getElementById("xterm-container");
    if (!container) return;

    let marker = container.querySelector(".xterm-operator-send-fallback");
    if (!marker) {
        marker = document.createElement("div");
        marker.className = "xterm-operator-send-fallback";
        marker.setAttribute("aria-label", "Submitted by you");
        container.appendChild(marker);
    }
    marker.dataset.operatorLabel = label;
    marker.classList.remove("is-visible");
    marker.classList.remove("is-fresh");
    void marker.offsetWidth;
    marker.classList.add("is-visible");
    marker.classList.add("is-fresh");

    clearTimeout(_fallbackSubmittedMarkerTimer);
    _fallbackSubmittedMarkerTimer = setTimeout(() => {
        marker.classList.remove("is-fresh");
    }, 1800);
}

/** Send raw terminal input data over the WebSocket (used by textarea integration). */
export function sendTerminalInputWs(data) {
    if (terminalWs && terminalWs.readyState === WebSocket.OPEN) {
        terminalWs.send(JSON.stringify({
            type: "terminal_input",
            data: data,
        }));
        return true;
    }
    return false;
}
