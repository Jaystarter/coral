import { state } from './state.js';
import { apiFetch } from './api.js';
import { showView } from './utils.js';

const MESSAGE_LIMIT = 80;
const BOARD_REFRESH_MS = 10000;
const CANVAS_BUNDLE_SRC = '/static/vendor/mission-canvas/react-flow-canvas.js?v=20260511-rf9';

let _initialized = false;
let _renderTimer = null;
let _bundlePromise = null;
let _latestSessions = null;
let _renderVersion = 0;
let _activeScope = localStorage.getItem('coral-canvas-scope') || 'all';
const _showFlow = true;
const _reduceMotion = false;

const _boardCache = new Map();

export function initAgentCanvas() {
    if (_initialized) return;
    _initialized = true;

    const filter = document.getElementById('agent-canvas-team-filter');
    if (filter) {
        filter.value = _activeScope;
        filter.addEventListener('change', () => {
            _activeScope = filter.value || 'all';
            localStorage.setItem('coral-canvas-scope', _activeScope);
            _scheduleRender(0);
        });
    }

    window.addEventListener('coral:live-sessions-rendered', (event) => {
        _latestSessions = Array.isArray(event.detail?.sessions) ? event.detail.sessions : null;
        if (_isCanvasVisible()) _scheduleRender(60);
    });

    window.addEventListener('resize', () => {
        if (_isCanvasVisible()) _scheduleRender(120);
    });

    _syncControlState();
}

export function showAgentCanvas() {
    showView('agent-canvas-view');
    _syncControlState();
    _scheduleRender(0);
}

export function refreshAgentCanvas() {
    _scheduleRender(0);
}

function _stage() {
    return document.getElementById('agent-canvas-stage');
}

function _isCanvasVisible() {
    const view = document.getElementById('agent-canvas-view');
    return !!view && view.style.display !== 'none';
}

function _scheduleRender(delay = 0) {
    if (_renderTimer) clearTimeout(_renderTimer);
    _renderTimer = setTimeout(() => {
        _renderTimer = null;
        _renderCanvas();
    }, delay);
}

function _sessions() {
    const sessions = _latestSessions || state.liveSessions || [];
    return Array.isArray(sessions) ? sessions.filter(Boolean) : [];
}

function _syncControlState() {
    const stage = _stage();
    if (stage) {
        stage.classList.remove('reduce-motion', 'hide-flow');
        stage.classList.add('react-flow-mounted');
    }
}

async function _renderCanvas() {
    const stage = _stage();
    if (!stage) return;

    _renderVersion += 1;
    const version = _renderVersion;
    const sessions = _sessions();
    const grouped = _groupSessions(sessions);

    _syncControlState();
    _updateScopeOptions([...grouped.teams.keys()], grouped.standalone.length > 0);
    _updateHud(grouped, _visibleSessions(grouped));

    for (const boardName of _visibleTeams(grouped.teams).keys()) _ensureBoardData(boardName, version);

    stage.innerHTML = stage.innerHTML || '<div class="canvas-loading-state"><span class="startup-spinner"></span><strong>Loading React Flow canvas</strong><small>Preparing live operations graph.</small></div>';

    try {
        await _loadCanvasBundle();
        if (!_isCanvasVisible() || version !== _renderVersion) return;
        window.CoralMissionCanvas.mount(stage, {
            sessions,
            boardData: _serialiseBoardCache(),
            activeScope: _activeScope,
            showFlow: _showFlow,
            reduceMotion: _reduceMotion,
            onSelectSession: _openSession,
            onOpenBoard: _openBoard,
            onCreateTeam: () => window.showTeamWizardModal ? window.showTeamWizardModal() : window.showLaunchModal?.(),
            onLaunchAgent: () => window.showLaunchModal?.(),
        });
    } catch (err) {
        console.error('Failed to load React Flow canvas:', err);
        stage.innerHTML = '<section class="canvas-empty-state"><span class="agent-canvas-kicker">Canvas unavailable</span><h2>React Flow did not load.</h2><p>Check the local frontend bundle and reload Coral.</p></section>';
    }
}

function _loadCanvasBundle() {
    if (window.CoralMissionCanvas?.mount) return Promise.resolve();
    if (_bundlePromise) return _bundlePromise;

    _bundlePromise = new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[src="${CANVAS_BUNDLE_SRC}"]`);
        if (existing) {
            existing.addEventListener('load', () => resolve(), { once: true });
            existing.addEventListener('error', reject, { once: true });
            return;
        }
        const script = document.createElement('script');
        script.src = CANVAS_BUNDLE_SRC;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load ${CANVAS_BUNDLE_SRC}`));
        document.head.appendChild(script);
    });
    return _bundlePromise;
}

function _serialiseBoardCache() {
    return Object.fromEntries([..._boardCache.entries()].map(([board, data]) => [board, {
        messages: data.messages || [],
        tasks: data.tasks || [],
        fetchedAt: data.fetchedAt || 0,
    }]));
}

function _groupSessions(sessions) {
    const teams = new Map();
    const standalone = [];
    for (const session of sessions) {
        const board = session.board_project || session.board_name || '';
        if (board) {
            if (!teams.has(board)) teams.set(board, []);
            teams.get(board).push(session);
        } else {
            standalone.push(session);
        }
    }
    const sortedTeams = new Map([...teams.entries()].sort(([a], [b]) => a.localeCompare(b)));
    return { teams: sortedTeams, standalone };
}

function _visibleTeams(teams) {
    if (_activeScope === 'all') return teams;
    if (_activeScope === 'standalone') return new Map();
    const selected = teams.get(_activeScope);
    return selected ? new Map([[_activeScope, selected]]) : teams;
}

function _visibleSessions(grouped) {
    const teams = _visibleTeams(grouped.teams);
    const visible = [...teams.values()].flat();
    if (_activeScope === 'all' || _activeScope === 'standalone') visible.push(...grouped.standalone);
    return visible;
}

function _updateScopeOptions(teamNames, hasStandalone) {
    const select = document.getElementById('agent-canvas-team-filter');
    if (!select) return;

    const valid = new Set(['all', ...teamNames, ...(hasStandalone ? ['standalone'] : [])]);
    if (!valid.has(_activeScope)) {
        _activeScope = 'all';
        localStorage.setItem('coral-canvas-scope', _activeScope);
    }

    const optionHtml = [
        '<option value="all">All Teams</option>',
        ...teamNames.map(name => `<option value="${_escapeAttr(name)}">${_escapeHtml(name)}</option>`),
        hasStandalone ? '<option value="standalone">Solo Workbenches</option>' : '',
    ].join('');

    if (select.innerHTML !== optionHtml) select.innerHTML = optionHtml;
    select.value = _activeScope;
}

function _updateHud(grouped, visibleSessions) {
    const all = [...grouped.teams.values()].flat().concat(grouped.standalone);
    const working = all.filter(session => _agentState(session) === 'working').length;
    const waiting = all.filter(session => ['waiting', 'stuck'].includes(_agentState(session))).length;
    const ctxSessions = all.filter(session => _contextPct(session) != null);
    const avgContext = ctxSessions.length
        ? Math.round(ctxSessions.reduce((sum, session) => sum + _contextPct(session), 0) / ctxSessions.length)
        : null;
    const scopeLabel = _activeScope === 'all' ? 'All teams' : _activeScope === 'standalone' ? 'Solo workbenches' : _activeScope;

    _setHudText('canvas-hud-scope', scopeLabel);
    _setHudText('canvas-hud-agents', `${visibleSessions.length} visible`);
    _setHudText('canvas-hud-working', `${working} working`);
    _setHudText('canvas-hud-attention', waiting ? `${waiting} need attention` : 'clear');
    _setHudText('canvas-hud-context', avgContext == null ? 'ctx n/a' : `${avgContext}% ctx`);
}

function _setHudText(id, text) {
    const node = document.getElementById(id);
    if (node) node.textContent = text;
}

function _ensureBoardData(boardName, version) {
    const cached = _boardCache.get(boardName);
    const now = Date.now();
    if (cached?.inflight) return;
    if (cached && now - cached.fetchedAt < BOARD_REFRESH_MS) return;

    const next = cached || { messages: [], tasks: [], fetchedAt: 0, inflight: null };
    next.inflight = Promise.all([
        apiFetch(`/api/board/${encodeURIComponent(boardName)}/messages/all?format=dashboard&limit=${MESSAGE_LIMIT}`).catch(() => ({ messages: [] })),
        apiFetch(`/api/board/${encodeURIComponent(boardName)}/tasks`).catch(() => ({ tasks: [] })),
    ]).then(([messageData, taskData]) => {
        const messages = Array.isArray(messageData) ? messageData : (messageData.messages || []);
        const tasks = Array.isArray(taskData) ? taskData : (taskData.tasks || []);
        _boardCache.set(boardName, { messages, tasks, fetchedAt: Date.now(), inflight: null });
        if (_isCanvasVisible() && version === _renderVersion) _scheduleRender(0);
    }).catch(() => {
        _boardCache.set(boardName, { ...(cached || {}), fetchedAt: Date.now(), inflight: null, messages: cached?.messages || [], tasks: cached?.tasks || [] });
    });
    _boardCache.set(boardName, next);
}

function _openBoard(board) {
    if (!board || board === 'Solo Workbenches') return;
    if (window.switchNavTab) window.switchNavTab('board');
    if (window.selectBoardProject) window.selectBoardProject(board);
}

function _openSession(session) {
    if (!session || !window.selectLiveSession) return;
    if (window.switchNavTab) window.switchNavTab('agents');
    window.selectLiveSession(session.name, session.agent_type, session.session_id);
}

function _agentState(session) {
    if (!session) return 'idle';
    if (session.done || session.sleeping) return 'disabled';
    if (session.stuck) return 'stuck';
    if (session.waiting_for_input) return 'waiting';
    const provider = String(session.agent_type || '').toLowerCase();
    const staleness = Number(session.staleness_seconds);
    const recentCodex = provider === 'codex' && Number.isFinite(staleness) && staleness < 30 && !/task complete/i.test(session.status || '');
    if (session.working || recentCodex) return 'working';
    return 'idle';
}

function _contextPct(session) {
    const raw = session?.context_pct ?? session?.context_percent ?? session?.context_usage_pct ?? session?.context_usage_percent;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, Math.round(n)));
}

function _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
}

function _escapeAttr(str) {
    return _escapeHtml(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
