import { PixelSprite } from './PixelSprite'
import { spriteLibrary } from './spriteLibrary'
import type { AgentState, Workstation } from './types'

type OrchestrationRoomProps = {
  agents: AgentState[]
  workstations: Workstation[]
  selectedAgentId: string
  onSelectAgent: (agentId: string) => void
}

export function OrchestrationRoom({ agents, workstations, selectedAgentId, onSelectAgent }: OrchestrationRoomProps) {
  return (
    <div className="rounded-xl border border-slate-300 bg-slate-900 p-4 shadow-inner">
      <div className="relative mx-auto h-[520px] w-full max-w-[900px] rounded-lg border-4 border-slate-700 bg-slate-800">
        <div className="absolute inset-3 rounded-md border border-slate-700 bg-[radial-gradient(circle_at_top,#334155_0%,#1e293b_60%)]" />

        {workstations.map((station) => (
          <div
            key={station.id}
            className="absolute h-20 w-36 -translate-x-1/2 -translate-y-1/2 rounded-md border border-slate-600 bg-slate-700/90 px-2 py-1"
            style={{ left: `${station.x}%`, top: `${station.y}%` }}
          >
            <p className="text-[10px] uppercase tracking-wider text-slate-300">Workstation</p>
            <p className="text-xs font-semibold text-cyan-300">{station.label}</p>
          </div>
        ))}

        {agents.map((agent) => {
          const sprite = spriteLibrary[agent.spriteId]
          return (
            <button
              key={agent.id}
              className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-md border p-1 transition-all ${
                selectedAgentId === agent.id
                  ? 'border-cyan-300 bg-cyan-400/20'
                  : 'border-transparent bg-black/10 hover:border-cyan-500/70'
              }`}
              style={{ left: `${agent.x}%`, top: `${agent.y}%` }}
              onClick={() => onSelectAgent(agent.id)}
            >
              {sprite && <PixelSprite sprite={sprite} size={6} />}
              <p className="mt-1 text-[11px] font-semibold text-slate-100">{agent.name}</p>
              <p className="text-[10px] uppercase text-slate-300">{agent.status}</p>
            </button>
          )
        })}
      </div>
    </div>
  )
}
