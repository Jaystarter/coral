/* xterm.js terminal renderer — streams raw ANSI output via WebSocket */

import { state } from './state.js';
import { dbg } from './utils.js';
import { extractLocalPreviewLinks, openLocalFilePreview } from './changed_files.js';

let terminal = null;
let fitAddon = null;
let terminalWs = null;
let _selectionDisposable = null;
let _fileLinkProviderDisposable = null;
let _onDataDisposable = null;
let _onResizeDisposable = null;
let _resizeObserver = null;
let _terminalFocused = false;
let _submittedCommandDecorations = [];
let _fallbackSubmittedMarkerTimer = null;

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

/** Reuse the existing terminal if possible — just disconnect WS and clear buffer.
 *  Destroying and recreating the xterm canvas causes blank renders in macOS
 *  WebKit webview (webview_go). Only create a new Terminal when none exists. */
export function createTerminal(containerEl) {
    dbg('createTerminal called, existing terminal:', !!terminal);

    if (typeof Terminal === 'undefined') {
        console.warn('xterm.js not loaded, falling back to semantic renderer');
        return null;
    }

    // Reuse existing terminal — just disconnect WS and clear the buffer
    if (terminal) {
        disconnectTerminalWs();
        terminal.clear();
        terminal.reset();
        dbg('createTerminal: reusing existing terminal, cleared buffer');
        if (fitAddon) {
            requestAnimationFrame(() => { if (fitAddon) fitAddon.fit(); });
        }
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
        const webLinksAddon = new WebLinksAddon.WebLinksAddon();
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
    dbg('terminal.open() done, container:', containerEl.offsetWidth, 'x', containerEl.offsetHeight,
        'display:', containerEl.style.display, 'cols:', terminal.cols, 'rows:', terminal.rows);

    // Defer fit() to allow the layout engine to settle. In macOS WebKit
    // webview (used by coral-app), synchronous fit() right after open()
    // computes 0 cols/rows because the container hasn't been laid out yet.
    // Using rAF + a small fallback timeout ensures the terminal gets sized
    // correctly in both browsers and embedded webviews.
    requestAnimationFrame(() => {
        if (fitAddon) {
            fitAddon.fit();
            dbg('rAF fit() done, cols:', terminal?.cols, 'rows:', terminal?.rows,
                'container:', containerEl.offsetWidth, 'x', containerEl.offsetHeight);
        }
    });

    // ResizeObserver catches layout changes that rAF misses (e.g. when the
    // container transitions from display:none to flex, or sidebar resizes).
    if (typeof ResizeObserver !== 'undefined') {
        if (_resizeObserver) _resizeObserver.disconnect();
        _resizeObserver = new ResizeObserver(() => {
            if (fitAddon && containerEl.offsetWidth > 0 && containerEl.offsetHeight > 0) {
                fitAddon.fit();
            }
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
        if (terminalWs && terminalWs.readyState === WebSocket.OPEN) {
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
    if (matches.length === 0) return [];

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
    _setSessionEndedOverlay(false);

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams();
    if (agentType) params.set("agent_type", agentType);
    if (sessionId) params.set("session_id", sessionId);
    const qs = params.toString() ? `?${params}` : "";

    terminalWs = new WebSocket(
        `${proto}//${location.host}/ws/terminal/${encodeURIComponent(name)}${qs}`
    );
    terminalWs.binaryType = 'arraybuffer';

    terminalWs.onopen = () => {
        dbg('terminalWs OPEN', { sessionId, url: terminalWs.url });
        _setDisconnectedBadge(false);
        if (terminal) {
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
                terminal.write(new Uint8Array(event.data));
                if (_needsScrollToBottom) {
                    terminal.scrollToBottom();
                    // Keep scrolling to bottom for 500ms after connect
                    // to cover replay seed + any follow-up chunks
                    clearTimeout(_scrollSettleTimer);
                    _scrollSettleTimer = setTimeout(() => {
                        _needsScrollToBottom = false;
                    }, 500);
                }
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
    _setDisconnectedBadge(false);
    if (terminalWs) {
        terminalWs.close();
        terminalWs = null;
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
    _terminalFocused = false;
    _inputQueue = [];
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
    if (fitAddon) {
        fitAddon.fit();
    }
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
    const label = "YOU SENT";
    if (!terminal) {
        _showFallbackSubmittedMarker(label);
        return;
    }

    const marker = typeof terminal.registerMarker === "function" ? terminal.registerMarker(0) : null;
    if (!marker || typeof terminal.registerDecoration !== "function") {
        _showFallbackSubmittedMarker(label);
        return;
    }

    const lineCount = Math.max(1, Math.min(4, Math.ceil((String(command || "").length + 4) / Math.max(terminal.cols - 2, 1))));
    let decoration;
    try {
        decoration = terminal.registerDecoration({
            marker,
            x: 0,
            width: terminal.cols,
            height: lineCount,
            layer: "top",
        });
    } catch (e) {
        console.warn("Failed to register submitted command decoration:", e);
        _showFallbackSubmittedMarker(label);
        return;
    }

    if (!decoration) {
        _showFallbackSubmittedMarker(label);
        return;
    }

    decoration.onRender((el) => {
        el.classList.add("xterm-operator-send-marker");
        el.setAttribute("aria-label", "Submitted by you");
        el.dataset.operatorLabel = label;
    });

    const entry = { marker, decoration };
    _submittedCommandDecorations.push(entry);
    while (_submittedCommandDecorations.length > 6) {
        _disposeSubmittedCommandDecoration(_submittedCommandDecorations.shift());
    }

    setTimeout(() => {
        const index = _submittedCommandDecorations.indexOf(entry);
        if (index !== -1) _submittedCommandDecorations.splice(index, 1);
        _disposeSubmittedCommandDecoration(entry);
    }, 18000);
}

function _disposeSubmittedCommandDecoration(entry) {
    if (!entry) return;
    try { entry.decoration?.dispose?.(); } catch (_) {}
    try { entry.marker?.dispose?.(); } catch (_) {}
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
    void marker.offsetWidth;
    marker.classList.add("is-visible");

    clearTimeout(_fallbackSubmittedMarkerTimer);
    _fallbackSubmittedMarkerTimer = setTimeout(() => {
        marker.classList.remove("is-visible");
    }, 18000);
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
