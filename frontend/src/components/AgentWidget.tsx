import { useState, useEffect, useRef } from 'react'
import { Bot, X, Send, Trash2, Loader2, ChevronDown, ChevronUp, Maximize2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import { useAppStore } from '../store/useAppStore'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface Source {
  chunk_id: string
  doc_id: string
  content: string
  score: number
}

interface Turn {
  type: 'user' | 'assistant'
  message: ChatMessage
  sources?: Source[]
  latency_ms?: number
}

export function AgentWidget() {
  const { activeSessionId, setActiveSessionId } = useAppStore()
  const [open, setOpen] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [expandedSources, setExpandedSources] = useState<Set<number>>(new Set())
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const navigate = useNavigate()
  const loadedSessionRef = useRef<string | null>(null)

  // If no shared session exists yet, initialise one when the widget first opens
  useEffect(() => {
    if (!open || activeSessionId) return
    api.listAgentSessions().then(async (list) => {
      if (list.length > 0) {
        setActiveSessionId(list[0].id)
      } else {
        const s = await api.createAgentSession()
        setActiveSessionId(s.id)
      }
    }).catch(console.error)
  }, [open, activeSessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load messages whenever the shared active session changes (and widget is open)
  useEffect(() => {
    if (!open || !activeSessionId || activeSessionId === loadedSessionRef.current) return
    loadedSessionRef.current = activeSessionId
    api.getSessionMessages(activeSessionId).then((messages) => {
      setTurns(messages.map((m: { role: string; content: string }) => {
        const msg = m as ChatMessage
        return msg.role === 'user'
          ? { type: 'user' as const, message: msg }
          : { type: 'assistant' as const, message: msg, sources: [] }
      }))
    }).catch(console.error)
  }, [open, activeSessionId])

  // Scroll to bottom on new messages
  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [turns, loading, open])

  // Focus input when opening
  useEffect(() => {
    if (open) setTimeout(() => textareaRef.current?.focus(), 50)
  }, [open])

  function toggleSources(i: number) {
    setExpandedSources((prev) => {
      const next = new Set(prev)
      next.has(i) ? next.delete(i) : next.add(i)
      return next
    })
  }

  async function handleSend() {
    const message = input.trim()
    if (!message || loading) return

    const userTurn: Turn = { type: 'user', message: { role: 'user', content: message } }
    const newTurns = [...turns, userTurn]
    setTurns(newTurns)
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
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
      if (activeSessionId) {
        await api.saveSessionMessages(activeSessionId, finalTurns.map((t) => t.message)).catch(console.error)
      }
    } catch (err: any) {
      setTurns([
        ...newTurns,
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: `Error: ${err?.response?.data?.detail ?? err?.message ?? 'Unknown error'}`,
          },
          sources: [],
        },
      ])
    } finally {
      setLoading(false)
    }
  }

  async function handleClear() {
    // Create a new session — both widget and Agent page will switch to it
    const s = await api.createAgentSession().catch(() => null)
    if (s) {
      loadedSessionRef.current = s.id  // mark as loaded so we don't re-fetch empty messages
      setActiveSessionId(s.id)
    }
    setTurns([])
    setExpandedSources(new Set())
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <>
      {/* Floating button */}
      <button
        onClick={() => setOpen((v) => !v)}
        className={`fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full shadow-lg flex items-center justify-center transition-all duration-200
          ${open
            ? 'bg-slate-700 hover:bg-slate-800 rotate-0'
            : 'bg-blue-600 hover:bg-blue-700 hover:scale-105'
          }`}
        title="System Agent"
      >
        {open
          ? <X size={22} className="text-white" />
          : <Bot size={24} className="text-white" />
        }
        {/* Unread dot — shown when closed and there are messages */}
        {!open && turns.length > 0 && (
          <span className="absolute top-1 right-1 w-3 h-3 bg-green-400 rounded-full border-2 border-white" />
        )}
      </button>

      {/* Chat panel */}
      {open && (
        <div
          className="fixed bottom-24 right-6 z-50 w-96 bg-white dark:bg-slate-800 dark:border-slate-700 rounded-2xl shadow-2xl border border-slate-200 flex flex-col overflow-hidden"
          style={{ height: '560px' }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-blue-600 to-blue-700 text-white">
            <div className="flex items-center gap-2">
              <Bot size={18} />
              <div>
                <p className="text-sm font-semibold leading-tight">System Agent</p>
                <p className="text-xs text-blue-200 leading-tight">Platform expert · APIs, config, features</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => { setOpen(false); navigate('/agent') }}
                className="p-1.5 rounded-lg hover:bg-blue-500 transition-colors"
                title="Open full view"
              >
                <Maximize2 size={14} />
              </button>
              <button
                onClick={handleClear}
                className="p-1.5 rounded-lg hover:bg-blue-500 transition-colors"
                title="Clear conversation"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-3 space-y-3 bg-slate-50 dark:bg-slate-900">
            {turns.length === 0 && !loading && (
              <div className="flex flex-col items-center justify-center h-full text-slate-400 dark:text-slate-500 text-center px-4">
                <Bot size={36} className="mb-2 text-slate-300 dark:text-slate-600" />
                <p className="text-sm font-medium">Ask about platform configuration</p>
                <p className="text-xs mt-1">APIs, retrieval modes, config, graph, benchmarks…</p>
              </div>
            )}

            {turns.map((turn, i) => (
              <div key={i}>
                {turn.type === 'user' ? (
                  <div className="flex justify-end">
                    <div className="bg-blue-600 text-white rounded-2xl rounded-tr-sm px-3 py-2 text-sm max-w-[80%] leading-relaxed">
                      {turn.message.content}
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    <div className="bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-2xl rounded-tl-sm px-3 py-2 text-sm text-slate-800 dark:text-slate-100 leading-relaxed shadow-sm whitespace-pre-wrap max-w-[85%]">
                      {turn.message.content}
                    </div>
                    {(turn.latency_ms !== undefined || (turn.sources && turn.sources.length > 0)) && (
                      <div>
                        <div className="flex items-center gap-2 ml-1">
                          {turn.latency_ms !== undefined && (
                            <span className="text-xs text-slate-400 dark:text-slate-500">{(turn.latency_ms / 1000).toFixed(1)}s</span>
                          )}
                          {turn.sources && turn.sources.length > 0 && (
                            <button
                              onClick={() => toggleSources(i)}
                              className="flex items-center gap-1 text-xs text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                            >
                              {expandedSources.has(i) ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                              {turn.sources.length} source{turn.sources.length !== 1 ? 's' : ''}
                            </button>
                          )}
                        </div>
                        {turn.sources && expandedSources.has(i) && (
                          <div className="mt-1 space-y-1 max-h-60 overflow-y-auto">
                            {turn.sources.map((src, si) => (
                              <div
                                key={si}
                                className="bg-slate-100 dark:bg-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-600 dark:text-slate-300"
                              >
                                <div className="flex justify-between mb-0.5 text-slate-400 dark:text-slate-500">
                                  <span className="truncate max-w-[160px] font-medium">{src.doc_id}</span>
                                  <span>{src.score.toFixed(2)}</span>
                                </div>
                                <p className="line-clamp-2">{src.content}</p>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}

            {loading && (
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center">
                  <Bot size={12} className="text-slate-500 dark:text-slate-400" />
                </div>
                <div className="bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-2xl rounded-tl-sm px-3 py-2 shadow-sm">
                  <Loader2 size={14} className="text-slate-400 dark:text-slate-500 animate-spin" />
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="border-t border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 flex items-end gap-2">
            <textarea
              ref={textareaRef}
              className="flex-1 resize-none text-sm text-slate-800 dark:text-slate-100 bg-transparent focus:outline-none max-h-28 leading-relaxed placeholder-slate-400 dark:placeholder-slate-500"
              placeholder="Ask about platform configuration… (Enter to send)"
              rows={1}
              value={input}
              onChange={(e) => {
                setInput(e.target.value)
                e.target.style.height = 'auto'
                e.target.style.height = Math.min(e.target.scrollHeight, 112) + 'px'
              }}
              onKeyDown={handleKeyDown}
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || loading}
              className="flex-shrink-0 w-8 h-8 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 dark:disabled:bg-slate-600 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
            >
              <Send size={13} className="text-white" />
            </button>
          </div>
        </div>
      )}
    </>
  )
}
