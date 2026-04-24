import { useEffect, useRef, useState } from 'react'
import {
  Bot, Plus, Trash2, Send, Loader2,
  Settings2, MessageSquare, Database, Wrench, User,
  Save,
} from 'lucide-react'
import { api } from '../api/client'
import { useAppStore } from '../store/useAppStore'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentTools {
  mcp_connection_ids: string[]
  a2a_connection_ids: string[]
  agent_ids: string[]
  use_own_a2a: boolean
}

interface AgentRAG {
  enabled: boolean
  retrieval_mode: string
  model_name: string
  embed_model: string
  top_k: number
}

interface AgentConfig {
  id: string
  name: string
  role: string
  system_prompt: string
  tools: AgentTools
  rag: AgentRAG
  created_at: string
  updated_at: string
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  latency_ms?: number
  rag_used?: boolean
}

const RETRIEVAL_MODES = [
  { value: 'lexical',        label: 'Lexical (BM25)' },
  { value: 'vector',         label: 'Vector' },
  { value: 'hybrid',         label: 'Hybrid' },
  { value: 'semantic_rerank',label: 'Semantic Rerank' },
  { value: 'graph_rag',      label: 'Graph RAG' },
  { value: 'parent_child',   label: 'Parent-Child' },
]

const DEFAULT_TOOLS: AgentTools = { mcp_connection_ids: [], a2a_connection_ids: [], agent_ids: [], use_own_a2a: false }
const DEFAULT_RAG: AgentRAG = { enabled: false, retrieval_mode: 'hybrid', model_name: '', embed_model: '', top_k: 5 }

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function AgentListItem({
  agent, active, onSelect, onDelete,
}: {
  agent: AgentConfig
  active: boolean
  onSelect: () => void
  onDelete: () => void
}) {
  return (
    <div
      onClick={onSelect}
      className={`group relative rounded-lg px-3 py-2.5 cursor-pointer transition-colors ${
        active ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-800'
      }`}
    >
      <p className="text-xs font-medium truncate pr-8">{agent.name}</p>
      {agent.role && <p className="text-[10px] mt-0.5 opacity-60 truncate">{agent.role}</p>}
      <div className="absolute right-2 top-1/2 -translate-y-1/2 hidden group-hover:flex items-center">
        <button
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          className="p-0.5 rounded hover:text-red-400 opacity-60 hover:opacity-100"
          title="Delete agent"
        >
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Configure tab
// ---------------------------------------------------------------------------

function ConfigureTab({
  agent,
  onSave,
  saving,
  registeredConnections,
  allAgents,
}: {
  agent: AgentConfig
  onSave: (updated: Omit<AgentConfig, 'id' | 'created_at' | 'updated_at'>) => void
  saving: boolean
  registeredConnections: { a2a: any[]; mcp: any[] }
  allAgents: AgentConfig[]
}) {
  const { models } = useAppStore()
  const llmModels = models?.llms ?? []
  const embedModels = models?.embed_models ?? []

  const [name, setName] = useState(agent.name)
  const [role, setRole] = useState(agent.role)
  const [systemPrompt, setSystemPrompt] = useState(agent.system_prompt)
  const [tools, setTools] = useState<AgentTools>({ ...DEFAULT_TOOLS, ...agent.tools })
  const [rag, setRag] = useState<AgentRAG>({ ...DEFAULT_RAG, ...agent.rag })

  // Reset when agent changes
  useEffect(() => {
    setName(agent.name)
    setRole(agent.role)
    setSystemPrompt(agent.system_prompt)
    setTools({ ...DEFAULT_TOOLS, ...agent.tools })
    setRag({ ...DEFAULT_RAG, ...agent.rag })
  }, [agent.id])

  function toggleMcp(id: string) {
    setTools((t) => ({
      ...t,
      mcp_connection_ids: t.mcp_connection_ids.includes(id)
        ? t.mcp_connection_ids.filter((x) => x !== id)
        : [...t.mcp_connection_ids, id],
    }))
  }

  function toggleA2a(id: string) {
    setTools((t) => ({
      ...t,
      a2a_connection_ids: t.a2a_connection_ids.includes(id)
        ? t.a2a_connection_ids.filter((x) => x !== id)
        : [...t.a2a_connection_ids, id],
    }))
  }

  function toggleAgent(id: string) {
    setTools((t) => ({
      ...t,
      agent_ids: (t.agent_ids ?? []).includes(id)
        ? (t.agent_ids ?? []).filter((x) => x !== id)
        : [...(t.agent_ids ?? []), id],
    }))
  }

  function handleSave() {
    onSave({ name, role, system_prompt: systemPrompt, tools, rag })
  }

  const inputCls = 'w-full border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-violet-500'
  const labelCls = 'block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1'
  const sectionTitleCls = 'flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3'

  return (
    <div className="space-y-6 overflow-y-auto pr-1">
      {/* Identity */}
      <section>
        <p className={sectionTitleCls}><Bot size={15} className="text-violet-500" />Identity</p>
        <div className="space-y-3">
          <div>
            <label className={labelCls}>Name</label>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="My Agent" />
          </div>
          <div>
            <label className={labelCls}>Role</label>
            <input className={inputCls} value={role} onChange={(e) => setRole(e.target.value)} placeholder="Short description of what this agent does" />
          </div>
          <div>
            <label className={labelCls}>System Prompt</label>
            <textarea
              className={`${inputCls} resize-none leading-relaxed`}
              rows={6}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="You are a helpful assistant that..."
            />
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
              This is prepended to every conversation as the system message. If blank, a default is generated from the role.
            </p>
          </div>
        </div>
      </section>

      {/* RAG */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <p className={sectionTitleCls}><Database size={15} className="text-blue-500" />Knowledge / RAG</p>
          <label className="flex items-center gap-2 cursor-pointer">
            <span className="text-xs text-slate-500 dark:text-slate-400">Enable</span>
            <button
              type="button"
              role="switch"
              aria-checked={rag.enabled}
              onClick={() => setRag((r) => ({ ...r, enabled: !r.enabled }))}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 ${rag.enabled ? 'bg-blue-600' : 'bg-slate-300 dark:bg-slate-600'}`}
            >
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${rag.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
            </button>
          </label>
        </div>
        {rag.enabled && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Retrieval Mode</label>
              <select
                className={inputCls}
                value={rag.retrieval_mode}
                onChange={(e) => setRag((r) => ({ ...r, retrieval_mode: e.target.value }))}
              >
                {RETRIEVAL_MODES.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Top K</label>
              <input
                type="number" min={1} max={20}
                className={inputCls}
                value={rag.top_k}
                onChange={(e) => setRag((r) => ({ ...r, top_k: Number(e.target.value) }))}
              />
            </div>
            <div>
              <label className={labelCls}>LLM Model</label>
              <select
                className={inputCls}
                value={rag.model_name}
                onChange={(e) => setRag((r) => ({ ...r, model_name: e.target.value }))}
              >
                <option value="">Default (from Settings)</option>
                {llmModels.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Embedding Model</label>
              <select
                className={inputCls}
                value={rag.embed_model}
                onChange={(e) => setRag((r) => ({ ...r, embed_model: e.target.value }))}
              >
                <option value="">Default (from Settings)</option>
                {embedModels.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>
        )}
        {!rag.enabled && (
          <p className="text-xs text-slate-400 dark:text-slate-500">
            Enable to let this agent retrieve context from your ingested documents.
          </p>
        )}
      </section>

      {/* Tools */}
      <section>
        <p className={sectionTitleCls}><Wrench size={15} className="text-emerald-500" />Tools</p>

        {/* Own A2A */}
        <div className="flex items-center gap-3 mb-4">
          <input
            type="checkbox"
            id="use_own_a2a"
            checked={tools.use_own_a2a}
            onChange={(e) => setTools((t) => ({ ...t, use_own_a2a: e.target.checked }))}
            className="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-violet-600 focus:ring-violet-500"
          />
          <label htmlFor="use_own_a2a" className="text-sm text-slate-700 dark:text-slate-200 cursor-pointer">
            Internal A2A endpoint (this lab's own agent)
          </label>
        </div>

        {/* MCP Servers */}
        <div className="mb-4">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">MCP Servers</p>
          {registeredConnections.mcp.length === 0 ? (
            <p className="text-xs text-slate-400 dark:text-slate-500 italic">No MCP servers registered. Add them in Connections.</p>
          ) : (
            <div className="space-y-1.5">
              {registeredConnections.mcp.map((conn) => (
                <label key={conn.id} className="flex items-center gap-3 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={tools.mcp_connection_ids.includes(conn.id)}
                    onChange={() => toggleMcp(conn.id)}
                    className="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm text-slate-700 dark:text-slate-200">{conn.name}</span>
                  {conn.transport && (
                    <span className="text-[10px] font-mono bg-blue-50 dark:bg-blue-900/40 text-blue-600 dark:text-blue-300 border border-blue-200 dark:border-blue-700 px-1.5 py-0.5 rounded">
                      {conn.transport === 'streamable_http' ? 'HTTP' : 'SSE'}
                    </span>
                  )}
                  <span className="text-xs text-slate-400 dark:text-slate-500 truncate">{conn.server_url}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Sub-agents */}
        <div className="mb-4">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Sub-agents (orchestration)</p>
          <p className="text-xs text-slate-400 dark:text-slate-500 mb-2">
            Select other agents this agent can delegate tasks to. The LLM will call them as tools.
          </p>
          {allAgents.filter((a) => a.id !== agent.id).length === 0 ? (
            <p className="text-xs text-slate-400 dark:text-slate-500 italic">No other agents yet. Create more agents to enable orchestration.</p>
          ) : (
            <div className="space-y-1.5">
              {allAgents.filter((a) => a.id !== agent.id).map((a) => (
                <label key={a.id} className="flex items-center gap-3 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={(tools.agent_ids ?? []).includes(a.id)}
                    onChange={() => toggleAgent(a.id)}
                    className="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-violet-600 focus:ring-violet-500"
                  />
                  <span className="text-sm text-slate-700 dark:text-slate-200">{a.name}</span>
                  {a.role && <span className="text-xs text-slate-400 dark:text-slate-500 truncate italic">{a.role}</span>}
                </label>
              ))}
            </div>
          )}
        </div>

        {/* A2A Agents */}
        <div>
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">External A2A Agents</p>
          {registeredConnections.a2a.length === 0 ? (
            <p className="text-xs text-slate-400 dark:text-slate-500 italic">No A2A agents registered. Add them in Connections.</p>
          ) : (
            <div className="space-y-1.5">
              {registeredConnections.a2a.map((conn) => (
                <label key={conn.id} className="flex items-center gap-3 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={tools.a2a_connection_ids.includes(conn.id)}
                    onChange={() => toggleA2a(conn.id)}
                    className="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-violet-600 focus:ring-violet-500"
                  />
                  <span className="text-sm text-slate-700 dark:text-slate-200">{conn.name}</span>
                  <span className="text-xs text-slate-400 dark:text-slate-500 truncate">{conn.task_url}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Save */}
      <div className="pt-2 border-t border-slate-200 dark:border-slate-700">
        <button
          onClick={handleSave}
          disabled={saving || !name.trim()}
          className="flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {saving ? 'Saving…' : 'Save agent'}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Chat tab
// ---------------------------------------------------------------------------

function ChatTab({ agent }: { agent: AgentConfig }) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setMessages([])
    setInput('')
  }, [agent.id])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  async function handleSend() {
    const text = input.trim()
    if (!text || loading) return

    const userMsg: ChatMessage = { role: 'user', content: text }
    const updated = [...messages, userMsg]
    setMessages(updated)
    setInput('')
    setLoading(true)

    try {
      const history = messages.map((m) => ({ role: m.role, content: m.content }))
      const res = await api.chatWithAgentConfig(agent.id, text, history)
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: res.answer,
        latency_ms: res.latency_ms,
        rag_used: res.rag_used,
      }
      setMessages([...updated, assistantMsg])
    } catch (err: any) {
      setMessages([...updated, {
        role: 'assistant',
        content: `Error: ${err?.response?.data?.detail ?? err?.message ?? 'Unknown error'}`,
      }])
    } finally {
      setLoading(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-4 pr-1 pb-2 min-h-0">
        {messages.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center h-full text-slate-400 dark:text-slate-500">
            <MessageSquare size={40} className="mb-3 text-slate-300 dark:text-slate-600" />
            <p className="text-sm font-medium">{agent.name} is ready</p>
            <p className="text-xs mt-1 text-center max-w-xs">
              {agent.role || 'Send a message to start the conversation.'}
            </p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i}>
            {msg.role === 'user' ? (
              <div className="flex justify-end">
                <div className="flex items-start gap-2 max-w-[80%]">
                  <div className="bg-violet-600 text-white rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm leading-relaxed">
                    {msg.content}
                  </div>
                  <div className="flex-shrink-0 w-7 h-7 rounded-full bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center mt-0.5">
                    <User size={14} className="text-violet-600 dark:text-violet-300" />
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex justify-start">
                <div className="flex items-start gap-2 max-w-[85%]">
                  <div className="flex-shrink-0 w-7 h-7 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center mt-0.5">
                    <Bot size={14} className="text-slate-600 dark:text-slate-300" />
                  </div>
                  <div className="space-y-1.5">
                    <div className="bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm text-slate-800 dark:text-slate-100 leading-relaxed shadow-sm whitespace-pre-wrap">
                      {msg.content}
                    </div>
                    {(msg.latency_ms !== undefined || msg.rag_used) && (
                      <div className="flex items-center gap-2 pl-1">
                        {msg.latency_ms !== undefined && (
                          <span className="text-xs text-slate-400">{(msg.latency_ms / 1000).toFixed(1)}s</span>
                        )}
                        {msg.rag_used && (
                          <span className="text-xs bg-blue-50 dark:bg-blue-900/40 text-blue-600 dark:text-blue-300 border border-blue-200 dark:border-blue-700 px-1.5 py-0.5 rounded font-mono">
                            RAG
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center">
                <Bot size={14} className="text-slate-600 dark:text-slate-300" />
              </div>
              <div className="bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-2xl rounded-tl-sm px-4 py-2.5 shadow-sm">
                <Loader2 size={16} className="text-slate-400 animate-spin" />
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="mt-3 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-2xl shadow-sm flex items-end gap-2 px-4 py-3">
        <textarea
          className="flex-1 resize-none text-sm text-slate-800 dark:text-slate-100 bg-transparent focus:outline-none max-h-40 leading-relaxed placeholder-slate-400 dark:placeholder-slate-500"
          placeholder={`Message ${agent.name}… (Enter to send, Shift+Enter for newline)`}
          rows={1}
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            e.target.style.height = 'auto'
            e.target.style.height = e.target.scrollHeight + 'px'
          }}
          onKeyDown={handleKeyDown}
        />
        <button
          onClick={handleSend}
          disabled={!input.trim() || loading}
          className="flex-shrink-0 w-8 h-8 rounded-xl bg-violet-600 hover:bg-violet-700 disabled:bg-slate-200 dark:disabled:bg-slate-700 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
        >
          <Send size={14} className="text-white" />
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function Agents() {
  const [agents, setAgents] = useState<AgentConfig[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tab, setTab] = useState<'configure' | 'chat'>('configure')
  const [saving, setSaving] = useState(false)
  const [creating, setCreating] = useState(false)
  const [loading, setLoading] = useState(true)
  const [registeredConnections, setRegisteredConnections] = useState<{ a2a: any[]; mcp: any[] }>({ a2a: [], mcp: [] })

  useEffect(() => {
    Promise.all([
      api.listAgentConfigs(),
      api.getRegisteredConnections(),
    ]).then(([configs, conns]) => {
      setAgents(configs)
      setRegisteredConnections({
        a2a: (conns.a2a ?? []).map((c: any) => ({ ...c, type: 'a2a' })),
        mcp: (conns.mcp ?? []).map((c: any) => ({ ...c, type: 'mcp' })),
      })
      if (configs.length > 0 && !selectedId) setSelectedId(configs[0].id)
    }).catch(console.error).finally(() => setLoading(false))
  }, [])

  const selectedAgent = agents.find((a) => a.id === selectedId) ?? null

  async function handleCreate() {
    setCreating(true)
    try {
      const agent = await api.createAgentConfig({
        name: `Agent ${agents.length + 1}`,
        role: '',
        system_prompt: '',
        tools: DEFAULT_TOOLS,
        rag: DEFAULT_RAG,
      })
      setAgents((prev) => [...prev, agent])
      setSelectedId(agent.id)
      setTab('configure')
    } catch (err) {
      console.error(err)
    } finally {
      setCreating(false)
    }
  }

  async function handleDelete(id: string) {
    await api.deleteAgentConfig(id).catch(console.error)
    const updated = agents.filter((a) => a.id !== id)
    setAgents(updated)
    if (selectedId === id) {
      setSelectedId(updated.length > 0 ? updated[0].id : null)
    }
  }

  async function handleSave(data: Omit<AgentConfig, 'id' | 'created_at' | 'updated_at'>) {
    if (!selectedId) return
    setSaving(true)
    try {
      const updated = await api.updateAgentConfig(selectedId, data)
      setAgents((prev) => prev.map((a) => a.id === selectedId ? updated : a))
    } catch (err) {
      console.error(err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex gap-4 h-[calc(100vh-6rem)]">
      {/* Sidebar */}
      <aside className="w-52 flex-shrink-0 flex flex-col bg-slate-900 rounded-xl overflow-hidden">
        <div className="px-3 pt-3 pb-2 border-b border-slate-700">
          <button
            onClick={handleCreate}
            disabled={creating}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs font-medium transition-colors disabled:opacity-50"
          >
            {creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={13} />}
            New agent
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
          {loading ? (
            <div className="flex justify-center py-6"><Loader2 size={14} className="animate-spin text-slate-500" /></div>
          ) : agents.length === 0 ? (
            <p className="text-xs text-slate-500 text-center py-6 px-3">No agents yet. Create your first one.</p>
          ) : agents.map((agent) => (
            <AgentListItem
              key={agent.id}
              agent={agent}
              active={agent.id === selectedId}
              onSelect={() => setSelectedId(agent.id)}
              onDelete={() => handleDelete(agent.id)}
            />
          ))}
        </div>
      </aside>

      {/* Main panel */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        {/* Page header */}
        <div className="flex items-center justify-between mb-4 flex-shrink-0">
          <div>
            <h1 className="text-2xl font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
              <Bot size={24} className="text-violet-600" />
              Agents
            </h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              Create and configure AI agents with custom roles, system prompts, tools and RAG access
            </p>
          </div>
        </div>

        {!selectedAgent ? (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-400 dark:text-slate-500">
            <Bot size={48} className="mb-3 text-slate-300 dark:text-slate-600" />
            <p className="text-base font-medium">No agent selected</p>
            <p className="text-sm mt-1">Create a new agent using the sidebar.</p>
          </div>
        ) : (
          <div className="flex-1 flex flex-col min-h-0 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
            {/* Tabs */}
            <div className="flex items-center gap-1 px-4 pt-3 pb-0 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
              <button
                onClick={() => setTab('configure')}
                className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-t-lg transition-colors border-b-2 -mb-px ${
                  tab === 'configure'
                    ? 'border-violet-600 text-violet-700 dark:text-violet-400'
                    : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                }`}
              >
                <Settings2 size={14} />
                Configure
              </button>
              <button
                onClick={() => setTab('chat')}
                className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-t-lg transition-colors border-b-2 -mb-px ${
                  tab === 'chat'
                    ? 'border-violet-600 text-violet-700 dark:text-violet-400'
                    : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                }`}
              >
                <MessageSquare size={14} />
                Chat
              </button>
              <div className="ml-auto flex items-center gap-2 pb-2">
                <span className="text-xs text-slate-400 dark:text-slate-500 font-medium">{selectedAgent.name}</span>
                {selectedAgent.role && (
                  <span className="text-xs text-slate-400 dark:text-slate-500">·</span>
                )}
                {selectedAgent.role && (
                  <span className="text-xs text-slate-400 dark:text-slate-500 italic truncate max-w-xs">{selectedAgent.role}</span>
                )}
              </div>
            </div>

            {/* Tab content */}
            <div className={`flex-1 min-h-0 p-5 ${tab === 'chat' ? 'flex flex-col' : 'overflow-y-auto'}`}>
              {tab === 'configure' ? (
                <ConfigureTab
                  agent={selectedAgent}
                  onSave={handleSave}
                  saving={saving}
                  registeredConnections={registeredConnections}
                  allAgents={agents}
                />
              ) : (
                <ChatTab agent={selectedAgent} />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
