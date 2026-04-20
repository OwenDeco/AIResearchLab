import { useEffect, useMemo, useState } from 'react'
import { Clock3, ListRestart, Play, Pause, Radio } from 'lucide-react'
import { OrchestrationRoom } from '../features/orchestration-sim/OrchestrationRoom'
import { initialAgents, taskPool, toolPool, workstations } from '../features/orchestration-sim/simConfig'
import type { AgentState, AgentStatus, SimulationSnapshot } from '../features/orchestration-sim/types'

const statusOrder: AgentStatus[] = ['moving', 'working', 'tooling', 'delegating', 'idle']

function pickRandom<T>(items: T[]) {
  return items[Math.floor(Math.random() * items.length)]
}

function pushLog(agent: AgentState, message: string) {
  const entry = { at: new Date().toISOString(), message }
  return [entry, ...agent.logs].slice(0, 12)
}

export function OrchestrationSimulator() {
  const [mode, setMode] = useState<'live' | 'replay'>('live')
  const [agents, setAgents] = useState<AgentState[]>(initialAgents)
  const [history, setHistory] = useState<SimulationSnapshot[]>([])
  const [replayIndex, setReplayIndex] = useState(0)
  const [isReplayPlaying, setIsReplayPlaying] = useState(false)
  const [selectedAgentId, setSelectedAgentId] = useState(initialAgents[0].id)

  useEffect(() => {
    if (mode !== 'live') return

    const interval = window.setInterval(() => {
      setAgents((current) => {
        const next = current.map((agent) => {
          const station = pickRandom(workstations)
          const nextStatus = pickRandom(statusOrder)
          const nextTask = pickRandom(taskPool)
          const latency = Math.round(45 + Math.random() * 180)
          const delegateTarget = pickRandom(current.filter((a) => a.id !== agent.id))?.name ?? 'No peer'
          const tool = pickRandom(toolPool)

          let logMessage = `Received task: ${nextTask}`
          if (nextStatus === 'moving') logMessage = `Moving to ${station.label}`
          if (nextStatus === 'tooling') logMessage = `Calling tool: ${tool}`
          if (nextStatus === 'delegating') logMessage = `Delegated sub-task to ${delegateTarget}`
          if (nextStatus === 'working') logMessage = `Working at ${station.label}`

          return {
            ...agent,
            targetX: station.x + (Math.random() * 8 - 4),
            targetY: station.y + (Math.random() * 8 - 4),
            x: agent.x + (station.x - agent.x) * 0.34,
            y: agent.y + (station.y - agent.y) * 0.34,
            workstationId: station.id,
            status: nextStatus,
            latencyMs: latency,
            currentTask: nextTask,
            logs: pushLog(agent, logMessage),
          }
        })

        setHistory((prev) => {
          const snapshot: SimulationSnapshot = {
            tick: prev.length,
            mode: 'live',
            createdAt: new Date().toISOString(),
            agents: next,
          }
          return [...prev, snapshot].slice(-180)
        })

        return next
      })
    }, 1150)

    return () => window.clearInterval(interval)
  }, [mode])

  useEffect(() => {
    if (mode !== 'replay' || !isReplayPlaying || history.length === 0) return

    const interval = window.setInterval(() => {
      setReplayIndex((idx) => {
        const next = idx + 1
        if (next >= history.length - 1) {
          setIsReplayPlaying(false)
          return history.length - 1
        }
        return next
      })
    }, 900)

    return () => window.clearInterval(interval)
  }, [mode, isReplayPlaying, history.length])

  const visibleAgents = useMemo(() => {
    if (mode === 'replay' && history.length > 0) return history[replayIndex]?.agents ?? agents
    return agents
  }, [mode, history, replayIndex, agents])

  const selectedAgent = visibleAgents.find((agent) => agent.id === selectedAgentId) ?? visibleAgents[0]

  function switchToReplay() {
    setMode('replay')
    setReplayIndex(Math.max(history.length - 1, 0))
    setIsReplayPlaying(false)
  }

  return (
    <div className="max-w-[1400px] mx-auto space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Pixel Orchestration Simulator</h1>
          <p className="text-sm text-slate-600 mt-1">
            Live mode simulates runtime orchestration events. Replay mode lets you inspect timeline snapshots.
          </p>
        </div>

        <div className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white p-2">
          <button
            className={`flex items-center gap-1 rounded-md px-3 py-1.5 text-sm ${
              mode === 'live' ? 'bg-cyan-600 text-white' : 'bg-slate-100 text-slate-700'
            }`}
            onClick={() => setMode('live')}
          >
            <Radio size={14} /> Live mode
          </button>
          <button
            className={`flex items-center gap-1 rounded-md px-3 py-1.5 text-sm ${
              mode === 'replay' ? 'bg-violet-600 text-white' : 'bg-slate-100 text-slate-700'
            }`}
            onClick={switchToReplay}
            disabled={history.length === 0}
          >
            <ListRestart size={14} /> Replay mode
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-5">
        <div className="space-y-4">
          <OrchestrationRoom
            agents={visibleAgents}
            workstations={workstations}
            selectedAgentId={selectedAgent.id}
            onSelectAgent={setSelectedAgentId}
          />

          {mode === 'replay' && history.length > 0 && (
            <div className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="flex items-center justify-between text-xs text-slate-500 mb-2">
                <span>Timeline frame {replayIndex + 1} / {history.length}</span>
                <span>{new Date(history[replayIndex].createdAt).toLocaleTimeString()}</span>
              </div>
              <input
                type="range"
                min={0}
                max={Math.max(history.length - 1, 0)}
                value={replayIndex}
                className="w-full"
                onChange={(e) => setReplayIndex(Number(e.target.value))}
              />
              <div className="mt-2 flex gap-2">
                <button
                  className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700"
                  onClick={() => setIsReplayPlaying((v) => !v)}
                >
                  {isReplayPlaying ? <Pause size={14} className="inline mr-1" /> : <Play size={14} className="inline mr-1" />}
                  {isReplayPlaying ? 'Pause replay' : 'Play replay'}
                </button>
              </div>
            </div>
          )}
        </div>

        <aside className="rounded-xl border border-slate-300 bg-white p-4 h-fit">
          <h2 className="text-lg font-semibold text-slate-800">Agent Runtime Panel</h2>
          <p className="text-xs text-slate-500 mt-1">Select an agent sprite to inspect its current context.</p>

          <div className="mt-4 space-y-3">
            <div className="rounded-md bg-slate-100 p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">Agent</p>
              <p className="font-semibold text-slate-800">{selectedAgent.name}</p>
            </div>
            <div className="rounded-md bg-slate-100 p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">Current task</p>
              <p className="text-sm text-slate-800">{selectedAgent.currentTask}</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-md bg-slate-100 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Status</p>
                <p className="text-sm font-semibold text-slate-800">{selectedAgent.status}</p>
              </div>
              <div className="rounded-md bg-slate-100 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Latency</p>
                <p className="text-sm font-semibold text-slate-800">{selectedAgent.latencyMs} ms</p>
              </div>
            </div>

            <div className="rounded-md border border-slate-200 p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500 mb-2">Logs</p>
              <div className="max-h-[260px] space-y-2 overflow-y-auto pr-1">
                {selectedAgent.logs.map((log) => (
                  <div key={`${log.at}-${log.message}`} className="rounded bg-slate-50 p-2">
                    <p className="text-[11px] text-slate-500 flex items-center gap-1">
                      <Clock3 size={11} /> {new Date(log.at).toLocaleTimeString()}
                    </p>
                    <p className="text-xs text-slate-700">{log.message}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
