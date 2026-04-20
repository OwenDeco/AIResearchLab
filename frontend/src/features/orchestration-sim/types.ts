export type AgentStatus = 'idle' | 'moving' | 'working' | 'tooling' | 'delegating'

export type SpriteDefinition = {
  id: string
  pixels: string[]
  palette: Record<string, string>
}

export type Workstation = {
  id: string
  label: string
  x: number
  y: number
}

export type AgentLog = {
  at: string
  message: string
}

export type AgentState = {
  id: string
  name: string
  spriteId: string
  x: number
  y: number
  targetX: number
  targetY: number
  workstationId: string
  status: AgentStatus
  latencyMs: number
  currentTask: string
  logs: AgentLog[]
}

export type SimulationSnapshot = {
  tick: number
  mode: 'live' | 'replay'
  createdAt: string
  agents: AgentState[]
}
