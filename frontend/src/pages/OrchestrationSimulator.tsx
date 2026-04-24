import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Clock3, MessageSquare, RefreshCw, RotateCcw, XCircle } from 'lucide-react'
import { OrchestrationRoom } from '../features/orchestration-sim/OrchestrationRoom'
import { DebateRoom } from '../features/orchestration-sim/DebateRoom'
import {
  WORKSTATIONS,
  MIN_DWELL_MS,
  initAgents,
  mergeWithNewChildren,
  applySingleEvent,
} from '../features/orchestration-sim/simEngine'
import type { AgentState, AgentStatus, SimRun, SimEvent } from '../features/orchestration-sim/simEngine'
import { api } from '../api/client'

// ── Run selector ──────────────────────────────────────────────────────────────

function RunSelector({ runs, selectedId, onSelect, onRefresh }: {
  runs: SimRun[]; selectedId: string | null; onSelect: (id: string) => void; onRefresh: () => void
}) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <select
        className="text-sm border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-1.5 bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
        value={selectedId ?? ''}
        onChange={e => e.target.value && onSelect(e.target.value)}
      >
        <option value="">— Select a run —</option>
        {runs.map(r => (
          <option key={r.id} value={r.id}>
            {r.status === 'running' ? '🟢 ' : r.status === 'completed' ? '✓ ' : '✗ '}
            {r.summary?.name ?? 'Agent Run'} · {new Date(r.started_at).toLocaleTimeString()}
            {r.summary?.message_preview ? ` · "${r.summary.message_preview.slice(0, 40)}"` : ''}
          </option>
        ))}
      </select>
      <button
        onClick={onRefresh}
        className="text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
        title="Refresh run list"
      >
        <RefreshCw size={14} />
      </button>
      {selectedId && runs.find(r => r.id === selectedId) && (() => {
        const r = runs.find(r => r.id === selectedId)!
        return (
          <span className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded font-medium ${
            r.status === 'running'   ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400' :
            r.status === 'completed' ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400' :
                                       'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400'
          }`}>
            {r.status === 'running'   ? <><span className="animate-pulse">●</span> live</> :
             r.status === 'completed' ? <><CheckCircle2 size={10} /> done</> :
                                        <><XCircle size={10} /> failed</>}
          </span>
        )
      })()}
    </div>
  )
}

// ── Mode tab bar ──────────────────────────────────────────────────────────────

type SimMode = 'simulation' | 'debate'

function ModeBar({ mode, onChange }: { mode: SimMode; onChange: (m: SimMode) => void }) {
  const tab = (m: SimMode, label: string, icon: React.ReactNode) => (
    <button
      onClick={() => onChange(m)}
      className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-t-lg transition-colors border-b-2 -mb-px ${
        mode === m
          ? 'border-violet-600 text-violet-700 dark:text-violet-400'
          : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
      }`}
    >
      {icon}
      {label}
    </button>
  )
  return (
    <div className="flex items-center gap-1 border-b border-slate-200 dark:border-slate-700 mb-5">
      {tab('simulation', 'Agent Simulation', <Clock3 size={13} />)}
      {tab('debate', 'Debate Room', <MessageSquare size={13} />)}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function OrchestrationSimulator() {
  const [mode, setMode] = useState<SimMode>('simulation')
  const [runs, setRuns]               = useState<SimRun[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [agents, setAgents]           = useState<AgentState[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState<string>('')
  const [replayKey, setReplayKey]     = useState(0)

  const sinceRef        = useRef<string | null>(null)
  const agentsRef       = useRef<AgentState[]>([])
  const mountedRef      = useRef(true)
  const allEventsRef    = useRef<SimEvent[]>([])

  // Keep ref in sync so queue processor always sees latest agents
  useEffect(() => { agentsRef.current = agents }, [agents])

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])

  // ── Timeline-based scheduler ───────────────────────────────────────────────
  // Events fire at their real timestamps (scaled) so ordering is preserved
  // across all agents — sub-agents never start before the orchestrator dispatches.

  const animStartRef = useRef<number>(0)
  const scaleRef     = useRef<number>(1)

  function getDwellMs(ev: SimEvent): number {
    const exact = ev.payload?.duration_ms
    if (typeof exact === 'number' && exact > 0) return Math.max(MIN_DWELL_MS, exact)
    const allEvs = allEventsRef.current
    const idx = allEvs.findIndex(e => e.id === ev.id)
    const nextSame = idx !== -1 ? allEvs.slice(idx + 1).find(e => e.run_id === ev.run_id) : undefined
    if (!nextSame) return 1500
    return Math.max(MIN_DWELL_MS, new Date(nextSame.timestamp).getTime() - new Date(ev.timestamp).getTime())
  }

  async function runAgentTimeline(agentId: string, events: SimEvent[], runStartMs: number) {
    for (const ev of events) {
      if (!mountedRef.current) return
      // Fire at the event's real (scaled) timestamp — no artificial walk delay
      const evOffsetMs = (new Date(ev.timestamp).getTime() - runStartMs) * scaleRef.current
      const waitMs = animStartRef.current + evOffsetMs - Date.now()
      if (waitMs > 0) await new Promise<void>(r => setTimeout(r, waitMs))
      if (!mountedRef.current) return

      const dwellMs = getDwellMs(ev)
      setAgents(prev => {
        const next = applySingleEvent(ev, prev, dwellMs)
        agentsRef.current = next
        return next
      })
    }
  }

  function scheduleEvents(events: SimEvent[], runStartedAt: string) {
    allEventsRef.current = [...allEventsRef.current, ...events]
    if (events.length === 0) return

    const runStartMs = new Date(runStartedAt).getTime()
    const lastTs     = Math.max(...events.map(e => new Date(e.timestamp).getTime()))
    const totalRealMs = lastTs - runStartMs

    // Scale so replays longer than 45 s are compressed; short runs play at 1×
    const TARGET_MAX_MS = 45_000
    scaleRef.current  = totalRealMs > TARGET_MAX_MS ? TARGET_MAX_MS / totalRealMs : 1
    animStartRef.current = Date.now()

    // Group by agent and launch each agent's timeline independently
    const byAgent = new Map<string, SimEvent[]>()
    for (const ev of events) {
      if (!byAgent.has(ev.run_id)) byAgent.set(ev.run_id, [])
      byAgent.get(ev.run_id)!.push(ev)
    }
    for (const [agentId, agentEvs] of byAgent) {
      runAgentTimeline(agentId, agentEvs, runStartMs)
    }
  }

  function appendLiveEvents(events: SimEvent[], runStartedAt: string) {
    // For live events we just append; real timestamps keep them ordered
    if (events.length === 0) return
    allEventsRef.current = [...allEventsRef.current, ...events]
    const runStartMs = new Date(runStartedAt).getTime()
    const byAgent = new Map<string, SimEvent[]>()
    for (const ev of events) {
      if (!byAgent.has(ev.run_id)) byAgent.set(ev.run_id, [])
      byAgent.get(ev.run_id)!.push(ev)
    }
    for (const [agentId, agentEvs] of byAgent) {
      runAgentTimeline(agentId, agentEvs, runStartMs)
    }
  }

  // ── Load run list ──────────────────────────────────────────────────────────
  async function loadRuns() {
    try {
      const data = await api.getUnifiedRuns({ run_type: 'agent_chat', limit: 40 })
      setRuns(data.runs ?? [])
    } catch {}
  }

  useEffect(() => {
    loadRuns()
    const iv = setInterval(loadRuns, 5000)
    return () => clearInterval(iv)
  }, [])

  // ── Reset when run changes or replay triggered ────────────────────────────
  useEffect(() => {
    if (!selectedRunId) { setAgents([]); return }
    sinceRef.current = null
    allEventsRef.current = []
    setAgents([])
    setSelectedAgentId('')
  }, [selectedRunId, replayKey])

  // ── Live polling ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedRunId) return
    let iv: number
    let stopped = false

    async function poll() {
      if (stopped) return
      try {
        const data = await api.getRunLive(selectedRunId!, sinceRef.current ?? undefined)

        if (sinceRef.current === null) {
          // First poll: initialise agents then schedule all historical events by real timestamp
          const initial = initAgents(data.run, data.children)
          agentsRef.current = initial
          setAgents(initial)
          setSelectedAgentId(initial[0]?.id ?? '')
          if (data.events.length > 0) {
            scheduleEvents(data.events, data.run.started_at)
          }
        } else {
          // Subsequent polls: merge new children then append live events
          if (data.children.length > 0) {
            setAgents(prev => {
              const next = mergeWithNewChildren(data.run, data.children, prev)
              agentsRef.current = next
              return next
            })
          }
          if (data.events.length > 0) {
            appendLiveEvents(data.events, data.run.started_at)
          }
        }

        sinceRef.current = data.now

        if (data.run.status !== 'running') {
          clearInterval(iv)
          stopped = true
        }
      } catch {}
    }

    poll()
    iv = window.setInterval(poll, 150)
    return () => { clearInterval(iv); stopped = true }
  }, [selectedRunId, replayKey])

  // ── Smooth movement tick ───────────────────────────────────────────────────
  useEffect(() => {
    const iv = setInterval(() => {
      setAgents(prev =>
        prev.map(a => {
          const dx = a.targetX - a.x
          const dy = a.targetY - a.y
          if (Math.abs(dx) < 0.12 && Math.abs(dy) < 0.12) return a
          return { ...a, x: a.x + dx * 0.22, y: a.y + dy * 0.22 }
        })
      )
    }, 80)
    return () => clearInterval(iv)
  }, [])

  const selectedAgent = agents.find(a => a.id === selectedAgentId) ?? agents[0] ?? null

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-[1400px] mx-auto">
      {/* Page header */}
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-slate-800 dark:text-slate-100">Pixel Simulator</h1>
        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
          Watch agents work in real time, or start a multi-agent debate.
        </p>
      </div>

      {/* Mode tabs */}
      <ModeBar mode={mode} onChange={setMode} />

      {/* ── Debate Room ───────────────────────────────────────────────────── */}
      {mode === 'debate' && <DebateRoom />}

      {/* ── Agent Simulation ─────────────────────────────────────────────── */}
      {mode === 'simulation' && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-3">
            <RunSelector
              runs={runs}
              selectedId={selectedRunId}
              onSelect={setSelectedRunId}
              onRefresh={loadRuns}
            />
            {selectedRunId && (
              <button
                onClick={() => setReplayKey(k => k + 1)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 hover:bg-violet-200 dark:hover:bg-violet-800/60 transition-colors"
                title="Replay from the beginning"
              >
                <RotateCcw size={13} />
                Replay
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-[1fr_340px] gap-5">
            {/* Pixel room */}
            <div>
              {agents.length === 0 ? (
                <div className="rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-900 p-4 shadow-inner flex items-center justify-center h-[548px] text-slate-500">
                  {selectedRunId ? 'Loading run…' : 'Select a run above to start the simulation.'}
                </div>
              ) : (
                <OrchestrationRoom
                  agents={agents}
                  workstations={WORKSTATIONS}
                  selectedAgentId={selectedAgentId}
                  onSelectAgent={setSelectedAgentId}
                />
              )}
            </div>

            {/* Agent panel */}
            <aside className="rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 p-4 h-fit">
              <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">Agent Runtime Panel</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 mb-4">
                Click a sprite to inspect its current context.
              </p>

              {agents.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-4">
                  {agents.map(a => (
                    <button
                      key={a.id}
                      onClick={() => setSelectedAgentId(a.id)}
                      className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                        selectedAgentId === a.id
                          ? 'bg-cyan-600 text-white'
                          : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600'
                      }`}
                    >
                      {a.name}
                    </button>
                  ))}
                </div>
              )}

              {selectedAgent ? (
                <div className="space-y-3">
                  <div className="rounded-md bg-slate-100 dark:bg-slate-700 p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Agent</p>
                    <p className="font-semibold text-slate-800 dark:text-slate-100">{selectedAgent.name}</p>
                  </div>
                  <div className="rounded-md bg-slate-100 dark:bg-slate-700 p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Current task</p>
                    <p className="text-sm text-slate-800 dark:text-slate-100">{selectedAgent.currentTask}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-md bg-slate-100 dark:bg-slate-700 p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Status</p>
                      <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 capitalize">{selectedAgent.status}</p>
                    </div>
                    <div className="rounded-md bg-slate-100 dark:bg-slate-700 p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Workstation</p>
                      <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 capitalize">{selectedAgent.workstationId}</p>
                    </div>
                  </div>
                  <div className="rounded-md border border-slate-200 dark:border-slate-700 p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">Activity log</p>
                    <div className="max-h-[280px] space-y-1.5 overflow-y-auto pr-1">
                      {selectedAgent.logs.map((log, i) => (
                        <div key={i} className="rounded bg-slate-50 dark:bg-slate-700 p-2">
                          <p className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
                            <Clock3 size={10} /> {new Date(log.at).toLocaleTimeString()}
                          </p>
                          <p className="text-xs text-slate-700 dark:text-slate-200 mt-0.5">{log.message}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-slate-400 dark:text-slate-500 text-center py-8">
                  Select a run to see agent activity.
                </p>
              )}
            </aside>
          </div>
        </div>
      )}
    </div>
  )
}
