/* Agent task bar — CRUD, rendering, drag reorder */

import { state } from './state.js';
import { escapeHtml, escapeAttr, showToast } from './utils.js';

// ── Board task polling ───────────────────────────────────────────────
let _boardTaskPollTimer = null;
const BOARD_TASK_POLL_MS = 3000;
const BOARD_TASK_WS_REFRESH_MS = 2500;
// Live cost cache: taskID → { cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, request_count }
let _liveCosts = {};
let _boardTaskRequestSeq = 0;
let _agentTaskRequestSeq = 0;
let _boardTasksLoading = false;
let _boardTasksInFlight = false;
let _boardTasksError = '';
let _boardTasksBoardName = '';
let _lastBoardTaskRefreshAt = 0;
let _lastBoardTaskRefreshBoard = '';

export function startBoardTaskPoll() {
    stopBoardTaskPoll();
    // Load agent tasks + board tasks immediately, then keep the live ops panel fresh.
    if (state.currentSession && state.currentSession.type === 'live') {
        loadAgentTasks(state.currentSession.name, state.currentSession.session_id);
    }
    _pollBoardTasksOnce();
    _boardTaskPollTimer = setInterval(_pollBoardTasksOnce, BOARD_TASK_POLL_MS);
}

export function stopBoardTaskPoll() {
    if (_boardTaskPollTimer) {
        clearInterval(_boardTaskPollTimer);
        _boardTaskPollTimer = null;
    }
}

async function _pollBoardTasksOnce() {
    if (!state.currentSession || state.currentSession.type !== 'live') return;
    const boardProject = state.currentSession.board_project || state.currentSession.name;
    if (boardProject) {
        await loadBoardTasks(boardProject, { quiet: true });
        _fetchLiveCosts(boardProject);
    }
}

async function _fetchLiveCosts(boardProject) {
    const tasks = state.currentBoardTasks || [];
    const inProgress = tasks.filter(t => t.status === 'in_progress' && t.session_id);
    if (inProgress.length === 0) {
        _liveCosts = {};
        return;
    }
    const newCosts = {};
    await Promise.all(inProgress.map(async (t) => {
        try {
            const resp = await fetch(`/api/board/${encodeURIComponent(boardProject)}/tasks/${t.id}/cost`);
            if (resp.ok) {
                const data = await resp.json();
                if (data) newCosts[t.id] = data;
            }
        } catch { /* ignore */ }
    }));
    _liveCosts = newCosts;
    renderBoardTaskList();
}

export async function loadAgentTasks(agentName, sessionId) {
    if (!agentName) return;
    const requestSeq = ++_agentTaskRequestSeq;
    const expectedSessionId = sessionId || (state.currentSession && state.currentSession.session_id) || '';
    try {
        const params = new URLSearchParams();
        const sid = expectedSessionId;
        if (sid) params.set("session_id", sid);
        const qs = params.toString() ? `?${params}` : "";
        const resp = await fetch(`/api/sessions/live/${encodeURIComponent(agentName)}/tasks${qs}`);
        if (!resp.ok) throw new Error(`tasks fetch failed: ${resp.status}`);
        if (_isStaleAgentTaskResponse(requestSeq, agentName, expectedSessionId)) return;
        state.currentAgentTasks = await resp.json();
    } catch (e) {
        if (_isStaleAgentTaskResponse(requestSeq, agentName, expectedSessionId)) return;
        state.currentAgentTasks = [];
    }
    renderTaskList();
}

export async function addAgentTask() {
    if (!state.currentSession || state.currentSession.type !== 'live') return;
    const input = document.getElementById('task-bar-input');
    const title = input.value.trim();
    if (!title) return;

    try {
        const sid = state.currentSession.session_id;
        await fetch(`/api/sessions/live/${encodeURIComponent(state.currentSession.name)}/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, session_id: sid }),
        });
        input.value = '';
        await loadAgentTasks(state.currentSession.name, sid);
    } catch (e) {
        showToast('Failed to add task', true);
    }
}

export async function toggleAgentTask(taskId, completed) {
    if (!state.currentSession || state.currentSession.type !== 'live') return;
    try {
        await fetch(`/api/sessions/live/${encodeURIComponent(state.currentSession.name)}/tasks/${taskId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ completed: completed ? 1 : 0 }),
        });
        await loadAgentTasks(state.currentSession.name, state.currentSession.session_id);
    } catch (e) {
        showToast('Failed to update task', true);
    }
}

export async function deleteAgentTask(taskId) {
    if (!state.currentSession || state.currentSession.type !== 'live') return;
    try {
        await fetch(`/api/sessions/live/${encodeURIComponent(state.currentSession.name)}/tasks/${taskId}`, {
            method: 'DELETE',
        });
        await loadAgentTasks(state.currentSession.name, state.currentSession.session_id);
    } catch (e) {
        showToast('Failed to delete task', true);
    }
}

export function editAgentTaskTitle(taskId, spanEl) {
    if (!state.currentSession || state.currentSession.type !== 'live') return;
    const original = spanEl.textContent;
    spanEl.contentEditable = 'true';
    spanEl.focus();

    // Select all text
    const range = document.createRange();
    range.selectNodeContents(spanEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const finish = async () => {
        spanEl.contentEditable = 'false';
        const newTitle = spanEl.textContent.trim();
        if (!newTitle || newTitle === original) {
            spanEl.textContent = original;
            return;
        }
        try {
            await fetch(`/api/sessions/live/${encodeURIComponent(state.currentSession.name)}/tasks/${taskId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: newTitle }),
            });
            await loadAgentTasks(state.currentSession.name, state.currentSession.session_id);
        } catch (e) {
            spanEl.textContent = original;
            showToast('Failed to update task title', true);
        }
    };

    spanEl.addEventListener('blur', finish, { once: true });
    spanEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            spanEl.blur();
        } else if (e.key === 'Escape') {
            spanEl.textContent = original;
            spanEl.blur();
        }
    });
}

export function renderTaskList() {
    // Agent tasks are now rendered in the unified board task table.
    // Trigger a re-render of the unified table to include updated agent tasks.
    renderBoardTaskList();
}

function initTaskDragReorder() {
    const list = document.getElementById('task-bar-list');
    if (!list) return;

    let dragItem = null;

    list.querySelectorAll('.task-item').forEach(item => {
        item.addEventListener('dragstart', (e) => {
            dragItem = item;
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        });

        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
            dragItem = null;
            // Save new order
            saveTaskOrder();
        });

        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (!dragItem || dragItem === item) return;

            const rect = item.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            if (e.clientY < midY) {
                list.insertBefore(dragItem, item);
            } else {
                list.insertBefore(dragItem, item.nextSibling);
            }
        });
    });
}

/* ── Board Tasks ────────────────────────────────────────── */

export async function loadBoardTasks(boardName, options = {}) {
    const quiet = !!options.quiet;
    const normalizedBoardName = boardName || '';
    if (quiet && _boardTasksInFlight) return;
    const requestSeq = ++_boardTaskRequestSeq;
    _boardTasksBoardName = normalizedBoardName;
    _boardTasksError = '';

    if (!boardName) {
        _boardTasksLoading = false;
        state.currentBoardTasks = [];
        renderBoardTaskList();
        return;
    }

    _boardTasksLoading = !quiet;
    _boardTasksInFlight = true;
    _lastBoardTaskRefreshAt = Date.now();
    _lastBoardTaskRefreshBoard = normalizedBoardName;
    if (!quiet) renderBoardTaskList();

    try {
        const resp = await fetch(`/api/board/${encodeURIComponent(boardName)}/tasks`);
        if (!resp.ok) throw new Error(`board tasks fetch failed: ${resp.status}`);
        const data = await resp.json();
        if (_isStaleBoardTaskResponse(requestSeq, normalizedBoardName)) return;
        state.currentBoardTasks = data.tasks || [];
    } catch (e) {
        if (_isStaleBoardTaskResponse(requestSeq, normalizedBoardName)) return;
        state.currentBoardTasks = [];
        _boardTasksError = e && e.message ? e.message : 'Failed to load tasks';
    } finally {
        _boardTasksInFlight = false;
        if (!_isStaleBoardTaskResponse(requestSeq, normalizedBoardName)) {
            _boardTasksLoading = false;
        }
    }
    renderBoardTaskList();
}

export function refreshCurrentTaskPanelFromLiveSessions() {
    renderBoardTaskList();
    _maybeRefreshBoardTasksFromLiveUpdate();
}

function _maybeRefreshBoardTasksFromLiveUpdate() {
    if (!_isTasksPanelActive()) return;
    if (!state.currentSession || state.currentSession.type !== 'live') return;
    if (_boardTasksLoading) return;
    const boardProject = _currentBoardProject();
    if (!boardProject) return;

    const now = Date.now();
    if (
        boardProject === _lastBoardTaskRefreshBoard
        && now - _lastBoardTaskRefreshAt < BOARD_TASK_WS_REFRESH_MS
    ) {
        return;
    }

    loadBoardTasks(boardProject, { quiet: true }).then(() => _fetchLiveCosts(boardProject));
}

function _isTasksPanelActive() {
    const panel = document.getElementById('agentic-panel-tasks');
    return !!(panel && panel.classList.contains('active'));
}

// Current sort and filter state for task list
let _taskSortField = 'created_at';
let _taskSortAsc = false; // default newest first
let _hideCompleted = localStorage.getItem('coral-hide-completed') === 'true'; // off by default, persisted

function _toggleTaskSort(field) {
    if (_taskSortField === field) {
        _taskSortAsc = !_taskSortAsc;
    } else {
        _taskSortField = field;
        _taskSortAsc = field === 'priority'; // priority defaults asc (critical first)
    }
    renderBoardTaskList();
}

function _toggleHideCompleted() {
    _hideCompleted = !_hideCompleted;
    localStorage.setItem('coral-hide-completed', _hideCompleted);
    renderBoardTaskList();
}

// Expose globally
window._toggleTaskSort = _toggleTaskSort;
window._toggleHideCompleted = _toggleHideCompleted;

function _currentBoardProject() {
    if (!state.currentSession) return '';
    return state.currentSession.board_project || state.currentSession.name || '';
}
window._currentBoardProjectForTasks = _currentBoardProject;

function _isStaleBoardTaskResponse(requestSeq, boardName) {
    return requestSeq !== _boardTaskRequestSeq || boardName !== _currentBoardProject();
}

function _isStaleAgentTaskResponse(requestSeq, agentName, sessionId) {
    if (requestSeq !== _agentTaskRequestSeq) return true;
    if (!state.currentSession) return true;
    if (state.currentSession.name !== agentName) return true;
    const currentSessionId = state.currentSession.session_id || '';
    return sessionId && currentSessionId && sessionId !== currentSessionId;
}

const _priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };

function _formatCost(usd, precise) {
    if (usd == null) return '$0.00';
    if (usd === 0) return '$0.00';
    if (precise) {
        // Detail view: up to 4 decimal places, trim trailing zeros (keep at least 2)
        const s = usd.toFixed(4);
        return '$' + s.replace(/0{1,2}$/, '');
    }
    // Badge: show 2 decimals, but use <$0.01 for sub-cent costs
    if (usd > 0 && usd < 0.01) return '<$0.01';
    return '$' + usd.toFixed(2);
}

function _formatTokenCount(n) {
    if (n == null) return '0';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return n.toLocaleString();
}

function _formatTaskTime(ts) {
    if (!ts) return '';
    try {
        const d = new Date(ts);
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
            + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
}

export function renderBoardTaskList() {
    const container = document.getElementById('board-task-list');
    if (!container) return;
    const section = document.getElementById('board-tasks-section');
    if (section) section.style.display = '';

    const boardProject = _currentBoardProject();
    const liveAgents = _liveAgentsForBoard(boardProject);
    const liveAgentByName = _liveAgentMap(liveAgents);

    // Merge formal board tasks, local agent checklist rows, and live agent
    // activity into one operational table. Board tasks remain the source of
    // truth, while live activity explains why a task may appear stale.
    const boardTasks = (state.currentBoardTasks || []).map(t => {
        const liveSession = _agentForAssignee(liveAgentByName, t.assigned_to);
        return {
            ...t,
            _source: 'board',
            _liveSession: liveSession,
            _liveState: liveSession ? _agentState(liveSession) : (t.assigned_to ? 'missing' : null),
        };
    });
    const agentDisplayName = state.currentSession ? (state.currentSession.display_name || state.currentSession.name) : '';
    const agentTasks = (state.currentAgentTasks || []).map(t => ({
        ...t,
        _source: 'agent',
        // Normalize agent task fields to match board task shape
        status: t.completed === 1 ? 'completed' : t.completed === 2 ? 'in_progress' : 'pending',
        priority: null,
        assigned_to: t.display_name || t.agent_name || agentDisplayName || null,
        created_at: t.created_at,
    }));

    const formalTasks = [...boardTasks, ...agentTasks];
    const liveActivityRows = _buildLiveActivityRows(liveAgents, formalTasks);
    const allTasks = [...formalTasks, ...liveActivityRows];
    const completedCount = formalTasks.filter(t => t.status === 'completed' || t.status === 'skipped').length;
    const tasks = allTasks.filter(t => {
        if (_hideCompleted && (t.status === 'completed' || t.status === 'skipped')) return false;
        return true;
    }).sort((a, b) => {
        let cmp = 0;
        if (_taskSortField === 'created_at') {
            cmp = (a.created_at || '').localeCompare(b.created_at || '');
        } else if (_taskSortField === 'priority') {
            cmp = (_priorityOrder[a.priority] ?? 2) - (_priorityOrder[b.priority] ?? 2);
        } else if (_taskSortField === 'assignee') {
            cmp = (a.assigned_to || '').localeCompare(b.assigned_to || '');
        } else if (_taskSortField === 'cost') {
            const aCost = a.cost_usd ?? -1;
            const bCost = b.cost_usd ?? -1;
            cmp = aCost - bCost;
        } else if (_taskSortField === 'type') {
            cmp = (a._source || '').localeCompare(b._source || '');
        }
        return _taskSortAsc ? cmp : -cmp;
    });

    const arrow = (field) => _taskSortField === field ? (_taskSortAsc ? ' ▲' : ' ▼') : '';

    // Render hide-done toggle in the section header
    const toggleContainer = document.getElementById('board-task-hide-toggle-container');
    if (toggleContainer) {
        toggleContainer.innerHTML = completedCount > 0
            ? `<label class="board-task-hide-toggle"><input type="checkbox" ${_hideCompleted ? 'checked' : ''} onchange="_toggleHideCompleted()"> Hide done (${completedCount})</label>`
            : '';
    }

    // Update section header to "Tasks" instead of "Board Tasks"
    const headerLabel = section ? section.querySelector('.board-tasks-header > span:first-child') : null;
    if (headerLabel) headerLabel.textContent = 'Tasks';

    const countEl = document.getElementById('task-bar-count');
    if (countEl) {
        const doneCount = formalTasks.filter(t => t.status === 'completed' || t.status === 'skipped').length;
        countEl.textContent = formalTasks.length > 0 ? `${doneCount}/${formalTasks.length}` : '';
    }

    if (_boardTasksLoading && allTasks.length === 0) {
        container.innerHTML = _renderTaskState({
            icon: 'hourglass_top',
            title: 'Loading tasks',
            body: _boardTasksBoardName
                ? `Reading board tasks for ${escapeHtml(_boardTasksBoardName)}.`
                : 'Reading the current agent task list.',
        });
        return;
    }

    if (_boardTasksError && allTasks.length === 0) {
        container.innerHTML = _renderTaskState({
            icon: 'warning',
            title: 'Tasks unavailable',
            body: escapeHtml(_boardTasksError),
            tone: 'error',
            action: '<button class="btn btn-sm" onclick="loadBoardTasks(window._currentBoardProjectForTasks())">Retry</button>',
        });
        return;
    }

    if (allTasks.length === 0) {
        const boardName = _currentBoardProject();
        container.innerHTML = _renderTaskState({
            icon: 'checklist',
            title: 'No tasks yet',
            body: boardName
                ? `No board or agent tasks are currently assigned for ${escapeHtml(boardName)}.`
                : 'Select a live agent to inspect board and local tasks.',
            action: boardName
                ? '<button class="btn btn-sm" onclick="showCreateTaskModal()">Create task</button>'
                : '',
        });
        return;
    }

    const header = `
        <div class="board-task-item board-task-header">
            <span class="board-task-status-col"></span>
            <span class="board-task-priority board-task-sort" onclick="_toggleTaskSort('priority')">Priority${arrow('priority')}</span>
            <span class="board-task-type board-task-sort" onclick="_toggleTaskSort('type')">Type${arrow('type')}</span>
            <span class="board-task-assignee board-task-sort" onclick="_toggleTaskSort('assignee')">Agent${arrow('assignee')}</span>
            <span class="board-task-desc board-task-sort" onclick="_toggleTaskSort('created_at')">Task${arrow('created_at')}</span>
            <span class="board-task-cost board-task-sort" onclick="_toggleTaskSort('cost')">Cost${arrow('cost')}</span>
            <span class="board-task-time board-task-sort" onclick="_toggleTaskSort('created_at')">Created${arrow('created_at')}</span>
        </div>`;

    if (tasks.length === 0) {
        container.innerHTML = header + _renderTaskState({
            icon: 'visibility_off',
            title: 'All tasks are hidden',
            body: 'Completed tasks are hidden by the current filter.',
            action: '<button class="btn btn-sm" onclick="_toggleHideCompleted()">Show done</button>',
        });
        return;
    }

    const rows = tasks.map(t => {
        const isAgent = t._source === 'agent';
        const isLive = t._source === 'live';
        const staleBoardTask = t.status === 'in_progress' && t._liveState
            && (t._liveState === 'idle' || t._liveState === 'disabled' || t._liveState === 'missing');
        const statusClass = staleBoardTask ? 'stale'
            : t.status === 'completed' ? 'completed'
            : t.status === 'in_progress' ? 'in-progress'
            : t.status === 'working' ? 'in-progress'
            : t.status === 'waiting' ? 'waiting'
            : t.status === 'stuck' ? 'blocked'
            : t.status === 'idle' || t.status === 'disabled' ? 'idle'
            : t.status === 'skipped' ? 'completed'
            : t.status === 'blocked' ? 'blocked'
            : t.status === 'draft' ? 'draft' : '';
        const priorityClass = t.priority ? 'board-task-priority-' + t.priority : 'board-task-priority-none';
        const assignee = t.assigned_to || '\u2014';
        const assigneeHtml = `${escapeHtml(assignee)}${_agentStateChip(t)}`;
        const title = escapeHtml(t.title || t.description || '');
        const tooltip = t.body ? ` title="${escapeAttr(t.body)}"` : '';
        const timeStr = _formatTaskTime(t.created_at);
        const statusIcon = staleBoardTask
            ? '<span class="material-icons board-task-status-icon stale" title="Board task is in progress, but this agent currently looks idle">pause_circle</span>'
            : t.status === 'completed'
            ? '<span class="material-icons board-task-status-icon completed">check_circle</span>'
            : t.status === 'in_progress' || t.status === 'working'
            ? '<span class="task-spinner" title="In progress"></span>'
            : t.status === 'waiting'
            ? '<span class="material-icons board-task-status-icon waiting" title="Waiting for input">hourglass_top</span>'
            : t.status === 'skipped'
            ? '<span class="material-icons board-task-status-icon skipped">block</span>'
            : t.status === 'blocked' || t.status === 'stuck'
            ? '<span class="material-icons board-task-status-icon blocked" title="Blocked">lock</span>'
            : t.status === 'draft'
            ? '<span class="material-icons board-task-status-icon draft" title="Draft">edit_note</span>'
            : t.status === 'disabled'
            ? '<span class="material-icons board-task-status-icon disabled" title="Sleeping or done">pause_circle</span>'
            : '<span class="material-icons board-task-status-icon pending">radio_button_unchecked</span>';
        let costText = '';
        let costClass = 'board-task-cost';
        if (isAgent && t.cost_usd > 0) {
            costText = _formatCost(t.cost_usd, false);
            if (t.cost_usd >= 1.0) costClass += ' board-task-cost-warning';
        } else if ((t.status === 'completed' || t.status === 'skipped') && t.cost_usd != null) {
            costText = _formatCost(t.cost_usd, false);
            if (t.cost_usd >= 1.0) costClass += ' board-task-cost-warning';
        } else if (t.status === 'in_progress' && _liveCosts[t.id]) {
            const lc = _liveCosts[t.id];
            costText = '~' + _formatCost(lc.cost_usd, false);
            costClass += ' board-task-cost-live';
            if (lc.cost_usd >= 1.0) costClass += ' board-task-cost-warning';
        } else if (isLive && t.cost_usd > 0) {
            costText = _formatCost(t.cost_usd, false);
        }
        const clickHandler = isAgent ? ''
            : isLive && t.session_id
            ? ` onclick="selectLiveSession('${escapeAttr(t.session_name || '')}', '${escapeAttr(t.agent_type || '')}', '${escapeAttr(t.session_id || '')}')" style="cursor:pointer"`
            : ` onclick="showTaskDetailModal(${t.id})" style="cursor:pointer"`;
        return `
        <div class="board-task-item ${statusClass}${isLive ? ' board-task-live-row' : ''}"${clickHandler}>
            ${statusIcon}
            <span class="board-task-priority ${priorityClass}">${t.priority ? escapeHtml(t.priority) : '\u2014'}</span>
            <span class="board-task-type">${isLive ? 'live' : isAgent ? 'agent' : 'board'}</span>
            <span class="board-task-assignee">${assigneeHtml}</span>
            <span class="board-task-desc"${tooltip}>${title}</span>
            <span class="${costClass}">${costText}</span>
            <span class="board-task-time">${isLive ? escapeHtml(t.last_activity || '') : timeStr}</span>
        </div>`;
    }).join('');

    container.innerHTML = header + rows;
}

function _liveAgentsForBoard(boardProject) {
    if (!boardProject) return [];
    return (state.liveSessions || [])
        .filter(s => (s.board_project || s.board_name || '') === boardProject)
        .filter(s => s.agent_type !== 'terminal');
}

function _liveAgentMap(liveAgents) {
    const map = new Map();
    liveAgents.forEach(s => {
        _agentKeys(s).forEach(key => {
            if (key && !map.has(key)) map.set(key, s);
        });
    });
    return map;
}

function _agentForAssignee(map, assignee) {
    const key = _normalizeAgentKey(assignee);
    return key ? map.get(key) || null : null;
}

function _agentKeys(s) {
    return [
        s.display_name,
        s.board_job_title,
        s.subscriber_id,
        s.name,
    ].map(_normalizeAgentKey).filter(Boolean);
}

function _normalizeAgentKey(value) {
    return (value || '').toString().trim().toLowerCase();
}

function _agentState(s) {
    if (!s) return 'idle';
    if (s.done || s.sleeping) return 'disabled';
    if (s.stuck) return 'stuck';
    if (s.waiting_for_input) return 'waiting';
    const provider = (s.agent_type || '').toLowerCase();
    const recentlyActiveCodex = provider === 'codex'
        && Number.isFinite(Number(s.staleness_seconds))
        && Number(s.staleness_seconds) < 30
        && !/task complete/i.test(s.status || '');
    if (s.working || recentlyActiveCodex) return 'working';
    return 'idle';
}

function _buildLiveActivityRows(liveAgents, formalTasks) {
    const hasFormalFor = new Set(
        formalTasks
            .filter(t => t.assigned_to)
            .map(t => _normalizeAgentKey(t.assigned_to))
    );

    return liveAgents.map(s => {
        const label = s.display_name || s.board_job_title || s.name || 'Agent';
        const stateName = _agentState(s);
        const hasFormal = hasFormalFor.has(_normalizeAgentKey(label));
        return {
            id: `live-${s.session_id || s.name || label}`,
            _source: 'live',
            status: stateName,
            priority: null,
            assigned_to: label,
            title: _liveActivityTitle(s, stateName, hasFormal),
            body: s.summary || s.status || '',
            created_at: '',
            cost_usd: Number(s.token_cost_usd || 0),
            session_id: s.session_id || '',
            session_name: s.name || '',
            agent_type: s.agent_type || '',
            last_activity: _formatLiveAge(s.staleness_seconds),
            _liveState: stateName,
        };
    });
}

function _liveActivityTitle(s, stateName, hasFormal) {
    const summary = (s.summary || s.status || '').trim();
    if (summary) return summary;
    if (stateName === 'working') return hasFormal ? 'Working on assigned board task' : 'Working through the current turn';
    if (stateName === 'waiting') return s.waiting_summary || 'Waiting for operator input';
    if (stateName === 'stuck') return 'Needs attention before work can continue';
    if (stateName === 'disabled') return s.sleeping ? 'Sleeping' : 'Session complete';
    return hasFormal ? 'Idle with task context visible' : 'Idle, no active task claimed';
}

function _formatLiveAge(seconds) {
    const n = Number(seconds);
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 5) return 'now';
    if (n < 60) return `${Math.round(n)}s ago`;
    if (n < 3600) return `${Math.round(n / 60)}m ago`;
    return `${Math.round(n / 3600)}h ago`;
}

function _agentStateChip(task) {
    const stateName = task._liveState;
    if (!stateName) return '';
    const label = stateName === 'disabled' ? 'off' : stateName === 'missing' ? 'no live' : stateName;
    return `<span class="board-task-agent-state board-task-agent-state-${escapeAttr(stateName)}">${escapeHtml(label)}</span>`;
}

function _renderTaskState({ icon, title, body, tone = '', action = '' }) {
    return `
        <div class="board-task-state ${tone ? `board-task-state-${tone}` : ''}">
            <span class="material-icons board-task-state-icon">${escapeHtml(icon)}</span>
            <div class="board-task-state-title">${escapeHtml(title)}</div>
            <div class="board-task-state-body">${body}</div>
            ${action ? `<div class="board-task-state-action">${action}</div>` : ''}
        </div>`;
}

/* ── Dependency Picker ─────────────────────────────────── */

function _renderDepPicker(containerId, selectedIds = [], excludeTaskId = null) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const tasks = (state.currentBoardTasks || []).filter(t =>
        t.status !== 'completed' && t.status !== 'skipped' && t.id !== excludeTaskId
    );
    const selected = new Set(selectedIds.map(Number));

    let html = `<div class="dep-picker-selected" id="${containerId}-tags"></div>`;
    html += `<div class="dep-picker-toggle"><a class="dep-picker-add-link" onclick="document.getElementById('${containerId}-list').style.display = document.getElementById('${containerId}-list').style.display === 'none' ? '' : 'none'">+ Add dependency</a></div>`;
    html += `<div class="dep-picker-list" id="${containerId}-list" style="display:none">`;
    if (tasks.length === 0) {
        html += `<div class="dep-picker-empty">No eligible tasks</div>`;
    } else {
        tasks.forEach(t => {
            const checked = selected.has(t.id) ? ' checked' : '';
            html += `<label class="dep-picker-item"><input type="checkbox" value="${t.id}"${checked} onchange="window._updateDepTags('${containerId}')"> #${t.id} — ${escapeHtml(t.title || '')}</label>`;
        });
    }
    html += `</div>`;
    container.innerHTML = html;
    window._updateDepTags(containerId);
}

window._updateDepTags = function(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const tagsEl = document.getElementById(`${containerId}-tags`);
    if (!tagsEl) return;
    const checked = container.querySelectorAll('input[type="checkbox"]:checked');
    if (checked.length === 0) {
        tagsEl.innerHTML = '';
        return;
    }
    const tags = Array.from(checked).map(cb => {
        const label = cb.parentElement.textContent.trim();
        return `<span class="dep-tag">${escapeHtml(label)} <a onclick="document.querySelector('#${containerId} input[value=\\'${cb.value}\\']').click()">&times;</a></span>`;
    }).join('');
    tagsEl.innerHTML = tags;
};

function _getSelectedDeps(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return [];
    return Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map(cb => parseInt(cb.value));
}

/* ── Create Task Modal ─────────────────────────────────── */

export async function showCreateTaskModal() {
    const modal = document.getElementById('create-task-modal');
    if (!modal) return;

    // Reset form
    document.getElementById('create-task-title').value = '';
    document.getElementById('create-task-body').value = '';
    document.getElementById('create-task-priority').value = 'medium';
    const draftCheck = document.getElementById('create-task-draft');
    if (draftCheck) draftCheck.checked = false;
    const errEl = document.getElementById('create-task-error');
    if (errEl) errEl.style.display = 'none';

    // Populate assignee dropdown from board subscribers
    const assigneeSelect = document.getElementById('create-task-assignee');
    assigneeSelect.innerHTML = '<option value="">Unassigned</option>';
    const boardProject = _getBoardProject();
    if (boardProject) {
        try {
            const resp = await fetch(`/api/board/${encodeURIComponent(boardProject)}/subscribers`);
            if (resp.ok) {
                const subs = await resp.json();
                (subs || []).forEach(s => {
                    const name = s.subscriber_id || s.name;
                    if (name) {
                        const opt = document.createElement('option');
                        opt.value = name;
                        opt.textContent = name;
                        assigneeSelect.appendChild(opt);
                    }
                });
            }
        } catch { /* ignore */ }
    }

    // Populate dependency picker
    _renderDepPicker('create-task-deps');

    modal.style.display = '';
    document.getElementById('create-task-title').focus();

    modal.onclick = (e) => { if (e.target === modal) hideCreateTaskModal(); };
    modal._escHandler = (e) => { if (e.key === 'Escape') hideCreateTaskModal(); };
    document.addEventListener('keydown', modal._escHandler);
}

export function hideCreateTaskModal() {
    const modal = document.getElementById('create-task-modal');
    if (!modal) return;
    modal.style.display = 'none';
    if (modal._escHandler) {
        document.removeEventListener('keydown', modal._escHandler);
        modal._escHandler = null;
    }
}

export async function submitCreateTask() {
    const title = document.getElementById('create-task-title').value.trim();
    const errEl = document.getElementById('create-task-error');

    if (!title) {
        if (errEl) {
            errEl.textContent = 'Title is required';
            errEl.style.display = '';
        }
        return;
    }

    const body = document.getElementById('create-task-body').value.trim();
    const priority = document.getElementById('create-task-priority').value;
    const assignedTo = document.getElementById('create-task-assignee').value;
    const boardProject = _getBoardProject();
    if (!boardProject) {
        if (errEl) {
            errEl.textContent = 'No board project found';
            errEl.style.display = '';
        }
        return;
    }

    const blockedBy = _getSelectedDeps('create-task-deps');
    const isDraft = document.getElementById('create-task-draft')?.checked || false;

    try {
        const payload = {
            title,
            body,
            priority,
            assigned_to: assignedTo,
            created_by: 'Operator',
        };
        if (blockedBy.length > 0) payload.blocked_by = blockedBy;
        if (isDraft) payload.draft = true;
        const resp = await fetch(`/api/board/${encodeURIComponent(boardProject)}/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!resp.ok) {
            const data = await resp.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${resp.status}`);
        }
        hideCreateTaskModal();
        await loadBoardTasks(boardProject);
        showToast('Task created');
    } catch (e) {
        if (errEl) {
            errEl.textContent = e.message || 'Failed to create task';
            errEl.style.display = '';
        }
    }
}

function _getBoardProject() {
    if (!state.currentSession) return null;
    return state.currentSession.board_project || state.currentSession.name;
}

/* ── Task Detail Modal ─────────────────────────────────── */

export function showTaskDetailModal(taskId) {
    const tasks = state.currentBoardTasks || [];
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;

    const modal = document.getElementById('task-detail-modal');
    const titleEl = document.getElementById('task-detail-modal-title');
    const content = document.getElementById('task-detail-content');
    if (!modal || !content) return;

    titleEl.textContent = `Task #${task.id}`;

    const statusLabel = task.status === 'completed' ? 'Completed'
        : task.status === 'in_progress' ? 'In Progress'
        : task.status === 'skipped' ? 'Cancelled'
        : task.status === 'blocked' ? 'Blocked'
        : task.status === 'draft' ? 'Draft'
        : 'Pending';
    const statusClass = task.status === 'completed' ? 'task-detail-status-completed'
        : task.status === 'in_progress' ? 'task-detail-status-inprogress'
        : task.status === 'skipped' ? 'task-detail-status-cancelled'
        : task.status === 'blocked' ? 'task-detail-status-blocked'
        : task.status === 'draft' ? 'task-detail-status-draft'
        : 'task-detail-status-pending';
    const priorityClass = 'board-task-priority-' + (task.priority || 'medium');

    const assignee = task.assigned_to || '\u2014';
    const createdBy = task.created_by || '\u2014';
    const createdAt = task.created_at ? formatTaskDate(task.created_at) : '\u2014';
    const claimedAt = task.claimed_at ? formatTaskDate(task.claimed_at) : null;
    const completedAt = task.completed_at ? formatTaskDate(task.completed_at) : null;
    const completedBy = task.completed_by || null;

    let html = `
        <div class="task-detail-title">${escapeHtml(task.title)}</div>
        <div class="task-detail-meta">
            <span class="task-detail-status ${statusClass}">${statusLabel}</span>
            <span class="board-task-priority ${priorityClass}">${escapeHtml(task.priority || 'medium')}</span>
        </div>`;

    if (task.body) {
        html += `<div class="task-detail-section">
            <div class="task-detail-label">Description</div>
            <div class="task-detail-body">${escapeHtml(task.body)}</div>
        </div>`;
    }

    html += `<div class="task-detail-fields">
        <div class="task-detail-field">
            <span class="task-detail-label">Assigned To</span>
            <span class="task-detail-value">${escapeHtml(assignee)}</span>
        </div>
        <div class="task-detail-field">
            <span class="task-detail-label">Created By</span>
            <span class="task-detail-value">${escapeHtml(createdBy)}</span>
        </div>
        <div class="task-detail-field">
            <span class="task-detail-label">Created</span>
            <span class="task-detail-value">${createdAt}</span>
        </div>`;

    if (claimedAt) {
        html += `<div class="task-detail-field">
            <span class="task-detail-label">Claimed</span>
            <span class="task-detail-value">${claimedAt}</span>
        </div>`;
    }
    if (completedAt) {
        html += `<div class="task-detail-field">
            <span class="task-detail-label">${task.status === 'skipped' ? 'Cancelled' : 'Completed'}</span>
            <span class="task-detail-value">${completedAt}</span>
        </div>`;
    }
    if (completedBy) {
        html += `<div class="task-detail-field">
            <span class="task-detail-label">${task.status === 'skipped' ? 'Cancelled By' : 'Completed By'}</span>
            <span class="task-detail-value">${escapeHtml(completedBy)}</span>
        </div>`;
    }
    if (task.completion_message) {
        html += `<div class="task-detail-field task-detail-field-wide">
            <span class="task-detail-label">Message</span>
            <span class="task-detail-value">${escapeHtml(task.completion_message)}</span>
        </div>`;
    }

    html += `</div>`;

    // Blocked by dependencies
    if (task.blocked_by && task.blocked_by.length > 0) {
        const boardProject = _getBoardProject();
        const depsHtml = task.blocked_by.map(dep => {
            const depStatusClass = dep.status === 'completed' ? 'task-dep-status-completed'
                : dep.status === 'in_progress' ? 'task-dep-status-inprogress'
                : dep.status === 'skipped' ? 'task-dep-status-cancelled'
                : dep.status === 'blocked' ? 'task-dep-status-blocked'
                : dep.status === 'draft' ? 'task-dep-status-draft'
                : 'task-dep-status-pending';
            const depStatusLabel = dep.status === 'completed' ? 'completed'
                : dep.status === 'in_progress' ? 'in progress'
                : dep.status === 'skipped' ? 'cancelled'
                : dep.status === 'blocked' ? 'blocked'
                : dep.status === 'draft' ? 'draft'
                : 'pending';
            const isCrossBoard = dep.board_id && dep.board_id !== boardProject;
            const boardPrefix = isCrossBoard ? `${escapeHtml(dep.board_id)} ` : '';
            const depTitle = dep.title ? ` — ${escapeHtml(dep.title)}` : '';
            const clickable = !isCrossBoard ? ` onclick="showTaskDetailModal(${dep.task_id})" style="cursor:pointer"` : '';
            return `<div class="task-dep-item">
                <span class="task-dep-status ${depStatusClass}">${depStatusLabel}</span>
                <a class="task-dep-link"${clickable}>${boardPrefix}#${dep.task_id}${depTitle}</a>
            </div>`;
        }).join('');
        html += `<div class="task-detail-section">
            <div class="task-detail-label">Blocked By</div>
            <div class="task-deps-list">${depsHtml}</div>
        </div>`;
    }

    // Cost & token breakdown for completed tasks with cost data
    if (task.cost_usd != null) {
        const warningClass = task.cost_usd >= 1.0 ? ' board-task-cost-warning' : '';
        html += `<div class="task-detail-section">
            <div class="task-detail-label">Cost</div>
            <div class="task-detail-cost-summary${warningClass}">${_formatCost(task.cost_usd, true)}</div>
            <div class="task-detail-tokens">
                <div class="task-detail-token-item">
                    <span class="task-detail-token-label">Input</span>
                    <span class="task-detail-token-value">${_formatTokenCount(task.input_tokens)}</span>
                </div>
                <div class="task-detail-token-item">
                    <span class="task-detail-token-label">Output</span>
                    <span class="task-detail-token-value">${_formatTokenCount(task.output_tokens)}</span>
                </div>
                <div class="task-detail-token-item">
                    <span class="task-detail-token-label">Cache Read</span>
                    <span class="task-detail-token-value">${_formatTokenCount(task.cache_read_tokens)}</span>
                </div>
                <div class="task-detail-token-item">
                    <span class="task-detail-token-label">Cache Write</span>
                    <span class="task-detail-token-value">${_formatTokenCount(task.cache_write_tokens)}</span>
                </div>
            </div>
        </div>`;
    }
    // Live cost for in-progress tasks
    if (task.status === 'in_progress' && _liveCosts[task.id]) {
        const lc = _liveCosts[task.id];
        const warningClass = lc.cost_usd >= 1.0 ? ' board-task-cost-warning' : '';
        html += `<div class="task-detail-section">
            <div class="task-detail-label">Running Cost</div>
            <div class="task-detail-cost-summary board-task-cost-live${warningClass}">~${_formatCost(lc.cost_usd, true)}</div>
            <div class="task-detail-tokens">
                <div class="task-detail-token-item">
                    <span class="task-detail-token-label">Input</span>
                    <span class="task-detail-token-value">${_formatTokenCount(lc.input_tokens)}</span>
                </div>
                <div class="task-detail-token-item">
                    <span class="task-detail-token-label">Output</span>
                    <span class="task-detail-token-value">${_formatTokenCount(lc.output_tokens)}</span>
                </div>
                <div class="task-detail-token-item">
                    <span class="task-detail-token-label">Cache Read</span>
                    <span class="task-detail-token-value">${_formatTokenCount(lc.cache_read_tokens)}</span>
                </div>
                <div class="task-detail-token-item">
                    <span class="task-detail-token-label">Cache Write</span>
                    <span class="task-detail-token-value">${_formatTokenCount(lc.cache_write_tokens)}</span>
                </div>
            </div>
            <div class="task-detail-token-item" style="margin-top:4px;opacity:0.6">
                <span class="task-detail-token-label">Requests</span>
                <span class="task-detail-token-value">${lc.request_count}</span>
            </div>
        </div>`;
    }
    content.innerHTML = html;

    // Update footer with action buttons for editable tasks
    const footer = document.getElementById('task-detail-modal-footer');
    if (footer) {
        const isEditable = task.status === 'pending' || task.status === 'in_progress' || task.status === 'blocked' || task.status === 'draft';
        if (isEditable) {
            const canComplete = task.status !== 'blocked' && task.status !== 'draft';
            const showPublish = task.status === 'draft';
            footer.innerHTML = `
                <button class="btn btn-danger-text" onclick="window.cancelBoardTask(${task.id})">Cancel Task</button>
                <span style="flex:1"></span>
                <button class="btn" onclick="window.hideTaskDetailModal()">Close</button>
                <button class="btn" onclick="window.enableTaskEditMode(${task.id})">Edit</button>
                ${showPublish ? `<button class="btn btn-primary" onclick="window.publishBoardTask(${task.id})">Publish</button>` : ''}
                ${canComplete ? `<button class="btn btn-success" onclick="window.completeBoardTask(${task.id})">Complete</button>` : ''}`;
        } else {
            footer.innerHTML = `<button class="btn" onclick="window.hideTaskDetailModal()">Close</button>`;
        }
    }

    modal.style.display = '';

    // Close on backdrop click
    modal.onclick = (e) => { if (e.target === modal) hideTaskDetailModal(); };
    // Close on Escape
    modal._escHandler = (e) => { if (e.key === 'Escape') hideTaskDetailModal(); };
    document.addEventListener('keydown', modal._escHandler);
}

let _editOriginalTask = null;

export async function enableTaskEditMode(taskId) {
    const tasks = state.currentBoardTasks || [];
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    _editOriginalTask = task;

    const content = document.getElementById('task-detail-content');
    if (!content) return;

    // Build assignee options
    let assigneeOptions = '<option value="">Unassigned</option>';
    const boardProject = _getBoardProject();
    if (boardProject) {
        try {
            const resp = await fetch(`/api/board/${encodeURIComponent(boardProject)}/subscribers`);
            if (resp.ok) {
                const subs = await resp.json();
                (subs || []).forEach(s => {
                    const name = s.subscriber_id || s.name;
                    if (name) {
                        const selected = name === task.assigned_to ? ' selected' : '';
                        assigneeOptions += `<option value="${escapeAttr(name)}"${selected}>${escapeHtml(name)}</option>`;
                    }
                });
            }
        } catch { /* ignore */ }
    }

    const priorityOptions = ['critical', 'high', 'medium', 'low'].map(p =>
        `<option value="${p}"${p === task.priority ? ' selected' : ''}>${p}</option>`
    ).join('');

    const showDepPicker = task.status === 'blocked' || task.status === 'pending' || task.status === 'draft';
    content.innerHTML = `
        <div id="task-edit-error" class="modal-error" style="display:none"></div>
        <label for="task-edit-title">Title
            <input type="text" id="task-edit-title" value="${escapeAttr(task.title)}">
        </label>
        <label for="task-edit-body">Description
            <textarea id="task-edit-body" rows="3">${escapeHtml(task.body || '')}</textarea>
        </label>
        <label for="task-edit-priority">Priority
            <select id="task-edit-priority">${priorityOptions}</select>
        </label>
        <label for="task-edit-assignee">Assigned To
            <select id="task-edit-assignee">${assigneeOptions}</select>
        </label>
        ${showDepPicker ? '<label>Blocked By <span class="text-muted-sm">(optional)</span></label><div id="task-edit-deps" class="dep-picker"></div>' : ''}`;

    if (showDepPicker) {
        const currentDepIds = (task.blocked_by || []).map(d => d.task_id);
        _renderDepPicker('task-edit-deps', currentDepIds, taskId);
    }

    const footer = document.getElementById('task-detail-modal-footer');
    if (footer) {
        footer.innerHTML = `
            <button class="btn" onclick="window.cancelTaskEdit()">Cancel</button>
            <button class="btn btn-primary" onclick="window.saveTaskEdit(${taskId})">Save</button>`;
    }
}

export async function saveTaskEdit(taskId) {
    const task = _editOriginalTask;
    if (!task) return;

    const title = document.getElementById('task-edit-title').value.trim();
    const errEl = document.getElementById('task-edit-error');
    if (!title) {
        if (errEl) { errEl.textContent = 'Title is required'; errEl.style.display = ''; }
        return;
    }

    const body = document.getElementById('task-edit-body').value.trim();
    const priority = document.getElementById('task-edit-priority').value;
    const assignedTo = document.getElementById('task-edit-assignee').value;

    const updates = {};
    if (title !== task.title) updates.title = title;
    if (body !== (task.body || '')) updates.body = body;
    if (priority !== task.priority) updates.priority = priority;
    if (assignedTo !== (task.assigned_to || '')) updates.assigned_to = assignedTo;

    const depPickerEl = document.getElementById('task-edit-deps');
    if (depPickerEl) {
        const newDeps = _getSelectedDeps('task-edit-deps');
        const oldDeps = (task.blocked_by || []).map(d => d.task_id).sort();
        const sortedNew = [...newDeps].sort();
        if (JSON.stringify(oldDeps) !== JSON.stringify(sortedNew)) {
            updates.blocked_by = newDeps;
        }
    }

    if (Object.keys(updates).length === 0) {
        cancelTaskEdit();
        return;
    }

    const boardProject = _getBoardProject();
    if (!boardProject) return;

    try {
        const resp = await fetch(`/api/board/${encodeURIComponent(boardProject)}/tasks/${taskId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates),
        });
        if (!resp.ok) {
            const data = await resp.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${resp.status}`);
        }
        _editOriginalTask = null;
        await loadBoardTasks(boardProject);
        showTaskDetailModal(taskId);
        showToast('Task updated');
    } catch (e) {
        if (errEl) { errEl.textContent = e.message || 'Failed to save'; errEl.style.display = ''; }
    }
}

export function cancelTaskEdit() {
    if (_editOriginalTask) {
        showTaskDetailModal(_editOriginalTask.id);
        _editOriginalTask = null;
    }
}

export function completeBoardTask(taskId) {
    const footer = document.getElementById('task-detail-modal-footer');
    if (!footer) return;
    footer.innerHTML = `
        <div class="task-confirm-inline">
            <input type="text" id="task-complete-message" placeholder="Completion message (optional)" class="task-confirm-input">
            <div class="task-confirm-buttons">
                <button class="btn" onclick="window._restoreTaskFooter(${taskId})">Back</button>
                <button class="btn btn-success" onclick="window._doCompleteTask(${taskId})">Complete</button>
            </div>
        </div>`;
    document.getElementById('task-complete-message').focus();
}

export async function _doCompleteTask(taskId) {
    const boardProject = _getBoardProject();
    if (!boardProject) return;
    const msgEl = document.getElementById('task-complete-message');
    const message = msgEl ? msgEl.value.trim() : '';
    try {
        const resp = await fetch(`/api/board/${encodeURIComponent(boardProject)}/tasks/${taskId}/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscriber_id: 'Operator', message: message || undefined }),
        });
        if (!resp.ok) {
            const data = await resp.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${resp.status}`);
        }
        hideTaskDetailModal();
        await loadBoardTasks(boardProject);
        showToast('Task completed');
    } catch (e) {
        showToast(e.message || 'Failed to complete task', true);
    }
}

export function cancelBoardTask(taskId) {
    const footer = document.getElementById('task-detail-modal-footer');
    if (!footer) return;
    footer.innerHTML = `
        <div class="task-confirm-inline">
            <span class="task-confirm-text">Cancel this task? This cannot be undone.</span>
            <div class="task-confirm-buttons">
                <button class="btn" onclick="window._restoreTaskFooter(${taskId})">No, Go Back</button>
                <button class="btn btn-danger" onclick="window._doCancelTask(${taskId})">Yes, Cancel</button>
            </div>
        </div>`;
}

export async function _doCancelTask(taskId) {
    const boardProject = _getBoardProject();
    if (!boardProject) return;
    try {
        const resp = await fetch(`/api/board/${encodeURIComponent(boardProject)}/tasks/${taskId}/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscriber_id: 'Operator' }),
        });
        if (!resp.ok) {
            const data = await resp.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${resp.status}`);
        }
        hideTaskDetailModal();
        await loadBoardTasks(boardProject);
        showToast('Task cancelled');
    } catch (e) {
        showToast(e.message || 'Failed to cancel task', true);
    }
}

export async function publishBoardTask(taskId) {
    const boardProject = _getBoardProject();
    if (!boardProject) return;
    try {
        const resp = await fetch(`/api/board/${encodeURIComponent(boardProject)}/tasks/${taskId}/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        if (!resp.ok) {
            const data = await resp.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${resp.status}`);
        }
        await loadBoardTasks(boardProject);
        showTaskDetailModal(taskId);
        showToast('Task published');
    } catch (e) {
        showToast(e.message || 'Failed to publish task', true);
    }
}

export function _restoreTaskFooter(taskId) {
    showTaskDetailModal(taskId);
}

export function hideTaskDetailModal() {
    const modal = document.getElementById('task-detail-modal');
    if (!modal) return;
    modal.style.display = 'none';
    if (modal._escHandler) {
        document.removeEventListener('keydown', modal._escHandler);
        modal._escHandler = null;
    }
}

function formatTaskDate(isoStr) {
    try {
        const d = new Date(isoStr);
        return d.toLocaleString(undefined, {
            month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit',
        });
    } catch {
        return isoStr;
    }
}

async function saveTaskOrder() {
    if (!state.currentSession || state.currentSession.type !== 'live') return;
    const list = document.getElementById('task-bar-list');
    if (!list) return;

    const taskIds = Array.from(list.querySelectorAll('.task-item'))
        .map(el => parseInt(el.dataset.taskId))
        .filter(id => !isNaN(id));

    try {
        await fetch(`/api/sessions/live/${encodeURIComponent(state.currentSession.name)}/tasks/reorder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ task_ids: taskIds }),
        });
    } catch (e) {
        // silent fail for reorder
    }
}
