import { state } from './state.js';
import { apiFetch } from './api.js';
import { escapeHtml, escapeAttr, showView, getAgentColor, hexToRgba } from './utils.js';

const MESSAGE_LIMIT = 120;
const BOARD_REFRESH_MS = 10000;
const GRAPH = {
    rootX: 118,
    agentX: 520,
    messageX: 920,
    nodeGapX: 342,
    branchStartY: 180,
    branchGapY: 214,
    minWidth: 1740,
    minHeight: 820,
    rightPad: 160,
    bottomPad: 190,
};
const NODE = {
    hub: { w: 282, h: 166 },
    agent: { w: 282, h: 148 },
    message: { w: 272, h: 108 },
    task: { w: 272, h: 96 },
};

let _initialized = false;
let _renderTimer = null;
let _latestSessions = null;
let _renderVersion = 0;
let _activeScope = localStorage.getItem('coral-canvas-scope') || 'all';
let _showFlow = localStorage.getItem('coral-canvas-show-flow') !== 'false';
let _reduceMotion = localStorage.getItem('coral-canvas-reduce-motion') === 'true' ||
    (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

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

    const fitBtn = document.getElementById('agent-canvas-fit');
    if (fitBtn) {
        fitBtn.addEventListener('click', () => _fitCanvas());
    }

    const flowBtn = document.getElementById('agent-canvas-flow-toggle');
    if (flowBtn) {
        flowBtn.addEventListener('click', () => {
            _showFlow = !_showFlow;
            localStorage.setItem('coral-canvas-show-flow', _showFlow ? 'true' : 'false');
            _syncControlState();
            _scheduleRender(0);
        });
    }

    const motionBtn = document.getElementById('agent-canvas-motion-toggle');
    if (motionBtn) {
        motionBtn.addEventListener('click', () => {
            _reduceMotion = !_reduceMotion;
            localStorage.setItem('coral-canvas-reduce-motion', _reduceMotion ? 'true' : 'false');
            _syncControlState();
            _scheduleRender(0);
        });
    }

    const stage = _stage();
    if (stage) {
        stage.addEventListener('click', _handleStageClick);
        stage.addEventListener('keydown', _handleStageKeydown);
    }

    window.addEventListener('coral:live-sessions-rendered', (event) => {
        _latestSessions = Array.isArray(event.detail?.sessions) ? event.detail.sessions : null;
        if (_isCanvasVisible()) _scheduleRender(80);
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
    const flowBtn = document.getElementById('agent-canvas-flow-toggle');
    if (flowBtn) {
        flowBtn.classList.toggle('is-active', _showFlow);
        flowBtn.setAttribute('aria-pressed', _showFlow ? 'true' : 'false');
    }
    const motionBtn = document.getElementById('agent-canvas-motion-toggle');
    if (motionBtn) {
        motionBtn.classList.toggle('is-active', _reduceMotion);
        motionBtn.setAttribute('aria-pressed', _reduceMotion ? 'true' : 'false');
    }
    const stage = _stage();
    if (stage) {
        stage.classList.toggle('reduce-motion', _reduceMotion);
        stage.classList.toggle('hide-flow', !_showFlow);
    }
}

function _fitCanvas() {
    const stage = _stage();
    if (!stage) return;
    const selected = stage.querySelector('.canvas-flow-surface');
    const left = selected ? Math.max(0, selected.offsetLeft - 18) : 0;
    stage.scrollTo({ top: 0, left, behavior: _reduceMotion ? 'auto' : 'smooth' });
}

function _renderCanvas() {
    const stage = _stage();
    if (!stage) return;

    _renderVersion += 1;
    const version = _renderVersion;
    const sessions = _sessions();

    _syncControlState();

    if (!sessions.length) {
        stage.innerHTML = _renderEmptyState();
        _updateScopeOptions([], false);
        return;
    }

    const grouped = _groupSessions(sessions);
    _updateScopeOptions([...grouped.teams.keys()], grouped.standalone.length > 0);

    const visibleTeams = _visibleTeams(grouped.teams);
    const showSolo = _activeScope === 'all' || _activeScope === 'standalone';
    const visibleSolo = showSolo ? grouped.standalone : [];

    for (const boardName of visibleTeams.keys()) {
        _ensureBoardData(boardName, version);
    }

    const allVisibleSessions = [...visibleTeams.values()].flat().concat(visibleSolo);
    stage.innerHTML = `
        ${_renderOverview(grouped, allVisibleSessions)}
        <div class="canvas-board-stack">
            ${[...visibleTeams.entries()].map(([boardName, boardSessions]) => _renderTeamPanel(boardName, boardSessions)).join('')}
            ${visibleSolo.length ? _renderSoloPanel(visibleSolo) : ''}
        </div>`;
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
    for (const list of sortedTeams.values()) list.sort(_agentSort);
    standalone.sort(_agentSort);
    return { teams: sortedTeams, standalone };
}

function _visibleTeams(teams) {
    if (_activeScope === 'all') return teams;
    if (_activeScope === 'standalone') return new Map();
    const selected = teams.get(_activeScope);
    return selected ? new Map([[_activeScope, selected]]) : teams;
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
        ...teamNames.map(name => `<option value="${escapeAttr(name)}">${escapeHtml(name)}</option>`),
        hasStandalone ? '<option value="standalone">Solo Workbenches</option>' : '',
    ].join('');

    if (select.innerHTML !== optionHtml) select.innerHTML = optionHtml;
    select.value = _activeScope;
}

function _renderOverview(grouped, visibleSessions) {
    const all = [...grouped.teams.values()].flat().concat(grouped.standalone);
    const working = all.filter(session => _agentState(session).key === 'working').length;
    const waiting = all.filter(session => ['waiting', 'stuck'].includes(_agentState(session).key)).length;
    const tokenTotal = all.reduce((sum, session) => sum + _tokenTotal(session), 0);
    const costTotal = all.reduce((sum, session) => sum + (Number(session.token_cost_usd) || 0), 0);
    const contextSessions = all.filter(session => _contextPct(session) != null);
    const avgContext = contextSessions.length
        ? Math.round(contextSessions.reduce((sum, session) => sum + _contextPct(session), 0) / contextSessions.length)
        : null;

    const metrics = [
        ['Rooms', String(grouped.teams.size + (grouped.standalone.length ? 1 : 0)), 'Board branches online'],
        ['Agents', String(all.length), `${working} working, ${waiting} waiting or stuck`],
        ['Context', avgContext == null ? 'n/a' : `${avgContext}%`, 'Average visible context load'],
        ['Usage', costTotal > 0 ? _formatCost(costTotal) : _formatTokens(tokenTotal), costTotal > 0 ? `${_formatTokens(tokenTotal)} live tokens` : 'Live token estimate'],
    ];

    return `<section class="canvas-overview-strip" aria-label="Canvas summary">
        <div class="canvas-overview-copy">
            <span>Flow Atlas</span>
            <strong>${_activeScope === 'all' ? 'Conversation branches' : escapeHtml(_activeScope === 'standalone' ? 'Solo Workbenches' : _activeScope)}</strong>
            <p>${visibleSessions.length} agent${visibleSessions.length === 1 ? '' : 's'} mapped as node branches from recent board history.</p>
        </div>
        <div class="canvas-metric-grid">
            ${metrics.map(([label, value, detail]) => `<div class="canvas-metric">
                <span>${escapeHtml(label)}</span>
                <strong>${escapeHtml(value)}</strong>
                <small>${escapeHtml(detail)}</small>
            </div>`).join('')}
        </div>
    </section>`;
}

function _renderTeamPanel(boardName, sessions) {
    const cache = _boardCache.get(boardName) || { messages: [], tasks: [], fetchedAt: 0 };
    const tasks = _activeTasks(cache.tasks);
    const graph = _buildFlowGraph(boardName, sessions, cache.messages, tasks);
    const branch = _boardBranch(sessions);
    const boardCost = sessions.reduce((sum, session) => sum + (Number(session.token_cost_usd) || 0), 0);
    const boardTokens = sessions.reduce((sum, session) => sum + _tokenTotal(session), 0);
    const boardState = _boardState(sessions);

    return `<section class="canvas-team-panel canvas-flow-panel" data-board="${escapeAttr(boardName)}">
        <header class="canvas-team-header">
            <button type="button" class="canvas-team-button" data-board="${escapeAttr(boardName)}" title="Open board ${escapeAttr(boardName)}">
                <span class="canvas-team-eyebrow">Branch Graph</span>
                <strong>${escapeHtml(boardName)}</strong>
            </button>
            <div class="canvas-team-meta">
                ${branch ? `<span title="Branch">${escapeHtml(branch)}</span>` : ''}
                <span>${sessions.length} agents</span>
                <span>${graph.messageCount} messages mapped</span>
                <span>${_formatTokens(boardTokens)}</span>
                ${boardCost > 0 ? `<span>${_formatCost(boardCost)}</span>` : ''}
                <span class="canvas-board-state canvas-board-state-${boardState.key}">${escapeHtml(boardState.label)}</span>
            </div>
        </header>
        <div class="canvas-flow-shell" style="--team-accent:${escapeAttr(getAgentColor(boardName))}">
            <div class="canvas-flow-surface" style="width:${graph.width}px;height:${graph.height}px;--team-accent:${escapeAttr(getAgentColor(boardName))}">
                ${_renderFlowLayer(graph)}
                ${graph.nodes.map(node => _renderFlowNode(node, boardName)).join('')}
            </div>
            ${_renderTaskRail(tasks)}
        </div>
    </section>`;
}

function _buildFlowGraph(boardName, sessions, messages, tasks) {
    const ordered = [...sessions].sort(_agentSort);
    const orchestratorIndex = ordered.findIndex(session => _isOrchestrator(session));
    const hubSession = orchestratorIndex >= 0 ? ordered.splice(orchestratorIndex, 1)[0] : ordered.shift();
    const branchSessions = hubSession ? ordered : [...ordered];
    const agents = branchSessions.length ? branchSessions : (hubSession ? [hubSession] : []);
    const laneCount = Math.max(1, agents.length + 1);
    const hubY = Math.max(
        GRAPH.branchStartY,
        GRAPH.branchStartY + ((laneCount - 1) * GRAPH.branchGapY) / 2 - NODE.hub.h / 2,
    );

    const graph = {
        id: _graphId(boardName),
        width: GRAPH.minWidth,
        height: GRAPH.minHeight,
        nodes: [],
        edges: [],
        nodeById: new Map(),
        agentNodeByKey: new Map(),
        laneByKey: new Map(),
        messageCount: 0,
    };

    const hubNode = _makeNode('hub', `hub:${boardName}`, GRAPH.rootX, hubY, NODE.hub.w, NODE.hub.h, {
        boardName,
        session: hubSession,
        title: hubSession ? _agentLabel(hubSession) : boardName,
        subtitle: hubSession ? 'Orchestrator root' : 'Board root',
        status: hubSession ? _statusText(hubSession) : 'Recent board flow',
        state: hubSession ? _agentState(hubSession).key : 'idle',
        tokenText: hubSession ? _agentTokenSummary(hubSession) : '',
    });
    _addNode(graph, hubNode);

    agents.forEach((session, index) => {
        const key = _sessionKey(session) || `agent:${index}`;
        const y = GRAPH.branchStartY + index * GRAPH.branchGapY;
        const node = _makeNode('agent', `agent:${key}`, GRAPH.agentX, y, NODE.agent.w, NODE.agent.h, {
            session,
            boardName,
            title: _agentLabel(session),
            subtitle: _agentSubtitle(session),
            status: _statusText(session),
            state: _agentState(session).key,
            context: _contextPct(session),
            tokenText: _agentTokenSummary(session),
            color: getAgentColor(_agentLabel(session)),
            tasks: tasks.filter(task => _taskMatchesSession(task, session)),
        });
        _addNode(graph, node);
        graph.agentNodeByKey.set(key, node);
        graph.laneByKey.set(key, {
            session,
            x: GRAPH.messageX,
            y: y + 18,
            nextX: GRAPH.messageX,
            lastNode: node,
            count: 0,
        });
        _addEdge(graph, hubNode, node, 'branch', 'control');
    });

    const streamY = GRAPH.branchStartY + agents.length * GRAPH.branchGapY;
    const streamNode = _makeNode('stream', `stream:${boardName}`, GRAPH.agentX, streamY, NODE.agent.w, NODE.agent.h, {
        title: 'Board stream',
        subtitle: 'Unattributed messages',
        status: 'Messages that do not map cleanly to one agent.',
        state: 'idle',
        color: getAgentColor(`${boardName}:stream`),
    });
    _addNode(graph, streamNode);
    graph.laneByKey.set('__stream__', {
        session: null,
        x: GRAPH.messageX,
        y: streamY + 18,
        nextX: GRAPH.messageX,
        lastNode: streamNode,
        count: 0,
    });
    _addEdge(graph, hubNode, streamNode, 'branch', 'stream');

    const sortedMessages = _recentMessages(messages, 40);
    graph.messageCount = sortedMessages.length;
    sortedMessages.forEach((message, index) => {
        const sender = _matchSenderForGraph(message, sessions);
        const senderKey = sender ? _sessionKey(sender) : '__stream__';
        const lane = graph.laneByKey.get(senderKey) || graph.laneByKey.get('__stream__');
        const tone = _messageTone(message.content);
        const messageY = lane.y + (lane.count % 2) * 30;
        const messageNode = _makeNode('message', `msg:${message.id || index}:${senderKey}`, lane.nextX, messageY, NODE.message.w, NODE.message.h, {
            message,
            boardName,
            title: sender ? _agentLabel(sender) : (message.job_title || message.sender_name || 'Board message'),
            subtitle: _formatMessageTime(message.created_at),
            status: _messageSnippet(message.content),
            tone,
        });
        _addNode(graph, messageNode);
        _addEdge(graph, lane.lastNode, messageNode, `message ${tone}`, 'posted');
        lane.lastNode = messageNode;
        lane.nextX += GRAPH.nodeGapX;
        lane.count += 1;

        const targets = _messageTargets(message.content, sessions, sender);
        targets.targets.forEach(target => {
            const targetNode = graph.agentNodeByKey.get(_sessionKey(target));
            if (targetNode) _addEdge(graph, messageNode, targetNode, targets.kind, targets.kind === 'broadcast' ? 'all' : 'mention');
        });
        if (!targets.targets.length && sender && hubNode !== messageNode) {
            _addEdge(graph, messageNode, hubNode, 'quiet', 'board');
        }
    });

    for (const task of tasks.slice(0, 12)) {
        const assignee = _sessionForTask(task, sessions);
        const lane = assignee ? graph.laneByKey.get(_sessionKey(assignee)) : graph.laneByKey.get('__stream__');
        if (!lane) continue;
        const taskNode = _makeNode('task', `task:${task.id || task.title}:${lane.x}`, lane.nextX, lane.y + 46, NODE.task.w, NODE.task.h, {
            task,
            boardName,
            title: task.title || `Task #${task.id}`,
            subtitle: task.assigned_to || task.status || 'unassigned',
            status: task.body || task.completion_message || 'Board task',
            tone: _taskTone(task),
        });
        _addNode(graph, taskNode);
        _addEdge(graph, lane.lastNode, taskNode, `task ${_taskTone(task)}`, 'task');
        lane.lastNode = taskNode;
        lane.nextX += GRAPH.nodeGapX;
        lane.count += 1;
    }

    graph.width = Math.max(GRAPH.minWidth, ...graph.nodes.map(node => node.x + node.w + GRAPH.rightPad));
    graph.height = Math.max(GRAPH.minHeight, ...graph.nodes.map(node => node.y + node.h + GRAPH.bottomPad));
    return graph;
}

function _makeNode(type, id, x, y, w, h, data = {}) {
    return { type, id, x, y, w, h, data };
}

function _addNode(graph, node) {
    graph.nodes.push(node);
    graph.nodeById.set(node.id, node);
}

function _addEdge(graph, from, to, kind, label) {
    if (!from || !to || from.id === to.id) return;
    graph.edges.push({ from: from.id, to: to.id, kind, label });
}

function _renderFlowLayer(graph) {
    if (!_showFlow) return '';
    const markerId = `canvas-arrow-${graph.id}`;
    const edges = graph.edges.map(edge => {
        const from = graph.nodeById.get(edge.from);
        const to = graph.nodeById.get(edge.to);
        if (!from || !to) return '';
        return `<path class="canvas-flow-path ${escapeAttr(edge.kind)}" d="${escapeAttr(_flowPath(from, to))}" marker-end="url(#${markerId})"></path>`;
    }).join('');
    return `<svg class="canvas-flow-svg" width="${graph.width}" height="${graph.height}" viewBox="0 0 ${graph.width} ${graph.height}" aria-hidden="true">
        <defs>
            <marker id="${markerId}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"></path>
            </marker>
        </defs>
        ${edges}
    </svg>`;
}

function _flowPath(from, to) {
    const vertical = Math.abs((from.x + from.w / 2) - (to.x + to.w / 2)) < 18 && to.y >= from.y;
    if (vertical) {
        const sx = from.x + from.w / 2;
        const sy = from.y + from.h;
        const tx = to.x + to.w / 2;
        const ty = to.y;
        const curve = Math.min(84, Math.max(38, (ty - sy) * 0.42));
        return `M ${sx} ${sy} C ${sx} ${sy + curve}, ${tx} ${ty - curve}, ${tx} ${ty}`;
    }

    const fromLeft = from.x > to.x;
    const sx = fromLeft ? from.x : from.x + from.w;
    const sy = from.y + from.h / 2;
    const tx = fromLeft ? to.x + to.w : to.x;
    const ty = to.y + to.h / 2;
    const curve = Math.max(72, Math.min(180, Math.abs(tx - sx) * 0.38));
    const c1 = fromLeft ? sx - curve : sx + curve;
    const c2 = fromLeft ? tx + curve : tx - curve;
    return `M ${sx} ${sy} C ${c1} ${sy}, ${c2} ${ty}, ${tx} ${ty}`;
}

function _renderFlowNode(node, boardName) {
    if (node.type === 'hub') return _renderHubNode(node, boardName);
    if (node.type === 'agent' || node.type === 'stream') return _renderAgentBranchNode(node, boardName);
    if (node.type === 'message') return _renderMessageNode(node, boardName);
    if (node.type === 'task') return _renderTaskNode(node, boardName);
    return '';
}

function _nodeStyle(node) {
    return `left:${node.x}px;top:${node.y}px;width:${node.w}px;min-height:${node.h}px`;
}

function _renderHubNode(node, boardName) {
    const session = node.data.session;
    const stateKey = node.data.state || 'idle';
    return `<button type="button" class="flow-node flow-hub-node canvas-state-${stateKey}" style="${_nodeStyle(node)}" data-session-id="${escapeAttr(session?.session_id || '')}" data-agent-name="${escapeAttr(session?.name || '')}" data-agent-type="${escapeAttr(session?.agent_type || '')}" data-board="${escapeAttr(boardName)}">
        <span class="flow-handle flow-handle-out"></span>
        <span class="flow-node-kicker">Root</span>
        <strong>${escapeHtml(node.data.title)}</strong>
        <em>${escapeHtml(node.data.subtitle)}</em>
        <span class="flow-node-status">${escapeHtml(_shortText(node.data.status, 92))}</span>
        <span class="flow-node-foot">
            <b>${escapeHtml(_agentState(session || {}).label || 'Board')}</b>
            ${node.data.tokenText ? `<small>${escapeHtml(node.data.tokenText)}</small>` : '<small>Board control</small>'}
        </span>
        ${_renderNodePopover(node, boardName)}
    </button>`;
}

function _renderAgentBranchNode(node, boardName) {
    const session = node.data.session;
    const stateKey = node.data.state || 'idle';
    const color = node.data.color || getAgentColor(node.data.title);
    const context = node.data.context;
    const taskCount = node.data.tasks?.length || 0;
    const style = `${_nodeStyle(node)};--agent-color:${escapeAttr(color)};--agent-color-soft:${escapeAttr(hexToRgba(color, 0.16))}`;
    return `<button type="button" class="flow-node flow-agent-node canvas-state-${stateKey} ${node.type === 'stream' ? 'flow-stream-node' : ''}" style="${style}" data-session-id="${escapeAttr(session?.session_id || '')}" data-agent-name="${escapeAttr(session?.name || '')}" data-agent-type="${escapeAttr(session?.agent_type || '')}" data-board="${escapeAttr(boardName)}">
        <span class="flow-handle flow-handle-in"></span>
        <span class="flow-handle flow-handle-out"></span>
        <span class="flow-node-top">
            <span class="flow-avatar">${escapeHtml(session ? _avatar(session) : '◇')}</span>
            <span><strong>${escapeHtml(node.data.title)}</strong><em>${escapeHtml(node.data.subtitle)}</em></span>
            <i title="${escapeAttr(_agentState(session || {}).label || 'Stream')}"></i>
        </span>
        <span class="flow-node-status">${escapeHtml(_shortText(node.data.status, 84))}</span>
        <span class="flow-node-badges">
            ${context == null ? '<small>ctx n/a</small>' : `<small>${context}% ctx</small>`}
            ${node.data.tokenText ? `<small>${escapeHtml(node.data.tokenText)}</small>` : '<small>no usage</small>'}
            ${taskCount ? `<small>${taskCount} tasks</small>` : ''}
        </span>
        ${_renderNodePopover(node, boardName)}
    </button>`;
}

function _renderMessageNode(node, boardName) {
    const tone = node.data.tone || 'neutral';
    const message = node.data.message || {};
    return `<button type="button" class="flow-node flow-message-node flow-tone-${tone}" style="${_nodeStyle(node)}" data-board="${escapeAttr(boardName)}" data-message-id="${escapeAttr(message.id || '')}">
        <span class="flow-handle flow-handle-in"></span>
        <span class="flow-handle flow-handle-out"></span>
        <span class="flow-message-head"><strong>${escapeHtml(_shortText(node.data.title, 28))}</strong><em>${escapeHtml(node.data.subtitle)}</em></span>
        <span class="flow-message-body">${escapeHtml(_shortText(node.data.status, 126))}</span>
        ${_renderNodePopover(node, boardName)}
    </button>`;
}

function _renderTaskNode(node, boardName) {
    const tone = node.data.tone || 'neutral';
    return `<button type="button" class="flow-node flow-task-node flow-tone-${tone}" style="${_nodeStyle(node)}" data-board="${escapeAttr(boardName)}">
        <span class="flow-handle flow-handle-in"></span>
        <span class="flow-node-kicker">Task</span>
        <strong>${escapeHtml(_shortText(node.data.title, 42))}</strong>
        <em>${escapeHtml(node.data.subtitle || 'unassigned')}</em>
        <span class="flow-message-body">${escapeHtml(_shortText(node.data.status, 102))}</span>
        ${_renderNodePopover(node, boardName)}
    </button>`;
}

function _renderNodePopover(node, boardName) {
    const rows = [];
    const session = node.data.session;

    if (session) {
        const agentState = _agentState(session);
        const context = _contextPct(session);
        const branch = _repoBranch(session.repo_name, session.branch);
        rows.push(['State', agentState.label]);
        rows.push(['Role', _agentSubtitle(session)]);
        if (_agentModel(session)) rows.push(['Model', _agentModel(session)]);
        if (context != null) rows.push(['Context', `${context}%`]);
        if (_agentTokenSummary(session)) rows.push(['Usage', _agentTokenSummary(session)]);
        if (branch) rows.push(['Branch', branch]);
        if (node.data.tasks?.length) rows.push(['Tasks', node.data.tasks.map(task => task.title || `Task #${task.id}`).slice(0, 2).join(' | ')]);
        if (session.updated_at || session.last_activity_at || session.created_at) {
            rows.push(['Activity', _formatDateTime(session.last_activity_at || session.updated_at || session.created_at)]);
        }
    } else if (node.type === 'message') {
        const message = node.data.message || {};
        rows.push(['Board', boardName]);
        rows.push(['From', node.data.title || message.sender_name || 'Board']);
        rows.push(['Posted', _formatDateTime(message.created_at)]);
        rows.push(['Signal', _messageTone(message.content)]);
    } else if (node.type === 'task') {
        const task = node.data.task || {};
        rows.push(['Board', boardName]);
        rows.push(['Assignee', task.assigned_to || 'unassigned']);
        rows.push(['Status', task.status || 'open']);
        rows.push(['Priority', task.priority || 'normal']);
    } else {
        rows.push(['Board', boardName]);
        rows.push(['Signal', node.data.subtitle || 'Branch root']);
    }

    const title = node.type === 'message' ? 'Message branch' : node.type === 'task' ? 'Task branch' : 'Node inspection';
    return `<span class="flow-node-popover" role="tooltip">
        <span class="flow-popover-kicker">${escapeHtml(title)}</span>
        <span class="flow-popover-status">${escapeHtml(_shortText(node.data.status || node.data.title || '', 150))}</span>
        <span class="flow-popover-rows">
            ${rows.filter(([, value]) => value != null && String(value).trim()).map(([label, value]) => `<span><b>${escapeHtml(label)}</b><em>${escapeHtml(_shortText(value, 84))}</em></span>`).join('')}
        </span>
    </span>`;
}

function _renderSoloPanel(sessions) {
    return `<section class="canvas-team-panel canvas-solo-panel">
        <header class="canvas-team-header">
            <div class="canvas-team-button canvas-team-button-static">
                <span class="canvas-team-eyebrow">Solo Workbenches</span>
                <strong>Standalone agents</strong>
            </div>
            <div class="canvas-team-meta"><span>${sessions.length} agents</span><span>No board branch yet</span></div>
        </header>
        <div class="canvas-solo-lane">
            ${sessions.map(session => _renderSoloCard(session)).join('')}
        </div>
    </section>`;
}

function _renderSoloCard(session) {
    const agentState = _agentState(session);
    return `<button type="button" class="canvas-solo-card canvas-state-${agentState.key}" data-session-id="${escapeAttr(session.session_id || '')}" data-agent-name="${escapeAttr(session.name || '')}" data-agent-type="${escapeAttr(session.agent_type || '')}">
        <span class="canvas-solo-avatar">${escapeHtml(_avatar(session))}</span>
        <span class="canvas-solo-main"><strong>${escapeHtml(_agentLabel(session))}</strong><small>${escapeHtml(_shortText(_statusText(session), 72))}</small></span>
        <span class="canvas-solo-stat">${escapeHtml(agentState.label)}</span>
    </button>`;
}

function _renderTaskRail(tasks) {
    if (!tasks.length) {
        return `<aside class="canvas-task-rail canvas-task-rail-empty">
            <span>Task overlay</span>
            <strong>Quiet queue</strong>
            <small>No active board tasks are mapped onto this flow.</small>
        </aside>`;
    }

    return `<aside class="canvas-task-rail">
        <span>Task overlay</span>
        ${tasks.slice(0, 5).map(task => `<div class="canvas-task-pill">
            <strong>${escapeHtml(_shortText(task.title || task.body || `Task #${task.id}`, 54))}</strong>
            <small>${escapeHtml(task.assigned_to || task.status || 'unassigned')}</small>
        </div>`).join('')}
    </aside>`;
}

function _renderEmptyState() {
    return `<section class="canvas-empty-state">
        <div class="canvas-empty-orb" aria-hidden="true">
            <span></span><span></span><span></span><span></span>
        </div>
        <span class="agent-canvas-kicker">Flow Atlas</span>
        <h2>No branches to map yet.</h2>
        <p>Launch a team and Coral will turn board messages into visible branches without changing the underlying sessions.</p>
        <div class="canvas-empty-actions">
            <button type="button" onclick="window.showLaunchModal && window.showLaunchModal()">Create Team</button>
            <button type="button" onclick="window.showAddStandaloneAgent ? window.showAddStandaloneAgent('') : window.launchDefaultAgent && window.launchDefaultAgent('')">Launch Agent</button>
        </div>
    </section>`;
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

function _handleStageClick(event) {
    const team = event.target.closest('.canvas-team-button[data-board]');
    if (team) {
        _openBoard(team.dataset.board);
        return;
    }

    const message = event.target.closest('.flow-message-node, .flow-task-node');
    if (message?.dataset.board) {
        _openBoard(message.dataset.board);
        return;
    }

    const node = event.target.closest('.flow-agent-node, .flow-hub-node, .canvas-solo-card');
    if (!node) return;
    _openSessionFromNode(node);
}

function _handleStageKeydown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target.closest('.flow-agent-node, .flow-hub-node, .canvas-solo-card, .canvas-team-button[data-board], .flow-message-node, .flow-task-node');
    if (!target) return;
    event.preventDefault();
    target.click();
}

function _openBoard(board) {
    if (!board) return;
    if (window.switchNavTab) window.switchNavTab('board');
    if (window.selectBoardProject) window.selectBoardProject(board);
}

function _openSessionFromNode(node) {
    const sessionId = node.dataset.sessionId || '';
    const name = node.dataset.agentName || '';
    const agentType = node.dataset.agentType || '';
    const session = _sessions().find(item => item.session_id === sessionId) ||
        _sessions().find(item => item.name === name && item.agent_type === agentType);
    if (!session || !window.selectLiveSession) {
        if (node.dataset.board) _openBoard(node.dataset.board);
        return;
    }
    if (window.switchNavTab) window.switchNavTab('agents');
    window.selectLiveSession(session.name, session.agent_type, session.session_id);
}

function _recentMessages(messages, limit) {
    return (messages || [])
        .filter(message => message && (message.content || message.job_title || message.sender_name))
        .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
        .slice(-limit);
}

function _matchSenderForGraph(message, sessions) {
    const byAlias = new Map();
    for (const session of sessions) {
        for (const alias of _agentAliases(session)) byAlias.set(alias, session);
    }
    const candidates = [message.job_title, message.sender_name, message.subscriber_id, message.session_id]
        .map(value => _normalise(value || ''))
        .filter(Boolean);
    for (const candidate of candidates) {
        if (byAlias.has(candidate)) return byAlias.get(candidate);
        for (const [alias, session] of byAlias.entries()) {
            if (candidate.includes(alias) || alias.includes(candidate)) return session;
        }
    }
    return sessions.find(session => _normalise(session.session_id || '') === _normalise(message.session_id || '')) || null;
}

function _messageTargets(content, sessions, sourceSession) {
    const text = String(content || '');
    const sourceKey = sourceSession ? _sessionKey(sourceSession) : '';
    if (/@(?:notify-all|all)\b/i.test(text)) {
        return { kind: 'broadcast', targets: sessions.filter(session => _sessionKey(session) !== sourceKey) };
    }

    const lowerContent = _normalise(text);
    const mentions = [...text.matchAll(/@([\w .@-]+)/g)].map(match => _normalise(match[1]).trim()).filter(Boolean);
    const targets = new Set();
    for (const session of sessions) {
        if (_sessionKey(session) === sourceKey) continue;
        const aliases = _agentAliases(session);
        if (mentions.some(mention => aliases.some(alias => alias === mention || alias.includes(mention) || mention.includes(alias)))) {
            targets.add(session);
            continue;
        }
        if (aliases.filter(alias => alias.length >= 4).some(alias => lowerContent.includes(alias))) targets.add(session);
    }
    return { kind: targets.size ? 'direct' : 'quiet', targets: [...targets] };
}

function _activeTasks(tasks) {
    const inactive = new Set(['done', 'complete', 'completed', 'cancelled', 'canceled']);
    return (tasks || [])
        .filter(task => !inactive.has(String(task.status || '').toLowerCase()))
        .sort((a, b) => {
            const ap = Number(a.priority) || 99;
            const bp = Number(b.priority) || 99;
            if (ap !== bp) return ap - bp;
            return String(b.created_at || '').localeCompare(String(a.created_at || ''));
        });
}

function _sessionForTask(task, sessions) {
    return sessions.find(session => _taskMatchesSession(task, session)) || null;
}

function _taskMatchesSession(task, session) {
    const assigned = _normalise(task.assigned_to || '');
    if (!assigned) return false;
    return _agentAliases(session).includes(assigned);
}

function _agentSort(a, b) {
    const ao = _isOrchestrator(a) ? -1 : 0;
    const bo = _isOrchestrator(b) ? -1 : 0;
    if (ao !== bo) return ao - bo;
    return _agentLabel(a).localeCompare(_agentLabel(b));
}

function _isOrchestrator(session) {
    return /orchestrator/i.test(`${session.display_name || ''} ${session.board_job_title || ''} ${session.name || ''}`);
}

function _sessionKey(session) {
    return session?.session_id || `${session?.agent_type || 'agent'}:${session?.name || _agentLabel(session)}`;
}

function _agentLabel(session) {
    return session?.display_name || session?.board_job_title || session?.name || 'Agent';
}

function _agentSubtitle(session) {
    const parts = [session?.board_job_title || session?.display_name, session?.agent_type, _agentModel(session)].filter(Boolean);
    return [...new Set(parts)].join(' · ') || 'Agent branch';
}

function _agentModel(session) {
    return session?.model || session?.model_name || session?.agent_model || '';
}

function _statusText(session) {
    if (!session) return 'Board level activity';
    if (session.sleeping) return 'Sleeping until resumed';
    if (session.stuck) return session.waiting_summary || session.status || 'Needs operator attention';
    if (session.waiting_for_input) return session.waiting_reason || session.waiting_summary || 'Waiting for input';
    if (session.summary) return session.summary;
    if (session.status) return session.status;
    if (session.done) return 'Task complete';
    return _agentState(session).key === 'working' ? 'Working through the current turn' : 'Idle and ready';
}

function _agentState(session) {
    if (!session) return { key: 'idle', label: 'Board' };
    if (session.sleeping || session.done) return { key: 'disabled', label: session.done ? 'Complete' : 'Sleeping' };
    if (session.stuck) return { key: 'stuck', label: 'Stuck' };
    if (session.waiting_for_input) return { key: 'waiting', label: 'Waiting' };
    if (_isWorking(session)) return { key: 'working', label: 'Working' };
    return { key: 'idle', label: 'Idle' };
}

function _isWorking(session) {
    if (session.working) return true;
    if (session.sleeping || session.done || session.waiting_for_input || session.stuck) return false;
    if ((session.agent_type || '').toLowerCase() !== 'codex') return false;
    const staleness = Number(session.staleness_seconds);
    return Number.isFinite(staleness) && staleness < 30;
}

function _boardState(sessions) {
    if (!sessions.length) return { key: 'idle', label: 'Quiet' };
    if (sessions.some(session => _agentState(session).key === 'stuck')) return { key: 'stuck', label: 'Attention' };
    if (sessions.some(session => _agentState(session).key === 'waiting')) return { key: 'waiting', label: 'Waiting' };
    if (sessions.some(session => _agentState(session).key === 'working')) return { key: 'working', label: 'Live' };
    if (sessions.every(session => _agentState(session).key === 'disabled')) return { key: 'disabled', label: 'Sleeping' };
    return { key: 'idle', label: 'Standing by' };
}

function _avatar(session) {
    if (session.icon && !session.sleeping) return session.icon;
    if (session.sleeping) return '☾';
    const name = _agentLabel(session).toLowerCase();
    if (name.includes('orchestrator')) return '♛';
    if (name.includes('frontend') || name.includes('design')) return '◒';
    if (name.includes('qa') || name.includes('quality')) return '⌕';
    if (name.includes('security')) return '◇';
    if (name.includes('backend') || name.includes('infra')) return '⚙';
    if (name.includes('lead')) return '⌁';
    if (name.includes('research')) return '◎';
    return '✦';
}

function _agentAliases(session) {
    const values = [
        session?.display_name,
        session?.board_job_title,
        session?.name,
        session?.session_id,
        session?.tmux_session,
        session?.subscriber_id,
    ];
    return [...new Set(values.map(value => _normalise(value || '')).filter(Boolean))];
}

function _normalise(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9@._ -]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function _contextPct(session) {
    const raw = session?.context_pct ?? session?.context_percent ?? session?.context_usage_pct;
    const pct = Number(raw);
    if (Number.isFinite(pct)) return Math.max(0, Math.min(100, Math.round(pct)));
    const used = Number(session?.context_tokens || session?.context_used_tokens);
    const windowSize = Number(session?.context_window);
    if (Number.isFinite(used) && Number.isFinite(windowSize) && windowSize > 0) {
        return Math.max(0, Math.min(100, Math.round((used / windowSize) * 100)));
    }
    return null;
}

function _tokenTotal(session) {
    return ['token_input', 'token_output', 'token_cache_read', 'token_cache_write', 'tokens_total', 'total_tokens']
        .reduce((sum, key) => sum + (Number(session?.[key]) || 0), 0);
}

function _agentTokenSummary(session) {
    const cost = Number(session?.token_cost_usd) || 0;
    const tokens = _tokenTotal(session);
    if (cost > 0 && tokens > 0) return `${_formatTokens(tokens)} · ${_formatCost(cost)}`;
    if (cost > 0) return _formatCost(cost);
    if (tokens > 0) return _formatTokens(tokens);
    return '';
}

function _formatTokens(value) {
    const n = Number(value) || 0;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
    return String(Math.round(n));
}

function _formatCost(value) {
    const n = Number(value) || 0;
    if (n <= 0) return '$0.00';
    if (n < 1) return `$${n.toFixed(3)}`;
    return `$${n.toFixed(2)}`;
}

function _formatMessageTime(iso) {
    if (!iso) return 'unknown time';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return 'unknown time';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function _formatDateTime(iso) {
    if (!iso) return 'unknown';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return 'unknown';
    return date.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function _messageSnippet(content) {
    return String(content || '')
        .replace(/```[\s\S]*?```/g, 'code block')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/[#>*_\[\]()]/g, '')
        .replace(/\s+/g, ' ')
        .trim() || 'Empty board message';
}

function _messageTone(content) {
    const text = String(content || '').toLowerCase();
    if (/\b(blocked|stuck|failed|error|risk|regression|security)\b/.test(text)) return 'risk';
    if (/\b(done|complete|completed|passed|approved|fixed)\b/.test(text)) return 'done';
    if (/@(?:notify-all|all)\b/i.test(text)) return 'broadcast';
    return 'neutral';
}

function _taskTone(task) {
    const status = String(task.status || '').toLowerCase();
    const priority = String(task.priority || '').toLowerCase();
    if (status.includes('blocked') || priority === 'critical' || priority === 'high') return 'risk';
    if (status.includes('done') || status.includes('complete')) return 'done';
    return 'neutral';
}

function _boardBranch(sessions) {
    const withBranch = sessions.find(session => session.branch || session.repo_name);
    if (!withBranch) return '';
    return _repoBranch(withBranch.repo_name, withBranch.branch);
}

function _repoBranch(repoName, branch) {
    if (repoName && branch) return `${repoName} : ${branch}`;
    return branch || repoName || '';
}

function _shortText(text, length) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (value.length <= length) return value;
    return `${value.slice(0, Math.max(0, length - 1)).trim()}...`;
}

function _graphId(value) {
    return _normalise(value).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'board';
}
