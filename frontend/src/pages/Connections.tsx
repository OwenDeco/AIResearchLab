import { useEffect, useState } from 'react'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Copy,
  Check,
  RefreshCw,
  ExternalLink,
  Plus,
  Trash2,
  FlaskConical,
  Loader2,
  Plug,
  Wifi,
  WifiOff,
  ChevronDown,
  ChevronRight,
  Bot,
} from 'lucide-react'
import { api } from '../api/client'

interface Endpoint {
  label: string
  url: string
}

interface Connection {
  id: string
  name: string
  protocol: string
  status: 'active' | 'configured' | 'not_configured' | 'unreachable' | 'error' | 'inactive'
  description: string
  endpoints: Endpoint[]
  methods?: string[]
  models?: string[]
  stats?: Record<string, number>
}

interface ConnectionsData {
  exposed: Connection[]
  consumed: Connection[]
}

function StatusBadge({ status }: { status: Connection['status'] }) {
  const map = {
    active:         { label: 'Active',         color: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-700', icon: <CheckCircle2 size={12} /> },
    configured:     { label: 'Configured',     color: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-700',                 icon: <CheckCircle2 size={12} /> },
    not_configured: { label: 'Not configured', color: 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-600',             icon: <AlertCircle size={12} /> },
    inactive:       { label: 'Inactive',       color: 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-600',             icon: <AlertCircle size={12} /> },
    unreachable:    { label: 'Unreachable',    color: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-700',          icon: <AlertCircle size={12} /> },
    error:          { label: 'Error',          color: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 border-red-200 dark:border-red-700',                      icon: <XCircle size={12} /> },
  }
  const { label, color, icon } = map[status] ?? map.not_configured
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${color}`}>
      {icon}{label}
    </span>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <button
      onClick={copy}
      className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-600 transition-colors flex-shrink-0"
      title="Copy URL"
    >
      {copied ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
    </button>
  )
}

interface AgentSkill {
  id: string
  name: string
  description: string
  tags?: string[]
  examples?: string[]
}

interface AgentCardData {
  name: string
  description: string
  url: string
  version: string
  capabilities: {
    streaming: boolean
    pushNotifications: boolean
    stateTransitionHistory: boolean
    methods?: string[]
  }
  authentication: { schemes: string[] }
  skills: AgentSkill[]
}

function SkillTagBadge({ tag }: { tag: string }) {
  const colors: Record<string, string> = {
    native:        'bg-emerald-50 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-700',
    data:          'bg-emerald-50 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-700',
    mcp:           'bg-blue-50 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-700',
    external:      'bg-blue-50 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-700',
    rag:           'bg-violet-50 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-700',
    documentation: 'bg-violet-50 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-700',
    qa:            'bg-violet-50 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-700',
    'api-reference': 'bg-violet-50 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-700',
  }
  const cls = colors[tag] ?? 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-600'
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded border font-mono ${cls}`}>{tag}</span>
  )
}

function AgentCardViewer({ refreshKey = 0 }: { refreshKey?: number }) {
  const [card, setCard] = useState<AgentCardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [skillsExpanded, setSkillsExpanded] = useState(true)

  async function fetchCard() {
    setLoading(true)
    setError('')
    try {
      const data = await api.getAgentCard()
      setCard(data)
    } catch {
      setError('Could not load agent card.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchCard() }, [refreshKey])

  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
      {/* Header — always visible, click to collapse */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-5 py-4 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors text-left"
      >
        <div className="flex items-center gap-2.5">
          <Bot size={16} className="text-violet-600 flex-shrink-0" />
          <span className="font-semibold text-slate-800 dark:text-slate-100 text-sm">Agent Card</span>
          <span className="text-xs text-slate-400">/.well-known/agent.json</span>
          {card && (
            <span className="text-xs bg-violet-50 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 border border-violet-200 dark:border-violet-700 px-1.5 py-0.5 rounded font-mono">
              v{card.version}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {loading && <Loader2 size={13} className="animate-spin text-slate-400" />}
          {expanded ? <ChevronDown size={14} className="text-slate-400" /> : <ChevronRight size={14} className="text-slate-400" />}
        </div>
      </button>

      {expanded && (
        <div className="px-5 pb-5 space-y-4 border-t border-slate-100 dark:border-slate-700">
          {error && (
            <p className="text-xs text-red-500 flex items-center gap-1 pt-4">
              <XCircle size={12} />{error}
            </p>
          )}

          {card && (
            <>
              {/* Identity */}
              <div className="pt-4">
                <div className="text-sm font-semibold text-slate-800 dark:text-slate-100 mb-0.5">{card.name}</div>
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">{card.description}</p>
              </div>

              {/* Capabilities */}
              <div>
                <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">Capabilities</p>
                <div className="flex flex-wrap gap-2">
                  <span className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border font-medium ${card.capabilities.streaming ? 'bg-emerald-50 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-700' : 'bg-slate-100 dark:bg-slate-700 text-slate-400 dark:text-slate-500 border-slate-200 dark:border-slate-600'}`}>
                    {card.capabilities.streaming ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
                    Streaming
                  </span>
                  <span className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border font-medium ${card.capabilities.pushNotifications ? 'bg-emerald-50 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-700' : 'bg-slate-100 dark:bg-slate-700 text-slate-400 dark:text-slate-500 border-slate-200 dark:border-slate-600'}`}>
                    {card.capabilities.pushNotifications ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
                    Push Notifications
                  </span>
                  <span className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border font-medium ${card.capabilities.stateTransitionHistory ? 'bg-emerald-50 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-700' : 'bg-slate-100 dark:bg-slate-700 text-slate-400 dark:text-slate-500 border-slate-200 dark:border-slate-600'}`}>
                    {card.capabilities.stateTransitionHistory ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
                    State History
                  </span>
                </div>
                {card.capabilities.methods && card.capabilities.methods.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {card.capabilities.methods.map((m) => (
                      <span key={m} className="text-xs font-mono bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-600 px-1.5 py-0.5 rounded">
                        {m}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Skills */}
              <div>
                <button
                  onClick={() => setSkillsExpanded((v) => !v)}
                  className="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400 mb-2 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
                >
                  {skillsExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  Skills
                  <span className="bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-600 text-xs px-1.5 py-0.5 rounded-full font-mono">
                    {card.skills.length}
                  </span>
                </button>

                {skillsExpanded && (
                  <div className="space-y-2">
                    {card.skills.map((skill) => (
                      <div
                        key={skill.id}
                        className="border border-slate-200 dark:border-slate-700 rounded-lg p-3 bg-slate-50 dark:bg-slate-700/50"
                      >
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">{skill.name}</span>
                          <div className="flex flex-wrap gap-1 justify-end">
                            {skill.tags?.map((t) => <SkillTagBadge key={t} tag={t} />)}
                          </div>
                        </div>
                        <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">{skill.description}</p>
                        {skill.examples && skill.examples.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {skill.examples.map((ex) => (
                              <span key={ex} className="text-xs text-slate-400 italic bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-1.5 py-0.5 rounded">
                                "{ex}"
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Task URL */}
              <div className="flex items-center gap-2 text-xs">
                <span className="text-slate-400 dark:text-slate-500 w-20 flex-shrink-0">Task URL</span>
                <span className="font-mono text-slate-600 dark:text-slate-300 truncate flex-1 bg-slate-50 dark:bg-slate-700/50 px-2 py-1 rounded border border-slate-200 dark:border-slate-600">
                  {card.url}
                </span>
                <CopyButton text={card.url} />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function ConnectionCard({ conn }: { conn: Connection }) {
  const dimmed = conn.status === 'not_configured'

  return (
    <div className={`bg-white dark:bg-slate-800 rounded-xl border dark:border-slate-700 shadow-sm p-5 flex flex-col gap-3 transition-opacity ${dimmed ? 'opacity-60' : ''}`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 mb-0.5">
            <span className="font-semibold text-slate-800 dark:text-slate-100 text-sm">{conn.name}</span>
            <span className="text-xs text-slate-400 dark:text-slate-400 bg-slate-100 dark:bg-slate-700 px-1.5 py-0.5 rounded font-mono">{conn.protocol}</span>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">{conn.description}</p>
        </div>
        <StatusBadge status={conn.status} />
      </div>

      {/* Endpoints */}
      {conn.endpoints.length > 0 && (
        <div className="space-y-1.5">
          {conn.endpoints.map((ep) => (
            <div key={ep.label} className="flex items-center gap-2 text-xs">
              <span className="text-slate-400 w-24 flex-shrink-0">{ep.label}</span>
              <span className="font-mono text-slate-700 dark:text-slate-200 truncate flex-1 bg-slate-50 dark:bg-slate-700/50 px-2 py-1 rounded border border-slate-200 dark:border-slate-600">
                {ep.url}
              </span>
              {ep.url.startsWith('http') && <CopyButton text={ep.url} />}
              {ep.url.startsWith('http') && (
                <a href={ep.url} target="_blank" rel="noreferrer"
                  className="p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors flex-shrink-0">
                  <ExternalLink size={13} />
                </a>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Methods */}
      {conn.methods && conn.methods.length > 0 && (
        <div>
          <p className="text-xs text-slate-400 mb-1.5">Methods</p>
          <div className="flex flex-wrap gap-1">
            {conn.methods.map((m) => (
              <span key={m} className="text-xs font-mono bg-violet-50 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 border border-violet-200 dark:border-violet-700 px-1.5 py-0.5 rounded">
                {m}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Models */}
      {conn.models && conn.models.length > 0 && (
        <div>
          <p className="text-xs text-slate-400 mb-1.5">Models</p>
          <div className="flex flex-wrap gap-1">
            {conn.models.map((m) => (
              <span key={m} className="text-xs font-mono bg-blue-50 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-700 px-1.5 py-0.5 rounded">
                {m}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Stats */}
      {conn.stats && Object.keys(conn.stats).length > 0 && (
        <div className="flex gap-4">
          {Object.entries(conn.stats).map(([k, v]) => (
            <div key={k} className="text-center">
              <div className="text-base font-bold text-slate-800 dark:text-slate-100">{v.toLocaleString()}</div>
              <div className="text-xs text-slate-400 capitalize">{k}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

interface ToolSchema {
  name: string
  description: string
  inputSchema: {
    type?: string
    properties?: Record<string, { type?: string; description?: string; enum?: string[] }>
    required?: string[]
  }
}

interface RegisteredConn {
  id: string
  name: string
  type: 'a2a' | 'mcp'
  agent_card_url?: string
  task_url?: string
  server_url?: string
  transport?: string
  description: string
  skills?: string[]
  tools?: string[]
  tool_schemas?: ToolSchema[]
  agent_tool_enabled?: boolean
  created_at: string
}

function RegisteredCard({
  conn,
  onDelete,
  onToggleAgentTool,
}: {
  conn: RegisteredConn
  onDelete: (id: string) => void
  onToggleAgentTool?: (id: string, enabled: boolean) => void
}) {
  const [showTest, setShowTest] = useState(false)

  // A2A ping state
  const [pinging, setPinging] = useState(false)
  const [pingResult, setPingResult] = useState<{ status: string; message: string } | null>(null)

  // MCP tool call state
  const schemas: ToolSchema[] = conn.tool_schemas ?? (conn.tools ?? []).map((n) => ({ name: n, description: '', inputSchema: {} }))
  const [selectedTool, setSelectedTool] = useState<string>(schemas[0]?.name ?? '')
  const [inputValues, setInputValues] = useState<Record<string, string>>({})
  const [calling, setCalling] = useState(false)
  const [callResult, setCallResult] = useState<string | null>(null)
  const [callError, setCallError] = useState<string | null>(null)

  const activeTool = schemas.find((s) => s.name === selectedTool)

  function handleToolSelect(name: string) {
    setSelectedTool(name)
    setInputValues({})
    setCallResult(null)
    setCallError(null)
  }

  async function handlePing() {
    setPinging(true)
    setPingResult(null)
    try {
      const r = await api.testRegisteredConnection(conn.id)
      setPingResult(r)
    } catch {
      setPingResult({ status: 'error', message: 'Request failed' })
    } finally {
      setPinging(false)
    }
  }

  async function handleCall() {
    if (!selectedTool) return
    setCalling(true)
    setCallResult(null)
    setCallError(null)
    const schema = activeTool?.inputSchema
    const props = schema?.properties ?? {}
    // Coerce string inputs to expected types
    const args: Record<string, unknown> = {}
    for (const [k, def] of Object.entries(props)) {
      const raw = inputValues[k] ?? ''
      if ((def as any).type === 'number' || (def as any).type === 'integer') {
        args[k] = raw === '' ? undefined : Number(raw)
      } else if ((def as any).type === 'boolean') {
        args[k] = raw === 'true'
      } else {
        args[k] = raw
      }
    }
    // Remove undefined
    for (const k of Object.keys(args)) { if (args[k] === undefined) delete args[k] }
    try {
      const r = await api.callRegisteredTool(conn.id, selectedTool, args)
      setCallResult(r.result)
    } catch (err: any) {
      setCallError(err?.response?.data?.detail ?? err?.message ?? 'Call failed')
    } finally {
      setCalling(false)
    }
  }

  const tags = conn.type === 'a2a' ? conn.skills ?? [] : conn.tools ?? []
  const tagColor = conn.type === 'a2a' ? 'bg-violet-50 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-700' : 'bg-blue-50 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-700'

  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm p-4 flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 mb-0.5">
            <span className="font-semibold text-slate-800 dark:text-slate-100 text-sm">{conn.name}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded font-mono border ${conn.type === 'a2a' ? 'bg-violet-50 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-700' : 'bg-blue-50 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-700'}`}>
              {conn.type.toUpperCase()}
            </span>
            {conn.type === 'mcp' && conn.transport && (
              <span className="text-xs px-1.5 py-0.5 rounded font-mono border bg-slate-50 dark:bg-slate-700 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-600">
                {conn.transport === 'streamable_http' ? 'Streamable HTTP' : 'SSE'}
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2">{conn.description}</p>
        </div>
        <button
          onClick={() => onDelete(conn.id)}
          className="p-1 rounded hover:bg-red-50 text-slate-400 hover:text-red-500 transition-colors flex-shrink-0"
          title="Delete"
        >
          <Trash2 size={14} />
        </button>
      </div>

      {/* URL */}
      <div className="text-xs flex items-center gap-2">
        <span className="text-slate-400 w-16 flex-shrink-0">{conn.type === 'a2a' ? 'Task URL' : 'Server URL'}</span>
        <span className="font-mono text-slate-600 dark:text-slate-300 truncate flex-1 bg-slate-50 dark:bg-slate-700/50 px-2 py-1 rounded border border-slate-200 dark:border-slate-600">
          {conn.type === 'a2a' ? conn.task_url : conn.server_url}
        </span>
        <CopyButton text={(conn.type === 'a2a' ? conn.task_url : conn.server_url) ?? ''} />
      </div>

      {/* Skills / Tools */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.map((t) => (
            <span key={t} className={`text-xs font-mono px-1.5 py-0.5 rounded border ${tagColor}`}>{t}</span>
          ))}
        </div>
      )}

      {/* Agent tool toggle — MCP and A2A */}
      {onToggleAgentTool && (
        <div className="flex items-center justify-between py-1 border-t border-slate-100 dark:border-slate-700">
          <div>
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Use as agent tool</span>
            <p className="text-xs text-slate-400">Expose to the agent's tool-calling loop</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={conn.agent_tool_enabled !== false}
            onClick={() => onToggleAgentTool(conn.id, conn.agent_tool_enabled === false)}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 ${conn.agent_tool_enabled !== false ? 'bg-blue-600' : 'bg-slate-300'}`}
          >
            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${conn.agent_tool_enabled !== false ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </button>
        </div>
      )}

      {/* Test toggle button */}
      <div>
        <button
          onClick={() => {
            setShowTest((v) => !v)
            setPingResult(null)
            setCallResult(null)
            setCallError(null)
          }}
          className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 border rounded-lg transition-colors ${showTest ? 'bg-slate-800 text-white border-slate-800' : 'border-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-600'}`}
        >
          <FlaskConical size={12} />
          {conn.type === 'mcp' && activeTool ? `Test: ${activeTool.name}` : 'Test'}
        </button>
      </div>

      {/* Test panel */}
      {showTest && (
        <div className="border border-slate-200 dark:border-slate-700 rounded-lg p-3 flex flex-col gap-3 bg-slate-50 dark:bg-slate-700/40">
          {conn.type === 'a2a' ? (
            /* A2A: simple connectivity ping */
            <div className="flex flex-col gap-2">
              <p className="text-xs text-slate-500 dark:text-slate-400">Send a connectivity ping to the A2A agent.</p>
              <div className="flex items-center gap-3">
                <button
                  onClick={handlePing}
                  disabled={pinging}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 bg-violet-600 hover:bg-violet-700 text-white rounded-lg transition-colors disabled:opacity-50"
                >
                  {pinging ? <Loader2 size={12} className="animate-spin" /> : <FlaskConical size={12} />}
                  Ping agent
                </button>
                {pingResult && (
                  <span className={`text-xs flex items-center gap-1 ${pingResult.status === 'ok' ? 'text-emerald-600' : 'text-red-500'}`}>
                    {pingResult.status === 'ok' ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                    {pingResult.message}
                  </span>
                )}
              </div>
            </div>
          ) : schemas.length === 0 ? (
            <p className="text-xs text-slate-400">No tools discovered for this server.</p>
          ) : (
            /* MCP: tool selector + input form + result */
            <>
              {/* Tool selector */}
              <div className="flex flex-col gap-1">
                <label className="text-xs text-slate-500 dark:text-slate-400 font-medium">Tool</label>
                <select
                  value={selectedTool}
                  onChange={(e) => handleToolSelect(e.target.value)}
                  className="border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 text-xs bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {schemas.map((s) => (
                    <option key={s.name} value={s.name}>{s.name}</option>
                  ))}
                </select>
                {activeTool?.description && (
                  <p className="text-xs text-slate-400 mt-0.5">{activeTool.description}</p>
                )}
              </div>

              {/* Input fields */}
              {activeTool && Object.keys(activeTool.inputSchema?.properties ?? {}).length > 0 && (
                <div className="flex flex-col gap-2">
                  <label className="text-xs text-slate-500 dark:text-slate-400 font-medium">Inputs</label>
                  {Object.entries(activeTool.inputSchema.properties!).map(([key, def]) => {
                    const required = activeTool.inputSchema.required?.includes(key)
                    const d = def as any
                    return (
                      <div key={key} className="flex flex-col gap-0.5">
                        <label className="text-xs text-slate-600 dark:text-slate-300">
                          {key}{required ? <span className="text-red-400 ml-0.5">*</span> : ''}
                          {d.description && <span className="text-slate-400 ml-1 font-normal">— {d.description}</span>}
                        </label>
                        {d.enum ? (
                          <select
                            value={inputValues[key] ?? ''}
                            onChange={(e) => setInputValues((p) => ({ ...p, [key]: e.target.value }))}
                            className="border border-slate-300 dark:border-slate-600 rounded px-2 py-1 text-xs bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          >
                            <option value="">— select —</option>
                            {d.enum.map((v: string) => <option key={v} value={v}>{v}</option>)}
                          </select>
                        ) : d.type === 'boolean' ? (
                          <select
                            value={inputValues[key] ?? ''}
                            onChange={(e) => setInputValues((p) => ({ ...p, [key]: e.target.value }))}
                            className="border border-slate-300 dark:border-slate-600 rounded px-2 py-1 text-xs bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          >
                            <option value="">— select —</option>
                            <option value="true">true</option>
                            <option value="false">false</option>
                          </select>
                        ) : (
                          <input
                            type={d.type === 'number' || d.type === 'integer' ? 'number' : 'text'}
                            value={inputValues[key] ?? ''}
                            onChange={(e) => setInputValues((p) => ({ ...p, [key]: e.target.value }))}
                            placeholder={d.type ?? 'string'}
                            className="border border-slate-300 dark:border-slate-600 rounded px-2 py-1 text-xs font-mono bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Run button */}
              <button
                onClick={handleCall}
                disabled={calling || !selectedTool}
                className="self-start flex items-center gap-1.5 text-xs px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors disabled:opacity-50"
              >
                {calling ? <Loader2 size={12} className="animate-spin" /> : <FlaskConical size={12} />}
                {calling ? 'Running…' : `Run ${selectedTool}`}
              </button>

              {/* Result */}
              {callError && (
                <div className="flex items-start gap-1.5 text-xs text-red-600">
                  <XCircle size={13} className="flex-shrink-0 mt-0.5" />
                  <span>{callError}</span>
                </div>
              )}
              {callResult !== null && !callError && (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-1 text-xs text-emerald-600">
                    <CheckCircle2 size={12} />
                    Result
                  </div>
                  <pre className="text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded p-2 overflow-auto max-h-48 whitespace-pre-wrap break-words text-slate-700 dark:text-slate-200">{callResult}</pre>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function Connections() {
  const [data, setData] = useState<ConnectionsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [statusLoading, setStatusLoading] = useState(false)

  // ngrok state
  const [ngrok, setNgrok] = useState<{ running: boolean; url: string | null }>({ running: false, url: null })
  const [ngrokBusy, setNgrokBusy] = useState(false)
  const [ngrokError, setNgrokError] = useState('')

  // Registered connections state
  const [registered, setRegistered] = useState<{ a2a: RegisteredConn[]; mcp: RegisteredConn[] }>({ a2a: [], mcp: [] })
  const [regTab, setRegTab] = useState<'a2a' | 'mcp'>('a2a')

  // A2A registration form
  const [a2aName, setA2aName] = useState('')
  const [a2aCardUrl, setA2aCardUrl] = useState('')
  const [a2aRegistering, setA2aRegistering] = useState(false)
  const [a2aError, setA2aError] = useState('')

  // MCP registration form
  const [mcpName, setMcpName] = useState('')
  const [mcpUrl, setMcpUrl] = useState('')
  const [mcpDesc, setMcpDesc] = useState('')
  const [mcpTransport, setMcpTransport] = useState<'sse' | 'streamable_http'>('sse')
  const [mcpRegistering, setMcpRegistering] = useState(false)
  const [mcpError, setMcpError] = useState('')

  async function load(quiet = false) {
    if (!quiet) setLoading(true)
    else setRefreshing(true)

    try {
      // Fast: pure DB reads — load first so the page renders immediately
      const [regData, ngrokData] = await Promise.all([
        api.getRegisteredConnections(),
        api.getNgrokStatus(),
      ])
      setRegistered({
        a2a: regData.a2a.map((c: any) => ({ ...c, type: 'a2a' as const })),
        mcp: regData.mcp.map((c: any) => ({ ...c, type: 'mcp' as const })),
      })
      setNgrok(ngrokData)
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }

    // Slow: network status checks run in background after page is visible
    setStatusLoading(true)
    try {
      const connData = await api.getConnections()
      setData(connData)
    } catch (err) {
      console.error(err)
    } finally {
      setStatusLoading(false)
    }
  }

  async function handleNgrokStart() {
    setNgrokBusy(true)
    setNgrokError('')
    try {
      const result = await api.startNgrok()
      setNgrok(result)
      // Refresh connections so A2A card URLs update to the new tunnel URL
      await load(true)
    } catch (err: any) {
      setNgrokError(err?.response?.data?.detail ?? err?.message ?? 'Failed to start ngrok')
    } finally {
      setNgrokBusy(false)
    }
  }

  async function handleNgrokStop() {
    setNgrokBusy(true)
    setNgrokError('')
    try {
      const result = await api.stopNgrok()
      setNgrok(result)
      await load(true)
    } catch (err: any) {
      setNgrokError(err?.response?.data?.detail ?? err?.message ?? 'Failed to stop ngrok')
    } finally {
      setNgrokBusy(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleRegisterA2A() {
    if (!a2aName.trim() || !a2aCardUrl.trim()) return
    setA2aRegistering(true)
    setA2aError('')
    try {
      const conn = await api.registerA2AConnection(a2aName.trim(), a2aCardUrl.trim())
      setRegistered((prev) => ({ ...prev, a2a: [...prev.a2a, { ...conn, type: 'a2a' as const }] }))
      setA2aName('')
      setA2aCardUrl('')
    } catch (err: any) {
      setA2aError(err?.response?.data?.detail ?? err?.message ?? 'Registration failed')
    } finally {
      setA2aRegistering(false)
    }
  }

  async function handleRegisterMCP() {
    if (!mcpName.trim() || !mcpUrl.trim()) return
    setMcpRegistering(true)
    setMcpError('')
    try {
      const conn = await api.registerMCPConnection(mcpName.trim(), mcpUrl.trim(), mcpDesc.trim(), mcpTransport)
      setRegistered((prev) => ({ ...prev, mcp: [...prev.mcp, { ...conn, type: 'mcp' as const }] }))
      setMcpName('')
      setMcpUrl('')
      setMcpDesc('')
      setMcpTransport('sse')
    } catch (err: any) {
      setMcpError(err?.response?.data?.detail ?? err?.message ?? 'Registration failed')
    } finally {
      setMcpRegistering(false)
    }
  }

  async function handleDelete(id: string) {
    await api.deleteRegisteredConnection(id).catch(console.error)
    setRegistered((prev) => ({
      a2a: prev.a2a.filter((c) => c.id !== id),
      mcp: prev.mcp.filter((c) => c.id !== id),
    }))
  }

  const [agentCardRefreshKey, setAgentCardRefreshKey] = useState(0)

  async function handleToggleAgentTool(id: string, enabled: boolean) {
    await api.setMCPAgentToolEnabled(id, enabled).catch(console.error)
    setRegistered((prev) => ({
      a2a: prev.a2a.map((c) => c.id === id ? { ...c, agent_tool_enabled: enabled } : c),
      mcp: prev.mcp.map((c) => c.id === id ? { ...c, agent_tool_enabled: enabled } : c),
    }))
    setAgentCardRefreshKey((k) => k + 1)
  }

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 dark:text-slate-100">Connections</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">Protocols exposed by this lab and external services it consumes</p>
        </div>
        <button
          onClick={() => load(true)}
          disabled={refreshing}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-slate-300 dark:border-slate-600 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors text-slate-600 dark:text-slate-300 disabled:opacity-50"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-20 text-slate-400">Loading…</div>
      ) : (
        <div className="space-y-8">
          {/* Exposed */}
          <section>
            <div className="flex items-center gap-2 mb-4">
              <ArrowUpFromLine size={16} className="text-violet-600" />
              <h2 className="text-base font-semibold text-slate-700 dark:text-slate-200">Exposed</h2>
              <span className="text-xs text-slate-400">Protocols this lab offers to external agents and systems</span>
              {statusLoading && <Loader2 size={13} className="animate-spin text-slate-400 ml-1" />}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {data ? data.exposed.map((c) => <ConnectionCard key={c.id} conn={c} />) : (
                <p className="text-sm text-slate-400 col-span-3">Checking status…</p>
              )}
            </div>

            {/* Agent Card viewer */}
            <div className="mt-4">
              <AgentCardViewer refreshKey={agentCardRefreshKey} />
            </div>

            {/* Public Access — merged URL + tunnel card */}
            <div className="mt-4 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm p-5 space-y-5">
              {/* Header */}
              <div className="flex items-center gap-2">
                {ngrok.running
                  ? <Wifi size={16} className="text-emerald-600" />
                  : <WifiOff size={16} className="text-slate-400" />}
                <span className="font-semibold text-slate-800 dark:text-slate-100 text-sm">Public Access</span>
                {ngrok.running
                  ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border bg-emerald-100 text-emerald-700 border-emerald-200"><CheckCircle2 size={12} />Tunnel active</span>
                  : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-600"><AlertCircle size={12} />Local only</span>}
              </div>

              {/* ngrok section */}
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium text-slate-700 dark:text-slate-200">ngrok</span>
                    <span className="text-xs text-slate-400 dark:text-slate-400 bg-slate-100 dark:bg-slate-700 px-1.5 py-0.5 rounded font-mono">HTTPS</span>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Start an automated HTTPS tunnel to expose this lab publicly.
                  </p>
                  {ngrok.running && ngrok.url && (
                    <div className="mt-2">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-slate-400 flex-shrink-0 w-20">Tunnel URL</span>
                        <span className="font-mono text-slate-700 dark:text-slate-200 bg-slate-50 dark:bg-slate-700/50 px-2 py-1 rounded border border-slate-200 dark:border-slate-600 truncate flex-1">
                          {ngrok.url}
                        </span>
                        <CopyButton text={ngrok.url} />
                      </div>
                    </div>
                  )}
                  {ngrokError && (
                    <p className="mt-1.5 text-xs text-red-500 flex items-center gap-1">
                      <XCircle size={12} />{ngrokError}
                    </p>
                  )}
                </div>
                <button
                  onClick={ngrok.running ? handleNgrokStop : handleNgrokStart}
                  disabled={ngrokBusy}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0 ${
                    ngrok.running
                      ? 'bg-red-50 text-red-600 border border-red-200 hover:bg-red-100'
                      : 'bg-emerald-600 text-white hover:bg-emerald-700'
                  }`}
                >
                  {ngrokBusy
                    ? <Loader2 size={14} className="animate-spin" />
                    : ngrok.running ? <WifiOff size={14} /> : <Wifi size={14} />}
                  {ngrokBusy ? (ngrok.running ? 'Stopping…' : 'Starting…') : (ngrok.running ? 'Stop tunnel' : 'Start tunnel')}
                </button>
              </div>

            </div>
          </section>

          {/* Consumed */}
          <section>
            <div className="flex items-center gap-2 mb-4">
              <ArrowDownToLine size={16} className="text-blue-600" />
              <h2 className="text-base font-semibold text-slate-700 dark:text-slate-200">Consumed</h2>
              <span className="text-xs text-slate-400">External services and local stores this lab depends on</span>
              {statusLoading && <Loader2 size={13} className="animate-spin text-slate-400 ml-1" />}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {data ? data.consumed.map((c) => <ConnectionCard key={c.id} conn={c} />) : (
                <p className="text-sm text-slate-400 col-span-3">Checking status…</p>
              )}
            </div>
          </section>

          {/* Registered Connections */}
          <section>
            <div className="flex items-center gap-2 mb-4">
              <Plug size={16} className="text-emerald-600" />
              <h2 className="text-base font-semibold text-slate-700 dark:text-slate-200">Registered Connections</h2>
              <span className="text-xs text-slate-400">External A2A agents and MCP servers you can use in the Playground</span>
            </div>

            {/* Tabs */}
            <div className="flex gap-1 mb-4">
              {(['a2a', 'mcp'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setRegTab(t)}
                  className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${regTab === t ? 'bg-slate-800 dark:bg-slate-600 text-white' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'}`}
                >
                  {t === 'a2a' ? 'A2A Agents' : 'MCP Servers'}
                  {(regTab === 'a2a' ? registered.a2a : registered.mcp).length > 0 && (
                    <span className="ml-1.5 text-xs bg-white/20 px-1.5 py-0.5 rounded-full">
                      {t === 'a2a' ? registered.a2a.length : registered.mcp.length}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {regTab === 'a2a' && (
              <div className="space-y-4">
                {/* Registration form */}
                <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm p-4">
                  <p className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-3">Register A2A Agent</p>
                  <div className="flex flex-wrap gap-2 items-end">
                    <div className="flex flex-col gap-1 flex-1 min-w-32">
                      <label className="text-xs text-slate-500 dark:text-slate-400">Name</label>
                      <input
                        className="border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 text-sm bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-violet-500"
                        placeholder="My Agent"
                        value={a2aName}
                        onChange={(e) => setA2aName(e.target.value)}
                      />
                    </div>
                    <div className="flex flex-col gap-1 flex-[3] min-w-48">
                      <label className="text-xs text-slate-500 dark:text-slate-400">Agent Card URL</label>
                      <input
                        className="border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 text-sm bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-violet-500 font-mono"
                        placeholder="https://host/.well-known/agent.json"
                        value={a2aCardUrl}
                        onChange={(e) => setA2aCardUrl(e.target.value)}
                      />
                    </div>
                    <button
                      onClick={handleRegisterA2A}
                      disabled={!a2aName.trim() || !a2aCardUrl.trim() || a2aRegistering}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-600 hover:bg-violet-700 text-white rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {a2aRegistering ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                      Register
                    </button>
                  </div>
                  {a2aError && <p className="text-xs text-red-500 mt-2">{a2aError}</p>}
                </div>

                {/* Registered A2A list */}
                {registered.a2a.length === 0 ? (
                  <p className="text-sm text-slate-400 px-1">No A2A agents registered yet.</p>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    {registered.a2a.map((c) => (
                      <RegisteredCard key={c.id} conn={c} onDelete={handleDelete} onToggleAgentTool={handleToggleAgentTool} />
                    ))}
                  </div>
                )}
              </div>
            )}

            {regTab === 'mcp' && (
              <div className="space-y-4">
                {/* Registration form */}
                <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm p-4">
                  <p className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-3">Register MCP Server</p>
                  <div className="flex flex-wrap gap-2 items-end">
                    <div className="flex flex-col gap-1 flex-1 min-w-32">
                      <label className="text-xs text-slate-500 dark:text-slate-400">Name</label>
                      <input
                        className="border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 text-sm bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        placeholder="My MCP Server"
                        value={mcpName}
                        onChange={(e) => setMcpName(e.target.value)}
                      />
                    </div>
                    <div className="flex flex-col gap-1 flex-[3] min-w-48">
                      <label className="text-xs text-slate-500 dark:text-slate-400">Server URL</label>
                      <input
                        className="border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 text-sm bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                        placeholder="https://host/mcp"
                        value={mcpUrl}
                        onChange={(e) => setMcpUrl(e.target.value)}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-slate-500 dark:text-slate-400">Transport</label>
                      <div className="flex items-center gap-1 border border-slate-300 dark:border-slate-600 rounded overflow-hidden text-xs">
                        {(['sse', 'streamable_http'] as const).map((t) => (
                          <button
                            key={t}
                            type="button"
                            onClick={() => setMcpTransport(t)}
                            className={`px-2.5 py-1.5 transition-colors ${mcpTransport === t ? 'bg-blue-600 text-white' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700'}`}
                          >
                            {t === 'sse' ? 'SSE' : 'Streamable HTTP'}
                          </button>
                        ))}
                      </div>
                    </div>
                    <button
                      onClick={handleRegisterMCP}
                      disabled={!mcpName.trim() || !mcpUrl.trim() || mcpRegistering}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {mcpRegistering ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                      Register
                    </button>
                  </div>
                  {mcpError && <p className="text-xs text-red-500 mt-2">{mcpError}</p>}
                </div>

                {/* Registered MCP list */}
                {registered.mcp.length === 0 ? (
                  <p className="text-sm text-slate-400 px-1">No MCP servers registered yet.</p>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    {registered.mcp.map((c) => (
                      <RegisteredCard key={c.id} conn={c} onDelete={handleDelete} onToggleAgentTool={handleToggleAgentTool} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>

        </div>
      )}
    </div>
  )
}
