import React, { memo, useEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

const LAYOUT = {
  startX: 80,
  startY: 110,
  teamGapY: 380,
  framePad: 34,
  rootX: 92,
  agentX: 432,
  nodeW: 296,
  rootW: 306,
  nodeH: 134,
  nodeGapX: 338,
  nodeGapY: 156,
  maxColumns: 4,
  eventW: 250,
  eventH: 78,
};

let root = null;
let currentInstance = null;
let currentGraphNodes = [];

export function mount(element, props) {
  if (!element) return;
  if (!root) root = createRoot(element);
  root.render(
    <ReactFlowProvider>
      <MissionCanvas {...props} />
    </ReactFlowProvider>
  );
}

export function fit() {
  if (!currentInstance) return;
  fitGraphNodes(currentInstance, currentGraphNodes, 240);
}

function MissionCanvas({
  sessions = [],
  boardData = {},
  activeScope = 'all',
  showFlow = true,
  reduceMotion = false,
  onSelectSession,
  onOpenBoard,
  onCreateTeam,
  onLaunchAgent,
}) {
  const graph = useMemo(() => {
    try {
      const next = buildGraph({ sessions, boardData, activeScope, showFlow, reduceMotion });
      window.__coralCanvasDebug = {
        ok: true,
        activeScope,
        sessionCount: sessions.length,
        nodeCount: next.nodes.length,
        edgeCount: next.edges.length,
        at: new Date().toISOString(),
      };
      return next;
    } catch (error) {
      console.error('Canvas graph build failed:', error);
      window.__coralCanvasDebug = {
        ok: false,
        activeScope,
        sessionCount: sessions.length,
        error: error?.message || String(error),
        stack: error?.stack || '',
        at: new Date().toISOString(),
      };
      return buildGraph({ sessions, boardData: {}, activeScope, showFlow: false, reduceMotion });
    }
  }, [sessions, boardData, activeScope, showFlow, reduceMotion]);
  const nodes = graph.nodes;
  const edges = graph.edges;
  const fitSignatureRef = useRef('');
  const userMovedRef = useRef(false);

  const flow = useReactFlow();
  const nodeTypes = useMemo(() => ({
    agent: ({ data, selected }) => (
      <AgentNode data={data} selected={selected} onOpen={() => {
        if (data?.session) onSelectSession?.(data.session);
        else if (data?.boardName) onOpenBoard?.(data.boardName);
      }} />
    ),
    root: ({ data, selected }) => (
      <RootNode data={data} selected={selected} onOpen={() => {
        if (data?.session) onSelectSession?.(data.session);
        else if (data?.boardName) onOpenBoard?.(data.boardName);
      }} />
    ),
    teamFrame: ({ data }) => <TeamFrameNode data={data} />,
    teamLabel: ({ data }) => (
      <TeamLabelNode data={data} onOpen={() => {
        if (data?.boardName) onOpenBoard?.(data.boardName);
      }} />
    ),
    event: ({ data }) => (
      <EventNode data={data} onOpen={() => {
        if (data?.boardName) onOpenBoard?.(data.boardName);
      }} />
    ),
  }), [onSelectSession, onOpenBoard]);

  useEffect(() => {
    currentInstance = flow;
    currentGraphNodes = nodes;
  }, [flow, nodes]);

  useEffect(() => {
    currentGraphNodes = nodes;
  }, [nodes]);

  useEffect(() => {
    const signature = `${activeScope}`;
    if (fitSignatureRef.current === signature) return;
    fitSignatureRef.current = '';
    userMovedRef.current = false;
  }, [activeScope]);

  useEffect(() => {
    if (!nodes.length) return;
    const signature = `${activeScope}`;
    if (fitSignatureRef.current === signature || userMovedRef.current) return;

    fitSignatureRef.current = signature;
    requestAnimationFrame(() => {
      if (currentInstance) fitGraphNodes(currentInstance, nodes, 0);
    });
  }, [activeScope, nodes]);

  useEffect(() => {
    const handler = () => fitGraphNodes(flow, currentGraphNodes, 220);
    window.addEventListener('coral:canvas-fit', handler);
    return () => window.removeEventListener('coral:canvas-fit', handler);
  }, [flow]);

  if (!sessions.length) {
    return <CanvasEmptyState onCreateTeam={onCreateTeam} onLaunchAgent={onLaunchAgent} />;
  }

  return (
    <ReactFlow
      className={`coral-react-flow ${reduceMotion ? 'is-reduced-motion' : ''}`}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onInit={(instance) => {
        currentInstance = instance;
      }}
      minZoom={0.16}
      maxZoom={1.65}
      nodesDraggable={false}
      nodesConnectable={false}
      nodesFocusable={false}
      edgesFocusable={false}
      elementsSelectable={false}
      autoPanOnNodeFocus={false}
      selectNodesOnDrag={false}
      panOnDrag
      panOnScroll={false}
      selectionOnDrag={false}
      nodeDragThreshold={4}
      paneClickDistance={6}
      zoomOnPinch
      zoomOnScroll
      zoomOnDoubleClick={false}
      preventScrolling
      proOptions={{ hideAttribution: true }}
      onMoveStart={() => {
        userMovedRef.current = true;
      }}
    >
      <Background className="coral-rf-background" gap={34} size={1} />
      <Controls className="coral-rf-controls" showInteractive={false} showFitView={false} />
    </ReactFlow>
  );
}

const AgentNode = memo(function AgentNode({ data, selected, onOpen }) {
  const state = data.state || { key: 'idle', label: 'Idle' };
  const context = data.context;
  const tasks = data.tasks || [];
  return (
    <button
      type="button"
      className={`rf-agent-card rf-node-card canvas-state-${state.key} ${selected ? 'is-selected' : ''}`}
      style={{ '--agent-accent': data.accent, '--agent-accent-soft': data.accentSoft }}
      title="Open agent session"
      onClick={onOpen}
    >
      <span className="rf-node-avatar" aria-hidden="true">{avatarFor(data.session)}</span>
      <span className="rf-node-main">
        <strong>{data.title}</strong>
        <em>{data.subtitle}</em>
      </span>
      <span className="rf-node-state"><i />{state.label}</span>
      <span className="rf-node-work">{shortText(data.currentWork, 126)}</span>
      {context == null ? null : <span className="rf-node-meter" aria-label={`${context}% context`}><i style={{ width: `${context}%` }} /></span>}
      <span className="rf-node-facts">
        <small>{context == null ? 'ctx n/a' : `${context}% ctx`}</small>
        {data.lastActivity ? <small>{data.lastActivity}</small> : null}
        {data.tokenText ? <small>{data.tokenText}</small> : null}
      </span>
      {tasks[0] ? <span className="rf-task-inline">{shortText(tasks[0].title || tasks[0].body || `Task #${tasks[0].id}`, 80)}</span> : null}
    </button>
  );
});

const RootNode = memo(function RootNode({ data, selected, onOpen }) {
  const state = data.state || { key: 'idle', label: 'Idle' };
  return (
    <button
      type="button"
      className={`rf-root-card rf-node-card canvas-state-${state.key} ${selected ? 'is-selected' : ''}`}
      style={{ '--agent-accent': data.accent, '--agent-accent-soft': data.accentSoft }}
      title="Open orchestrator session"
      onClick={onOpen}
    >
      <span className="rf-root-kicker">Root</span>
      <span className="rf-node-avatar" aria-hidden="true">{avatarFor(data.session) || 'O'}</span>
      <span className="rf-node-main">
        <strong>{data.title}</strong>
        <em>{data.subtitle}</em>
      </span>
      <span className="rf-node-state"><i />{state.label}</span>
      <span className="rf-node-work">{shortText(data.currentWork, 136)}</span>
      <span className="rf-node-facts">
        {data.context == null ? <small>ctx n/a</small> : <small>{data.context}% ctx</small>}
        {data.tokenText ? <small>{data.tokenText}</small> : null}
      </span>
    </button>
  );
});

const TeamFrameNode = memo(function TeamFrameNode({ data }) {
  return (
    <div
      className={`rf-team-frame canvas-team-lane-${data.state?.key || 'idle'}`}
      style={{ '--team-accent': data.accent }}
      aria-hidden="true"
    />
  );
});

const TeamLabelNode = memo(function TeamLabelNode({ data, onOpen }) {
  return (
    <button
      type="button"
      className="rf-team-label"
      style={{ '--team-accent': data.accent }}
      title={`Open board ${data.boardName}`}
      onClick={onOpen}
    >
      <span className="rf-team-number">{data.room}</span>
      <span className="rf-team-copy">
        <span>Mission lane</span>
        <strong>{data.boardName}</strong>
        <em>{data.meta}</em>
      </span>
    </button>
  );
});

const EventNode = memo(function EventNode({ data, onOpen }) {
  return (
    <button
      type="button"
      className={`rf-event-card rf-event-${data.kind || 'message'} rf-event-tone-${data.tone || 'neutral'}`}
      title={data.boardName ? `Open board ${data.boardName}` : ''}
      onClick={onOpen}
    >
      <span>{data.kind === 'task' ? 'Task' : 'Message'}</span>
      <strong>{shortText(data.title, 34)}</strong>
      <em>{shortText(data.subtitle, 42)}</em>
      <p>{shortText(data.body, 92)}</p>
    </button>
  );
});

function nodeWidth(node) {
  const explicit = Number(node?.style?.width);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  if (node?.type === 'root') return LAYOUT.rootW;
  if (node?.type === 'event') return LAYOUT.eventW;
  if (node?.type === 'teamLabel') return 520;
  return LAYOUT.nodeW;
}

function nodeHeight(node) {
  const explicit = Number(node?.style?.height);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  if (node?.type === 'root') return 150;
  if (node?.type === 'event') return LAYOUT.eventH;
  if (node?.type === 'teamLabel') return 64;
  if (node?.type === 'teamFrame') return 320;
  return LAYOUT.nodeH;
}

function graphBounds(nodes) {
  const drawable = nodes.filter((node) => node.type !== 'teamFrame');
  const source = drawable.length ? drawable : nodes;
  if (!source.length) return { minX: 0, minY: 0, maxX: 1200, maxY: 900, width: 1200, height: 900 };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of source) {
    const x = Number(node.position?.x || 0);
    const y = Number(node.position?.y || 0);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + nodeWidth(node));
    maxY = Math.max(maxY, y + nodeHeight(node));
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

function fitGraphNodes(instance, nodes, duration = 0) {
  if (!instance || !nodes?.length) return;
  const stage = document.getElementById('agent-canvas-stage');
  const rect = stage?.getBoundingClientRect();
  if (!rect || rect.width < 40 || rect.height < 40) return;

  const bounds = graphBounds(nodes);
  const paddingX = Math.min(180, Math.max(72, rect.width * 0.08));
  const paddingY = Math.min(150, Math.max(72, rect.height * 0.1));
  const zoom = clamp(
    Math.min(
      (rect.width - paddingX * 2) / bounds.width,
      (rect.height - paddingY * 2) / bounds.height,
    ),
    0.2,
    1.12,
  );
  const x = (rect.width - bounds.width * zoom) / 2 - bounds.minX * zoom;
  const y = Math.max(64, (rect.height - bounds.height * zoom) / 2) - bounds.minY * zoom;
  instance.setViewport({ x, y, zoom }, { duration });
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function CanvasEmptyState({ onCreateTeam, onLaunchAgent }) {
  return (
    <section className="canvas-empty-state canvas-empty-state-react">
      <div className="canvas-empty-orb" aria-hidden="true"><span /><span /><span /><span /></div>
      <span className="agent-canvas-kicker">React Flow canvas</span>
      <h2>No agents online.</h2>
      <p>Launch a team and Coral will map every active agent as a draggable node with live state, task context, and board flow.</p>
      <div className="canvas-empty-actions">
        <button type="button" onClick={onCreateTeam}>Create Team</button>
        <button type="button" onClick={onLaunchAgent}>Launch Agent</button>
      </div>
    </section>
  );
}

function buildGraph({ sessions, boardData, activeScope, showFlow, reduceMotion }) {
  const grouped = groupSessions(sessions);
  const visibleTeams = activeScope === 'all'
    ? grouped.teams
    : activeScope === 'standalone'
      ? new Map()
      : new Map(grouped.teams.has(activeScope) ? [[activeScope, grouped.teams.get(activeScope)]] : [...grouped.teams.entries()]);
  const showStandalone = activeScope === 'all' || activeScope === 'standalone';

  const nodes = [];
  const edges = [];
  let laneY = LAYOUT.startY;
  let room = 1;

  for (const [boardName, teamSessions] of visibleTeams.entries()) {
    const result = appendTeamLane({ nodes, edges, boardName, sessions: teamSessions, boardData: boardData[boardName] || {}, y: laneY, room, showFlow, reduceMotion });
    laneY += result.height + LAYOUT.teamGapY;
    room += 1;
  }

  if (showStandalone && grouped.standalone.length) {
    const result = appendTeamLane({ nodes, edges, boardName: 'Solo Workbenches', sessions: grouped.standalone, boardData: {}, y: laneY, room, showFlow: false, reduceMotion, standalone: true });
    laneY += result.height + LAYOUT.teamGapY;
  }

  return { nodes, edges };
}

function appendTeamLane({ nodes, edges, boardName, sessions, boardData, y, room, showFlow, reduceMotion, standalone = false }) {
  const sorted = [...sessions].sort(agentSort);
  const rootIndex = sorted.findIndex(isOrchestrator);
  const rootSession = rootIndex >= 0 ? sorted.splice(rootIndex, 1)[0] : sorted.shift();
  const agents = sorted;
  const columns = Math.max(1, Math.min(LAYOUT.maxColumns, agents.length || 1));
  const rows = Math.max(1, Math.ceil((agents.length || 1) / columns));
  const laneWidth = Math.max(1120, LAYOUT.agentX + columns * LAYOUT.nodeGapX + LAYOUT.framePad);
  const eventRows = showFlow ? Math.min(2, Math.ceil((recentMessages(boardData.messages, 8).length + activeTasks(boardData.tasks).slice(0, 6).length) / 4)) : 0;
  const laneHeight = Math.max(280, LAYOUT.framePad * 2 + Math.max(LAYOUT.nodeH + 36, rows * LAYOUT.nodeGapY + 28) + eventRows * 112);
  const accent = colorFor(boardName);
  const teamState = boardState(sessions);
  const meta = [
    branchFor(sessions),
    `${sessions.length} agent${sessions.length === 1 ? '' : 's'}`,
    activeTasks(boardData.tasks).length ? `${activeTasks(boardData.tasks).length} active tasks` : '',
    teamState.label,
  ].filter(Boolean).join(' · ');

  nodes.push({
    id: `frame:${boardName}`,
    type: 'teamFrame',
    position: { x: LAYOUT.startX - 42, y: y - 68 },
    data: { boardName, accent, state: teamState },
    style: { width: laneWidth, height: laneHeight + 96 },
    className: 'rf-frame-node-wrapper',
    draggable: false,
    selectable: false,
    focusable: false,
    zIndex: 0,
  });

  nodes.push({
    id: `team-label:${boardName}`,
    type: 'teamLabel',
    position: { x: LAYOUT.startX - 22, y: y - 50 },
    data: { boardName, room: `R${String(room).padStart(2, '0')}`, accent, meta, state: teamState, openBoardOnly: true },
    style: { width: 520, height: 64 },
    draggable: false,
    zIndex: 6,
  });

  if (rootSession) {
    const rootId = nodeId(rootSession, `root:${boardName}`);
    nodes.push({
      id: rootId,
      type: 'root',
      position: { x: LAYOUT.rootX, y: y + 58 + Math.max(0, (rows - 1) * LAYOUT.nodeGapY * 0.5) },
      data: nodeData(rootSession, boardName, activeTasks(boardData.tasks), accent, true),
      style: { width: LAYOUT.rootW },
      zIndex: 8,
    });

    agents.forEach((session, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);
      const assigned = activeTasks(boardData.tasks).filter(task => taskMatchesSession(task, session));
      const id = nodeId(session, `agent:${boardName}:${index}`);
      nodes.push({
        id,
        type: 'agent',
        position: { x: LAYOUT.agentX + col * LAYOUT.nodeGapX, y: y + 44 + row * LAYOUT.nodeGapY },
        data: nodeData(session, boardName, assigned, colorFor(agentLabel(session)), false),
        style: { width: LAYOUT.nodeW },
        zIndex: 8,
      });
      edges.push(flowEdge(rootId, id, 'control', reduceMotion, true));
    });

    if (showFlow && !standalone) {
      appendFlowOverlays({ nodes, edges, boardName, sessions: [rootSession, ...agents], boardData, y, rootId, columns, rows, reduceMotion });
    }
  }

  return { height: laneHeight };
}

function appendFlowOverlays({ nodes, edges, boardName, sessions, boardData, y, rootId, columns, rows, reduceMotion }) {
  const sessionByAlias = aliasMap(sessions);
  const messages = recentMessages(boardData.messages, 8);
  const tasks = activeTasks(boardData.tasks).slice(0, 6);
  const baseY = y + 72 + rows * LAYOUT.nodeGapY;
  const allEvents = [
    ...messages.map((message) => ({ kind: 'message', value: message })),
    ...tasks.map((task) => ({ kind: 'task', value: task })),
  ];

  allEvents.forEach((event, index) => {
    const col = index % Math.max(2, columns);
    const row = Math.floor(index / Math.max(2, columns));
    const id = `${event.kind}:${boardName}:${event.value.id || index}`;
    const sourceSession = event.kind === 'message' ? matchSender(event.value, sessionByAlias) : sessionForTask(event.value, sessions);
    const sourceId = sourceSession ? nodeId(sourceSession) : rootId;
    const data = event.kind === 'message'
      ? {
          kind: 'message',
          boardName,
          tone: messageTone(event.value.content),
          title: senderLabel(event.value, sourceSession),
          subtitle: formatDate(event.value.created_at),
          body: event.value.content || '',
          openBoardOnly: true,
        }
      : {
          kind: 'task',
          boardName,
          tone: taskTone(event.value),
          title: event.value.title || `Task #${event.value.id}`,
          subtitle: event.value.assigned_to || event.value.status || 'unassigned',
          body: event.value.body || event.value.completion_message || 'Board task',
          openBoardOnly: true,
        };

    nodes.push({
      id,
      type: 'event',
      position: { x: LAYOUT.agentX + col * 278, y: baseY + row * 104 },
      data,
      style: { width: LAYOUT.eventW, height: LAYOUT.eventH },
      zIndex: 7,
    });
    edges.push(flowEdge(sourceId, id, event.kind, reduceMotion, false));

    if (event.kind === 'message') {
      for (const target of messageTargets(event.value.content, sessions, sourceSession).slice(0, 2)) {
        edges.push(flowEdge(id, nodeId(target), 'mention', reduceMotion, false));
      }
    }
  });
}

function nodeData(session, boardName, tasks, accent, rootNode) {
  const state = agentState(session);
  const context = contextPct(session);
  return {
    session,
    boardName,
    title: agentLabel(session),
    subtitle: agentSubtitle(session),
    currentWork: currentWork(session, tasks),
    state,
    context,
    tokenText: tokenSummary(session),
    lastActivity: lastActivityText(session),
    tasks,
    accent,
    accentSoft: colorMixSoft(accent),
    rootNode,
  };
}

function flowEdge(source, target, kind, reduceMotion, structural) {
  return {
    id: `${source}->${target}:${kind}`,
    source,
    target,
    type: 'smoothstep',
    animated: !reduceMotion && !structural,
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
    className: `coral-rf-edge coral-rf-edge-${kind} ${structural ? 'is-structural' : ''}`,
  };
}

function groupSessions(sessions) {
  const teams = new Map();
  const standalone = [];
  for (const session of sessions.filter(Boolean)) {
    const board = session.board_project || session.board_name || '';
    if (!board) standalone.push(session);
    else {
      if (!teams.has(board)) teams.set(board, []);
      teams.get(board).push(session);
    }
  }
  return {
    teams: new Map([...teams.entries()].sort(([a], [b]) => a.localeCompare(b))),
    standalone: standalone.sort(agentSort),
  };
}

function agentSort(a, b) {
  const ar = isOrchestrator(a) ? -1 : 0;
  const br = isOrchestrator(b) ? -1 : 0;
  if (ar !== br) return ar - br;
  return agentLabel(a).localeCompare(agentLabel(b));
}

function isOrchestrator(session) {
  const label = `${session?.display_name || ''} ${session?.board_job_title || ''} ${session?.name || ''}`.toLowerCase();
  return label.includes('orchestrator');
}

function agentState(session) {
  if (!session) return { key: 'idle', label: 'Idle' };
  if (session.done || session.sleeping) return { key: 'disabled', label: session.sleeping ? 'Sleeping' : 'Complete' };
  if (session.stuck) return { key: 'stuck', label: 'Stuck' };
  if (session.waiting_for_input) return { key: 'waiting', label: 'Waiting' };
  const provider = String(session.agent_type || '').toLowerCase();
  const staleness = Number(session.staleness_seconds);
  const recentCodex = provider === 'codex' && Number.isFinite(staleness) && staleness < 30 && !/task complete/i.test(session.status || '');
  if (session.working || recentCodex) return { key: 'working', label: 'Working' };
  return { key: 'idle', label: 'Idle' };
}

function boardState(sessions) {
  if (sessions.some((session) => agentState(session).key === 'stuck')) return { key: 'stuck', label: 'Needs attention' };
  if (sessions.some((session) => agentState(session).key === 'working')) return { key: 'working', label: 'Active' };
  if (sessions.some((session) => agentState(session).key === 'waiting')) return { key: 'waiting', label: 'Waiting' };
  if (sessions.every((session) => agentState(session).key === 'disabled')) return { key: 'disabled', label: 'Sleeping' };
  return { key: 'idle', label: 'Idle' };
}

function agentLabel(session) {
  return session?.display_name || session?.board_job_title || session?.name || 'Agent';
}

function agentSubtitle(session) {
  const role = session?.board_job_title || session?.role || agentLabel(session);
  const provider = session?.agent_type || session?.provider || 'agent';
  const model = agentModel(session);
  return [role, provider, model].filter(Boolean).join(' · ');
}

function agentModel(session) {
  return session?.model || session?.model_name || session?.llm_model || '';
}

function avatarFor(session) {
  return session?.icon || session?.emoji || (isOrchestrator(session) ? 'O' : initials(agentLabel(session)));
}

function initials(label) {
  return String(label || 'A').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'A';
}

function currentWork(session, tasks) {
  const task = tasks?.[0];
  if (task) return task.title || task.body || `Task #${task.id}`;
  const summary = String(session?.summary || session?.status || '').trim();
  if (summary) return summary;
  const state = agentState(session).key;
  if (state === 'working') return 'Working through the current turn';
  if (state === 'waiting') return 'Waiting for operator input';
  if (state === 'stuck') return 'Needs intervention';
  if (state === 'disabled') return session?.sleeping ? 'Sleeping' : 'Session complete';
  return 'Idle, no active task claimed';
}

function contextPct(session) {
  const raw = session?.context_pct ?? session?.context_percent ?? session?.context_usage_pct ?? session?.context_usage_percent;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function tokenSummary(session) {
  const tokens = Number(session?.total_tokens ?? session?.tokens ?? session?.live_tokens ?? 0);
  const cost = Number(session?.token_cost_usd ?? session?.cost_usd ?? 0);
  const bits = [];
  if (tokens > 0) bits.push(formatCount(tokens));
  if (cost > 0) bits.push(`$${cost.toFixed(cost < 1 ? 3 : 2)}`);
  return bits.join(' · ');
}

function lastActivityText(session) {
  const seconds = Number(session?.staleness_seconds);
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 5) return 'now';
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function activeTasks(tasks = []) {
  return tasks.filter((task) => task && !['completed', 'skipped', 'cancelled', 'canceled'].includes(String(task.status || '').toLowerCase()));
}

function taskMatchesSession(task, session) {
  const assignee = normalise(task?.assigned_to || '');
  if (!assignee) return false;
  return agentAliases(session).some((alias) => alias === assignee || alias.includes(assignee) || assignee.includes(alias));
}

function sessionForTask(task, sessions) {
  return sessions.find((session) => taskMatchesSession(task, session)) || null;
}

function recentMessages(messages = [], limit) {
  return messages
    .filter((message) => message && (message.content || message.job_title || message.sender_name))
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
    .slice(-limit);
}

function aliasMap(sessions) {
  const map = new Map();
  for (const session of sessions) {
    for (const alias of agentAliases(session)) map.set(alias, session);
  }
  return map;
}

function agentAliases(session) {
  return [session?.display_name, session?.board_job_title, session?.subscriber_id, session?.name, session?.session_id]
    .map(normalise)
    .filter(Boolean);
}

function matchSender(message, aliases) {
  const candidates = [message?.job_title, message?.sender_name, message?.subscriber_id, message?.session_id].map(normalise).filter(Boolean);
  for (const candidate of candidates) {
    if (aliases.has(candidate)) return aliases.get(candidate);
    for (const [alias, session] of aliases.entries()) {
      if (candidate.includes(alias) || alias.includes(candidate)) return session;
    }
  }
  return null;
}

function senderLabel(message, session) {
  return session ? agentLabel(session) : (message?.job_title || message?.sender_name || 'Board');
}

function messageTargets(content, sessions, sourceSession) {
  const text = String(content || '');
  const source = sourceSession ? nodeId(sourceSession) : '';
  if (/@(?:notify-all|all)\b/i.test(text)) return sessions.filter((session) => nodeId(session) !== source);
  const mentions = [...text.matchAll(/@([\w .@-]+)/g)].map((match) => normalise(match[1])).filter(Boolean);
  if (!mentions.length) return [];
  return sessions.filter((session) => {
    if (nodeId(session) === source) return false;
    const aliases = agentAliases(session);
    return mentions.some((mention) => aliases.some((alias) => alias === mention || alias.includes(mention) || mention.includes(alias)));
  });
}

function messageTone(content) {
  const text = String(content || '').toLowerCase();
  if (/blocked|stuck|failed|error|risk|urgent|p0|critical/.test(text)) return 'risk';
  if (/done|complete|shipped|fixed|resolved|approved/.test(text)) return 'done';
  if (/@(?:notify-all|all)\b/.test(text)) return 'broadcast';
  return 'neutral';
}

function taskTone(task) {
  const status = String(task?.status || '').toLowerCase();
  if (status === 'blocked') return 'risk';
  if (status === 'completed' || status === 'skipped') return 'done';
  if (status === 'in_progress') return 'active';
  return 'neutral';
}

function nodeId(session, fallback = '') {
  return `session:${session?.session_id || session?.name || fallback}`;
}

function branchFor(sessions) {
  const session = sessions.find((item) => item.repo_name || item.branch) || sessions[0];
  const repo = session?.repo_name || session?.repo_path?.split('/')?.pop() || '';
  const branch = session?.branch || '';
  if (!repo && !branch) return '';
  return [repo, branch].filter(Boolean).join(' : ');
}

function colorFor(seed) {
  let hash = 0;
  const value = String(seed || 'coral');
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  const hue = [202, 155, 82, 25, 292, 220, 170, 42][hash % 8];
  const chroma = hue === 25 ? 0.12 : hue === 82 ? 0.115 : 0.105;
  return `oklch(0.72 ${chroma} ${hue})`;
}

function colorMixSoft(accent) {
  return `color-mix(in oklch, ${accent} 13%, transparent)`;
}

function formatCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function normalise(value) {
  return String(value || '').trim().toLowerCase();
}

function shortText(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}...`;
}
