import type { AgentState, Workstation } from './types'

export const workstations: Workstation[] = [
  { id: 'triage', label: 'Triage Board', x: 12, y: 10 },
  { id: 'tooling', label: 'Tool Console', x: 62, y: 10 },
  { id: 'synthesis', label: 'Synthesis Desk', x: 12, y: 54 },
  { id: 'handoff', label: 'Handoff Queue', x: 62, y: 54 },
]

export const initialAgents: AgentState[] = [
  {
    id: 'agent-a',
    name: 'Nova',
    spriteId: 'coderBlue',
    x: 20,
    y: 26,
    targetX: 20,
    targetY: 26,
    workstationId: 'triage',
    status: 'idle',
    latencyMs: 90,
    currentTask: 'Awaiting assignment',
    logs: [{ at: new Date().toISOString(), message: 'Boot complete. Standing by.' }],
  },
  {
    id: 'agent-b',
    name: 'Iris',
    spriteId: 'plannerGreen',
    x: 45,
    y: 30,
    targetX: 45,
    targetY: 30,
    workstationId: 'tooling',
    status: 'idle',
    latencyMs: 72,
    currentTask: 'Monitoring incoming tasks',
    logs: [{ at: new Date().toISOString(), message: 'Connected to orchestration bus.' }],
  },
  {
    id: 'agent-c',
    name: 'Rune',
    spriteId: 'reviewerPurple',
    x: 32,
    y: 48,
    targetX: 32,
    targetY: 48,
    workstationId: 'synthesis',
    status: 'idle',
    latencyMs: 110,
    currentTask: 'Ready for review tasks',
    logs: [{ at: new Date().toISOString(), message: 'Audit checks are green.' }],
  },
]

export const taskPool = [
  'Summarize API diagnostics',
  'Validate benchmark traces',
  'Call vector-index tool',
  'Delegate schema cleanup',
  'Compile final response',
  'Merge context snippets',
]

export const toolPool = ['query_docs', 'run_benchmark', 'fetch_logs', 'build_graph']

export const agentNames = ['Nova', 'Iris', 'Rune']
