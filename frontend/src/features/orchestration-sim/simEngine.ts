import type { AgentState, AgentStatus, Workstation } from './types'

export type { AgentState, AgentStatus, Workstation }

export interface SimRun {
  id: string
  status: 'running' | 'completed' | 'failed'
  started_at: string
  ended_at: string | null
  summary: Record<string, any> | null
}

export interface SimEvent {
  id: string
  run_id: string
  event_type: string
  timestamp: string
  summary: string
  payload?: Record<string, any> | null
}

export const WORKSTATIONS: Workstation[] = [
  { id: 'rag',          label: 'RAG Index',        x: 13, y: 12 },
  { id: 'taskqueue',    label: 'Task Queue',        x: 44, y: 12 },
  { id: 'llm',          label: 'LLM Server',        x: 76, y: 12 },
  { id: 'orchestrator', label: 'Orchestrator Hub',  x: 44, y: 44 },
  { id: 'tools',        label: 'Tool Console',      x: 13, y: 74 },
  { id: 'standby',      label: 'Standby',           x: 76, y: 74 },
]

export const SPRITE_IDS = ['coderBlue', 'plannerGreen', 'reviewerPurple']

export const MIN_DWELL_MS = 900

export function pushLog(agent: AgentState, message: string) {
  return [{ at: new Date().toISOString(), message }, ...agent.logs].slice(0, 15)
}

export function fmtDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms)}ms`
}

export function initAgents(run: SimRun, children: SimRun[]): AgentState[] {
  const orch: AgentState = {
    id: run.id,
    name: run.summary?.name ?? 'Orchestrator',
    spriteId: 'coderBlue',
    x: 44, y: 44, targetX: 44, targetY: 44,
    workstationId: 'orchestrator',
    status: 'idle',
    latencyMs: 0,
    currentTask: 'Awaiting task',
    logs: [{ at: new Date().toISOString(), message: 'Orchestrator ready' }],
  }

  const subs: AgentState[] = children.map((c, i) => {
    const sx = 68 + (i % 2) * 14
    const sy = 68 + Math.floor(i / 2) * 9
    return {
      id: c.id,
      name: c.summary?.name ?? `Agent ${i + 1}`,
      spriteId: SPRITE_IDS[(i + 1) % SPRITE_IDS.length],
      x: sx, y: sy, targetX: sx, targetY: sy,
      workstationId: 'standby',
      status: 'idle',
      latencyMs: 0,
      currentTask: 'Standby',
      logs: [{ at: new Date().toISOString(), message: 'Waiting for assignment' }],
    }
  })

  return [orch, ...subs]
}

export function mergeWithNewChildren(run: SimRun, children: SimRun[], existing: AgentState[]): AgentState[] {
  const existingIds = new Set(existing.map(a => a.id))
  const newChildren: AgentState[] = []

  children.forEach((c, i) => {
    if (existingIds.has(c.id)) return
    const subIndex = existing.length - 1 + newChildren.length
    const sx = 68 + (subIndex % 2) * 14
    const sy = 68 + Math.floor(subIndex / 2) * 9
    newChildren.push({
      id: c.id,
      name: c.summary?.name ?? `Agent ${subIndex + 1}`,
      spriteId: SPRITE_IDS[(subIndex + 1) % SPRITE_IDS.length],
      x: sx, y: sy, targetX: sx, targetY: sy,
      workstationId: 'standby',
      status: 'idle',
      latencyMs: 0,
      currentTask: 'Standby',
      logs: [{ at: new Date().toISOString(), message: 'Waiting for assignment' }],
    })
  })

  return newChildren.length > 0 ? [...existing, ...newChildren] : existing
}

export function applySingleEvent(ev: SimEvent, agents: AgentState[], dwellMs?: number): AgentState[] {
  let next = agents.map(a => ({ ...a }))
  const idx = next.findIndex(a => a.id === ev.run_id)

  switch (ev.event_type) {
    case 'dispatching': {
      if (idx !== -1) {
        next[idx] = {
          ...next[idx],
          status: 'delegating' as AgentStatus,
          currentTask: ev.summary,
          logs: pushLog(next[idx], ev.summary),
        }
      }
      break
    }

    case 'started': {
      if (idx > 0) {
        next[idx] = {
          ...next[idx],
          status: 'moving' as AgentStatus,
          targetX: 44, targetY: 12,
          workstationId: 'taskqueue',
          currentTask: 'Picking up task',
          logs: pushLog(next[idx], 'Received task, heading to task queue'),
        }
      }
      break
    }

    case 'llm_call': {
      if (idx !== -1) {
        const dur = dwellMs != null ? ` (${fmtDuration(dwellMs)})` : ''
        next[idx] = {
          ...next[idx],
          status: 'working' as AgentStatus,
          targetX: 76, targetY: 12,
          workstationId: 'llm',
          currentTask: `Calling LLM${dur}`,
          logs: pushLog(next[idx], `At LLM server — running inference${dur}`),
        }
      }
      break
    }

    case 'rag_retrieval': {
      if (idx !== -1) {
        const dur = dwellMs != null ? ` (${fmtDuration(dwellMs)})` : ''
        next[idx] = {
          ...next[idx],
          status: 'working' as AgentStatus,
          targetX: 13, targetY: 12,
          workstationId: 'rag',
          currentTask: `RAG retrieval${dur}`,
          logs: pushLog(next[idx], `At RAG index — retrieving chunks${dur}`),
        }
      }
      break
    }

    case 'mcp_tool_call': {
      if (idx !== -1) {
        const dur = dwellMs != null ? ` (${fmtDuration(dwellMs)})` : ''
        next[idx] = {
          ...next[idx],
          status: 'tooling' as AgentStatus,
          targetX: 13, targetY: 74,
          workstationId: 'tools',
          currentTask: `${ev.summary}${dur}`,
          logs: pushLog(next[idx], `Tool call: ${ev.summary}${dur}`),
        }
      }
      break
    }

    case 'a2a_tool_call': {
      if (idx !== -1) {
        const dur = dwellMs != null ? ` (${fmtDuration(dwellMs)})` : ''
        next[idx] = {
          ...next[idx],
          status: 'delegating' as AgentStatus,
          targetX: 44, targetY: 44,
          currentTask: `${ev.summary}${dur}`,
          logs: pushLog(next[idx], `A2A: ${ev.summary}${dur}`),
        }
      }
      break
    }

    case 'completed': {
      if (idx === 0) {
        next = next.map((a, i) => ({
          ...a,
          status: 'idle' as AgentStatus,
          targetX: i === 0 ? 44 : 76,
          targetY: i === 0 ? 44 : 74,
          currentTask: i === 0 ? 'Run complete' : 'Done',
          logs: pushLog(a, i === 0 ? 'Run complete' : 'Finished'),
        }))
      } else if (idx !== -1) {
        next[idx] = {
          ...next[idx],
          status: 'delegating' as AgentStatus,
          targetX: 44 + Math.random() * 6 - 3,
          targetY: 44 + Math.random() * 6 - 3,
          currentTask: 'Delivering result to orchestrator',
          logs: pushLog(next[idx], 'Task done — returning result'),
        }
      }
      break
    }

    case 'failed': {
      if (idx !== -1) {
        next[idx] = {
          ...next[idx],
          status: 'idle' as AgentStatus,
          currentTask: 'Failed',
          logs: pushLog(next[idx], `Error: ${ev.summary}`),
        }
      }
      break
    }

    default:
      if (idx !== -1 && ev.summary) {
        next[idx] = { ...next[idx], logs: pushLog(next[idx], ev.summary) }
      }
  }

  return next
}
