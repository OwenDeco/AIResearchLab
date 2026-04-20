import { useState, useEffect, useRef } from 'react'
import { Send, Bot, User, ChevronDown, ChevronUp, Loader2, Plus, Pencil, Check, X, Trash2 } from 'lucide-react'
import { api } from '../api/client'
import { useAppStore } from '../store/useAppStore'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface SourceItem {
  chunk_id: string
  doc_id: string
  content: string
  score: number
}

interface SessionMeta {
  id: string
  name: string
  created_at: string
  last_active: string
  message_count: number
}

type Turn =
  | { type: 'user'; message: ChatMessage }
  | { type: 'assistant'; message: ChatMessage; sources: SourceItem[]; latency_ms?: number }

function SessionItem({
  session,
  active,
  onSelect,
  onDelete,
  onRename,
}: {
  session: SessionMeta
  active: boolean
  onSelect: () => void
  onDelete: () => void
  onRename: (name: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.name)

  function commitRename() {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== session.name) onRename(trimmed)
    setEditing(false)
  }

  return (
    <div
      onClick={() => !editing && onSelect()}
      className={`group relative rounded-lg px-3 py-2.5 cursor-pointer transition-colors ${
        active ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-800'
      }`}
    >
      {editing ? (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <input
            autoFocus
            className="flex-1 bg-slate-600 text-white text-xs rounded px-1.5 py-0.5 focus:outline-none min-w-0"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') setEditing(false)
            }}
          />
          <button onClick={commitRename} className="text-emerald-400 hover:text-emerald-300 flex-shrink-0"><Check size={12} /></button>
          <button onClick={() => setEditing(false)} className="text-slate-400 hover:text-slate-200 flex-shrink-0"><X size={12} /></button>
        </div>
      ) : (
        <>
          <p className="text-xs font-medium truncate pr-10">{session.name}</p>
          <p className="text-[10px] mt-0.5 opacity-60">
            {session.message_count} msg{session.message_count !== 1 ? 's' : ''} ·{' '}
            {new Date(session.last_active).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </p>
          {/* Actions shown on hover */}
          <div className="absolute right-2 top-1/2 -translate-y-1/2 hidden group-hover:flex items-center gap-1">
            <button
              onClick={(e) => { e.stopPropagation(); setEditing(true) }}
              className="p-0.5 rounded hover:text-white opacity-60 hover:opacity-100"
              title="Rename"
            >
              <Pencil size={11} />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onDelete() }}
              className="p-0.5 rounded hover:text-red-400 opacity-60 hover:opacity-100"
              title="Delete"
            >
              <Trash2 size={11} />
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export function Agent() {
  const { activeSessionId, setActiveSessionId } = useAppStore()
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [expandedSources, setExpandedSources] = useState<Set<number>>(new Set())
  const bottomRef = useRef<HTMLDivElement>(null)
  // Track which session's messages are currently loaded so we can detect external changes
  const loadedSessionRef = useRef<string | null>(null)

  // Load session list on mount; if no shared session yet, pick the most recent or create one
  useEffect(() => {
    api.listAgentSessions().then(async (list) => {
      setSessions(list)
      if (list.length === 0) {
        const s = await api.createAgentSession()
        setSessions([s])
        setActiveSessionId(s.id)
      } else if (!activeSessionId) {
        setActiveSessionId(list[0].id)
      }
      // If activeSessionId is already set (e.g. widget set it), the effect below will load messages
    }).catch(console.error)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Load messages whenever the shared active session changes
  useEffect(() => {
    if (!activeSessionId || activeSessionId === loadedSessionRef.current) return
    loadedSessionRef.current = activeSessionId
    setTurns([])
    setExpandedSources(new Set())
    api.getSessionMessages(activeSessionId).then((messages) => {
      setTurns(messages.map((m) => {
        const msg = m as ChatMessage
        return msg.role === 'user'
          ? { type: 'user' as const, message: msg }
          : { type: 'assistant' as const, message: msg, sources: [] }
      }))
    }).catch(console.error)
  }, [activeSessionId])

  // Scroll to bottom whenever turns change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [turns, loading])

  function switchSession(sessionId: string) {
    if (sessionId === activeSessionId) return
    setActiveSessionId(sessionId) // store update triggers the load effect above
  }

  async function handleNewSession() {
    const s = await api.createAgentSession().catch(() => null)
    if (!s) return
    setSessions((prev) => [s, ...prev])
    setActiveSessionId(s.id) // store update; load effect clears turns and loads (empty) messages
  }

  async function handleDeleteSession(sessionId: string) {
    await api.deleteAgentSession(sessionId).catch(console.error)
    const updated = sessions.filter((s) => s.id !== sessionId)
    setSessions(updated)
    if (activeSessionId === sessionId) {
      if (updated.length > 0) {
        switchSession(updated[0].id)
      } else {
        // Auto-create a new session when all are deleted
        const s = await api.createAgentSession().catch(() => null)
        if (s) {
          setSessions([s])
          setActiveSessionId(s.id)
          setTurns([])
        }
      }
    }
  }

  async function handleRenameSession(sessionId: string, name: string) {
    const updated = await api.renameAgentSession(sessionId, name).catch(() => null)
    if (updated) {
      setSessions((prev) => prev.map((s) => s.id === sessionId ? { ...s, name: updated.name } : s))
    }
  }

  function toggleSources(index: number) {
    setExpandedSources((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  async function handleSend() {
    const message = input.trim()
    if (!message || loading || !activeSessionId) return

    const userTurn: Turn = { type: 'user', message: { role: 'user', content: message } }
    const newTurns = [...turns, userTurn]
    setTurns(newTurns)
    setInput('')
    setLoading(true)

    const history = turns.map((t) => t.message)

    try {
      const res = await api.agentChat(message, history)
      const assistantTurn: Turn = {
        type: 'assistant',
        message: { role: 'assistant', content: res.answer },
        sources: res.sources,
        latency_ms: res.latency_ms,
      }
      const finalTurns = [...newTurns, assistantTurn]
      setTurns(finalTurns)

      // Persist to active session
      const flatMessages = finalTurns.map((t) => t.message)
      if (activeSessionId) {
        await api.saveSessionMessages(activeSessionId, flatMessages).catch(console.error)
      }

      // Update session metadata in sidebar
      setSessions((prev) => prev.map((s) =>
        s.id === activeSessionId
          ? { ...s, message_count: flatMessages.length, last_active: new Date().toISOString() }
          : s
      ))
    } catch (err: any) {
      const errorTurn: Turn = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: `Error: ${err?.response?.data?.detail ?? err?.message ?? 'Unknown error'}`,
        },
        sources: [],
      }
      setTurns([...newTurns, errorTurn])
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
    <div className="flex gap-4 h-[calc(100vh-6rem)]">
      {/* Sessions sidebar */}
      <aside className="w-52 flex-shrink-0 flex flex-col bg-slate-900 rounded-xl overflow-hidden">
        <div className="px-3 pt-3 pb-2 border-b border-slate-700">
          <button
            onClick={handleNewSession}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs font-medium transition-colors"
          >
            <Plus size={13} />
            New session
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
          {sessions.map((s) => (
            <SessionItem
              key={s.id}
              session={s}
              active={s.id === activeSessionId}
              onSelect={() => switchSession(s.id)}
              onDelete={() => handleDeleteSession(s.id)}
              onRename={(name) => handleRenameSession(s.id, name)}
            />
          ))}
        </div>
      </aside>

      {/* Chat area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
              <Bot size={24} className="text-blue-600" />
              RAG Lab Agent
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">
              Project expert · APIs, features, configuration, parameters
            </p>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto space-y-4 pr-1 pb-2">
          {turns.length === 0 && !loading && (
            <div className="flex flex-col items-center justify-center h-full text-slate-400">
              <Bot size={48} className="mb-3 text-slate-300" />
              <p className="text-base font-medium">Ask anything about the RAG Lab</p>
              <p className="text-sm mt-1">APIs, retrieval modes, configuration, graph extraction, benchmarking…</p>
            </div>
          )}

          {turns.map((turn, i) => (
            <div key={i}>
              {turn.type === 'user' ? (
                <div className="flex justify-end">
                  <div className="flex items-start gap-2 max-w-[80%]">
                    <div className="bg-blue-600 text-white rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm leading-relaxed">
                      {turn.message.content}
                    </div>
                    <div className="flex-shrink-0 w-7 h-7 rounded-full bg-blue-100 flex items-center justify-center mt-0.5">
                      <User size={14} className="text-blue-600" />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex justify-start">
                  <div className="flex items-start gap-2 max-w-[85%]">
                    <div className="flex-shrink-0 w-7 h-7 rounded-full bg-slate-200 flex items-center justify-center mt-0.5">
                      <Bot size={14} className="text-slate-600" />
                    </div>
                    <div className="space-y-2">
                      <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm text-slate-800 leading-relaxed shadow-sm whitespace-pre-wrap">
                        {turn.message.content}
                      </div>

                      {/* Latency + sources row */}
                      <div className="flex items-center gap-3">
                        {turn.latency_ms !== undefined && (
                          <span className="text-xs text-slate-400">{(turn.latency_ms / 1000).toFixed(1)}s</span>
                        )}
                        {turn.sources && turn.sources.length > 0 && (
                          <button
                            onClick={() => toggleSources(i)}
                            className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 transition-colors"
                          >
                            {expandedSources.has(i) ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                            {turn.sources.length} source{turn.sources.length !== 1 ? 's' : ''}
                          </button>
                        )}
                      </div>

                      {turn.sources && expandedSources.has(i) && (
                        <div className="space-y-1.5">
                          {turn.sources.map((src, si) => (
                            <div
                              key={si}
                              className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-600"
                            >
                              <div className="flex justify-between mb-1 font-medium text-slate-500">
                                <span className="truncate max-w-xs">{src.doc_id}</span>
                                <span className="ml-2 text-slate-400">score {src.score.toFixed(3)}</span>
                              </div>
                              <p className="line-clamp-3">{src.content}</p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}

          {/* Typing indicator */}
          {loading && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-full bg-slate-200 flex items-center justify-center">
                  <Bot size={14} className="text-slate-600" />
                </div>
                <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-sm px-4 py-2.5 shadow-sm">
                  <Loader2 size={16} className="text-slate-400 animate-spin" />
                </div>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="mt-3 bg-white border border-slate-300 rounded-2xl shadow-sm flex items-end gap-2 px-4 py-3">
          <textarea
            className="flex-1 resize-none text-sm text-slate-800 focus:outline-none max-h-40 leading-relaxed"
            placeholder="Ask about APIs, retrieval modes, config… (Enter to send, Shift+Enter for newline)"
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
            className="flex-shrink-0 w-8 h-8 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
          >
            <Send size={14} className="text-white disabled:text-slate-400" />
          </button>
        </div>
      </div>
    </div>
  )
}
