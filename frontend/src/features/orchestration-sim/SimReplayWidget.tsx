import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { RotateCcw } from 'lucide-react'
import { OrchestrationRoom } from './OrchestrationRoom'
import {
  WORKSTATIONS,
  MIN_DWELL_MS,
  initAgents,
  applySingleEvent,
} from './simEngine'
import type { AgentState, SimRun, SimEvent } from './simEngine'
import { api } from '../../api/client'

const TARGET_MAX_MS = 30_000

export function SimReplayWidget() {
  const [run, setRun] = useState<SimRun | null>(null)
  const [eventCount, setEventCount] = useState(0)
  const [agents, setAgents] = useState<AgentState[]>([])
  const [replayKey, setReplayKey] = useState(0)
  const [loading, setLoading] = useState(true)
  const [currentEvent, setCurrentEvent] = useState('')

  const mountedRef   = useRef(true)
  const allEventsRef = useRef<SimEvent[]>([])
  const animStartRef = useRef(0)
  const scaleRef     = useRef(1)
  const loopTimer    = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    mountedRef.current = true
    loadLatestRun()
    return () => { mountedRef.current = false }
  }, [])

  async function loadLatestRun() {
    try {
      const data = await api.getUnifiedRuns({ run_type: 'agent_chat', limit: 1 })
      const latest: SimRun | undefined = data.runs?.[0]
      if (latest) setRun(latest)
    } catch {}
    setLoading(false)
  }

  // Reset + start replay whenever run or replayKey changes
  useEffect(() => {
    if (!run) return
    let cancelled = false
    allEventsRef.current = []
    setAgents([])
    setCurrentEvent('')
    if (loopTimer.current) clearTimeout(loopTimer.current)

    const isCancelled = () => cancelled

    api.getRunLive(run.id).then((data: any) => {
      if (isCancelled()) return
      const initial = initAgents(data.run, data.children)
      setAgents(initial)
      if (data.events.length > 0) {
        setEventCount(data.events.length)
        schedule(data.events, data.run.started_at, isCancelled)
      }
    }).catch(() => {})

    return () => {
      cancelled = true
      if (loopTimer.current) clearTimeout(loopTimer.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id, replayKey])

  function getDwellMs(ev: SimEvent): number {
    const exact = ev.payload?.duration_ms
    if (typeof exact === 'number' && exact > 0) return Math.max(MIN_DWELL_MS, exact)
    const all = allEventsRef.current
    const idx = all.findIndex(e => e.id === ev.id)
    const next = idx !== -1 ? all.slice(idx + 1).find(e => e.run_id === ev.run_id) : undefined
    if (!next) return 1500
    return Math.max(MIN_DWELL_MS, new Date(next.timestamp).getTime() - new Date(ev.timestamp).getTime())
  }

  async function runTimeline(events: SimEvent[], runStartMs: number, isCancelled: () => boolean) {
    for (const ev of events) {
      if (isCancelled() || !mountedRef.current) return
      const evOffsetMs = (new Date(ev.timestamp).getTime() - runStartMs) * scaleRef.current
      const waitMs = animStartRef.current + evOffsetMs - Date.now()
      if (waitMs > 0) await new Promise<void>(r => setTimeout(r, waitMs))
      if (isCancelled() || !mountedRef.current) return

      setCurrentEvent(ev.summary)
      const dwellMs = getDwellMs(ev)
      setAgents(prev => applySingleEvent(ev, prev, dwellMs))
    }
  }

  function schedule(events: SimEvent[], runStartedAt: string, isCancelled: () => boolean) {
    allEventsRef.current = events
    const runStartMs  = new Date(runStartedAt).getTime()
    const lastTs      = Math.max(...events.map(e => new Date(e.timestamp).getTime()))
    const totalRealMs = lastTs - runStartMs
    scaleRef.current  = totalRealMs > TARGET_MAX_MS ? TARGET_MAX_MS / totalRealMs : 1
    animStartRef.current = Date.now()

    const byAgent = new Map<string, SimEvent[]>()
    for (const ev of events) {
      if (!byAgent.has(ev.run_id)) byAgent.set(ev.run_id, [])
      byAgent.get(ev.run_id)!.push(ev)
    }
    for (const agentEvs of byAgent.values()) {
      runTimeline(agentEvs, runStartMs, isCancelled)
    }

    const totalScaledMs = totalRealMs * scaleRef.current
    loopTimer.current = setTimeout(() => {
      if (mountedRef.current && !isCancelled()) setReplayKey(k => k + 1)
    }, totalScaledMs + 2500)
  }

  // Smooth movement tick
  useEffect(() => {
    const iv = setInterval(() => {
      setAgents(prev => prev.map(a => {
        const dx = a.targetX - a.x
        const dy = a.targetY - a.y
        if (Math.abs(dx) < 0.12 && Math.abs(dy) < 0.12) return a
        return { ...a, x: a.x + dx * 0.22, y: a.y + dy * 0.22 }
      }))
    }, 80)
    return () => clearInterval(iv)
  }, [])

  if (loading) {
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-900 flex items-center justify-center h-40">
        <p className="text-slate-500 text-sm animate-pulse">Loading latest run…</p>
      </div>
    )
  }

  if (!run) {
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-900 flex flex-col items-center justify-center gap-3 h-48 text-center px-6">
        <p className="text-slate-400 text-sm">No agent runs yet.</p>
        <p className="text-slate-500 text-xs">Chat with an agent or use the Pixel Simulator to record a run.</p>
        <Link
          to="/orchestration/simulator"
          className="text-xs text-violet-400 hover:text-violet-300 underline underline-offset-2"
        >
          Open Simulator
        </Link>
      </div>
    )
  }

  const runName = run.summary?.name ?? 'Agent Run'
  const isScaled = scaleRef.current < 1

  return (
    <div>
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate max-w-xs">
            {runName}
          </span>
          <span className="text-xs text-slate-400 dark:text-slate-500">
            {agents.length} agent{agents.length !== 1 ? 's' : ''} · {eventCount} events
            {isScaled && ` · ${(1 / scaleRef.current).toFixed(1)}× speed`}
          </span>
          <span className="flex items-center gap-1 text-xs text-violet-500 dark:text-violet-400 animate-pulse">
            <RotateCcw size={10} />
            looping
          </span>
        </div>
        <Link
          to="/orchestration/simulator"
          className="text-xs text-slate-500 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors whitespace-nowrap"
        >
          Open Simulator →
        </Link>
      </div>

      {agents.length === 0 ? (
        <div className="rounded-xl border border-slate-700 bg-slate-900 flex items-center justify-center h-[420px]">
          <p className="text-slate-500 text-sm animate-pulse">Initialising…</p>
        </div>
      ) : (
        <div className="relative">
          <OrchestrationRoom
            agents={agents}
            workstations={WORKSTATIONS}
            selectedAgentId=""
            onSelectAgent={() => {}}
          />
          {currentEvent && (
            <div className="absolute bottom-5 left-1/2 -translate-x-1/2 max-w-[80%] rounded-full px-4 py-1.5 bg-slate-900/80 border border-slate-600 backdrop-blur-sm">
              <p className="text-xs text-slate-300 text-center truncate">{currentEvent}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
