import { useEffect, useRef, useState } from 'react'
import { Loader2, MessageCircle, Play, RefreshCw, RotateCcw, Square, Send, UserCircle2 } from 'lucide-react'
import { PixelSprite } from './PixelSprite'
import { spriteLibrary } from './spriteLibrary'
import { api } from '../../api/client'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentConfig {
  id: string
  name: string
  role: string
}

interface DebateTurn {
  id: string
  agent_id: string
  agent_name: string
  role: string
  content: string
  turn_type: 'open' | 'speak' | 'moderate' | 'close'
  timestamp: string
}

interface OSDebateSession {
  id: string
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'waiting_for_human'
  host_id: string | null
  guest_ids: string[]
  topic: string
  rounds: number
  turns: DebateTurn[]
  started_at: string
  ended_at: string | null
  source?: string
  human_in_loop?: boolean
  os_rounds_done?: number
  total_human_rounds?: number
}

// ---------------------------------------------------------------------------
// Fixed agent map — the 3 OS debate participants
// ---------------------------------------------------------------------------

const OS_AGENT_MAP: Record<string, AgentConfig> = {
  host:       { id: 'host',       name: 'Host',    role: 'Debate Moderator'  },
  optimistic: { id: 'optimistic', name: 'Optimist', role: 'Optimistic Agent' },
  critical:   { id: 'critical',   name: 'Critic',   role: 'Critical Agent'   },
  human:      { id: 'human',      name: 'You',      role: 'Guest Speaker'    },
}

// ---------------------------------------------------------------------------
// Typewriter constants
// ---------------------------------------------------------------------------

const CHARS_PER_TICK = 4
const TICK_MS        = 150
const INTER_TURN_MS  = 900

// ---------------------------------------------------------------------------
// Stage layout — identical to DebateRoom
// ---------------------------------------------------------------------------

const AGENT_SLOTS = [
  { role: 'host',   x: 50, y: 22, spriteId: 'coderBlue',      balloonBg: '#fbbf24', balloonText: '#1c1917', label: 'Host'    },
  { role: 'guest1', x: 18, y: 68, spriteId: 'plannerGreen',   balloonBg: '#10b981', balloonText: '#ffffff', label: 'Guest 1' },
  { role: 'guest2', x: 82, y: 68, spriteId: 'reviewerPurple', balloonBg: '#8b5cf6', balloonText: '#ffffff', label: 'Guest 2' },
  { role: 'human',  x: 50, y: 88, spriteId: 'guestOrange',    balloonBg: '#f97316', balloonText: '#ffffff', label: 'You'     },
]

// ---------------------------------------------------------------------------
// SpeechBalloon — identical to DebateRoom
// ---------------------------------------------------------------------------

function SpeechBalloon({
  text, bg, textColor, isActive, isTyping, maxHeight = '110px',
}: {
  text: string; bg: string; textColor: string; isActive: boolean; isTyping: boolean; maxHeight?: string
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [text])

  return (
    <div className="absolute bottom-full mb-3 z-10" style={{ left: '50%', transform: 'translateX(-50%)', width: '190px' }}>
      <div
        className={`relative rounded-xl px-3 py-2.5 text-xs leading-snug shadow-lg transition-all duration-300 ${
          isActive ? 'opacity-100 scale-100' : 'opacity-55 scale-95'
        }`}
        style={{ backgroundColor: bg, color: textColor }}
      >
        <div ref={scrollRef} style={{ maxHeight, overflowY: 'auto' }}>
          <span className="whitespace-pre-line">{text}</span>
          {isTyping && (
            <span className="inline-block w-[2px] h-[11px] ml-[1px] align-middle animate-pulse" style={{ backgroundColor: textColor, opacity: 0.8 }} />
          )}
        </div>
        <div
          className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0"
          style={{ borderLeft: '7px solid transparent', borderRight: '7px solid transparent', borderTop: `9px solid ${bg}` }}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// BalloonView
// ---------------------------------------------------------------------------

interface BalloonView {
  text: string
  isTyping: boolean
  turnType: string
}

// ---------------------------------------------------------------------------
// DebateStage — identical to DebateRoom
// ---------------------------------------------------------------------------

function DebateStage({
  session, agentMap, balloonViews, activeSpeakerId, isWaiting, isWaitingForHuman,
}: {
  session: OSDebateSession
  agentMap: Record<string, AgentConfig>
  balloonViews: Record<string, BalloonView>
  activeSpeakerId: string | null
  isWaiting: boolean
  isWaitingForHuman: boolean
}) {
  const speakOrder  = [session.host_id ?? '', ...session.guest_ids]
  const lastIdx     = speakOrder.indexOf(activeSpeakerId ?? '')
  const nextAgentId = isWaiting ? speakOrder[(lastIdx + 1) % speakOrder.length] : null

  const participants: { agent: AgentConfig; slot: typeof AGENT_SLOTS[0] }[] = []
  const hostAgent = session.host_id ? agentMap[session.host_id] : null
  if (hostAgent) participants.push({ agent: hostAgent, slot: AGENT_SLOTS[0] })
  session.guest_ids.forEach((gid, i) => {
    const agent = agentMap[gid]
    const slot  = AGENT_SLOTS[i + 1]
    if (agent && slot) participants.push({ agent, slot })
  })
  if (session.human_in_loop) {
    participants.push({ agent: agentMap['human'], slot: AGENT_SLOTS[3] })
  }

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-inner">
      <div
        className="relative mx-auto rounded-lg border-4 border-slate-700"
        style={{ height: '520px', maxWidth: '900px', background: 'radial-gradient(ellipse at 50% 0%, #1e3a5f 0%, #0f172a 70%)' }}
      >
        {/* Spotlight */}
        <div
          className="absolute top-0 left-1/2 -translate-x-1/2 w-32 opacity-10 pointer-events-none"
          style={{ height: '200px', background: 'linear-gradient(to bottom, #fbbf24, transparent)', clipPath: 'polygon(30% 0%, 70% 0%, 100% 100%, 0% 100%)' }}
        />
        {/* Floor glow */}
        <div className="absolute bottom-0 left-0 right-0 h-20 rounded-b-lg pointer-events-none" style={{ background: 'linear-gradient(to top, #312e8133, transparent)' }} />

        {/* Topic label — sits on the round table */}
        <div className="absolute -translate-x-1/2 group z-10" style={{ top: '57%', left: '50%' }}>
          <div className="px-3 py-1 bg-slate-800/90 border border-slate-600 rounded-full text-xs text-slate-300 max-w-[200px] text-center truncate cursor-default select-none">
            {session.topic}
          </div>
          <div className="absolute top-full mt-2 left-1/2 -translate-x-1/2 hidden group-hover:block w-64 bg-slate-900 border border-slate-500 rounded-lg px-3 py-2 text-xs text-slate-200 shadow-2xl text-center leading-relaxed pointer-events-none">
            {session.topic}
          </div>
        </div>

        {/* Status */}
        <div className="absolute top-3 right-3 text-xs">
          {session.status === 'running'           && <span className="flex items-center gap-1 text-green-400"><span className="animate-pulse">●</span> live</span>}
          {session.status === 'waiting_for_human' && <span className="flex items-center gap-1 text-orange-400"><span className="animate-pulse">●</span> your turn</span>}
          {session.status === 'completed'         && <span className="text-blue-400">● done</span>}
          {session.status === 'failed'            && <span className="text-red-400">● failed</span>}
          {session.status === 'stopped'           && <span className="text-orange-400">● stopped</span>}
        </div>

        {/* Round table */}
        <div className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none z-0" style={{ top: '60%' }}>
          <div style={{
            width: '296px', height: '184px', borderRadius: '50%',
            background: 'radial-gradient(ellipse at 38% 32%, #c8915e 0%, #8b5e2c 50%, #5a3a14 100%)',
            border: '3px solid #6b4420',
            boxShadow: '0 6px 20px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,220,150,0.15)',
            position: 'relative', overflow: 'hidden',
          }}>
            <div style={{
              position: 'absolute', inset: 0, borderRadius: '50%',
              background: 'radial-gradient(ellipse at 38% 32%, rgba(255,230,180,0.18), transparent 55%)',
            }} />
            <div style={{
              position: 'absolute', inset: '12px', borderRadius: '50%',
              border: '1px solid rgba(255,255,255,0.07)',
            }} />
          </div>
        </div>

        {/* Agent sprites */}
        {participants.map(({ agent, slot }) => {
          const bv              = balloonViews[agent.id]
          const isActive        = agent.id === activeSpeakerId
          const isThinking      = agent.id === nextAgentId
          const isHumanWaiting  = agent.id === 'human' && isWaitingForHuman
          const sprite          = spriteLibrary[slot.spriteId]

          return (
            <div key={agent.id} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${slot.x}%`, top: `${slot.y}%` }}>
              {bv && bv.text && !isThinking && !isHumanWaiting && (
                <SpeechBalloon text={bv.text} bg={slot.balloonBg} textColor={slot.balloonText} isActive={isActive} isTyping={bv.isTyping} maxHeight={slot.role === 'host' ? '110px' : '220px'} />
              )}
              {isHumanWaiting && (
                <div className="absolute bottom-full mb-3 z-10" style={{ left: '50%', transform: 'translateX(-50%)', width: '80px' }}>
                  <div className="relative rounded-xl px-3 py-2 text-center shadow-lg text-[11px] font-semibold" style={{ backgroundColor: slot.balloonBg, color: slot.balloonText }}>
                    Your turn
                    <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0" style={{ borderLeft: '7px solid transparent', borderRight: '7px solid transparent', borderTop: `9px solid ${slot.balloonBg}` }} />
                  </div>
                </div>
              )}
              {isThinking && (
                <div className="absolute bottom-full mb-3 z-10" style={{ left: '50%', transform: 'translateX(-50%)', width: '56px' }}>
                  <div className="relative rounded-xl px-3 py-2 shadow-lg" style={{ backgroundColor: slot.balloonBg, color: slot.balloonText }}>
                    <span className="flex gap-1 items-center justify-center">
                      {[0, 150, 300].map(delay => (
                        <span key={delay} className="w-1.5 h-1.5 rounded-full bg-current opacity-80 animate-bounce" style={{ animationDelay: `${delay}ms` }} />
                      ))}
                    </span>
                    <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0" style={{ borderLeft: '7px solid transparent', borderRight: '7px solid transparent', borderTop: `9px solid ${slot.balloonBg}` }} />
                  </div>
                </div>
              )}
              <div className={`rounded-lg border p-1.5 transition-all duration-300 ${
                isHumanWaiting ? 'border-orange-400/70 shadow-[0_0_16px_4px_rgba(249,115,22,0.3)] scale-110 animate-pulse'
                : isActive     ? 'border-white/50 shadow-[0_0_16px_4px_rgba(255,255,255,0.15)] scale-110'
                : isThinking   ? 'border-white/30 animate-pulse'
                : 'border-slate-600/30'
              }`}>
                {sprite && <PixelSprite sprite={sprite} size={12} />}
              </div>
              <p className="mt-1 text-center text-[11px] font-semibold text-slate-100 leading-tight">{agent.name}</p>
              <p className="text-center text-[10px] uppercase tracking-wide text-slate-500">{slot.label}</p>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Transcript — identical to DebateRoom
// ---------------------------------------------------------------------------

function Transcript({ session, visibleCount }: { session: OSDebateSession; visibleCount: number }) {
  const bottomRef  = useRef<HTMLDivElement>(null)
  const visibleTurns = session.turns.slice(0, visibleCount)

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [visibleTurns.length])

  const colorFor = (turn: DebateTurn) => {
    if (turn.agent_id === 'human') return 'orange'
    if (turn.agent_id === session.host_id) return 'amber'
    const idx = session.guest_ids.indexOf(turn.agent_id)
    return idx === 0 ? 'emerald' : 'violet'
  }

  const cls: Record<string, string> = {
    amber:   'bg-amber-50  dark:bg-amber-900/20  border-amber-200  dark:border-amber-700  text-amber-900  dark:text-amber-200',
    emerald: 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-700 text-emerald-900 dark:text-emerald-200',
    violet:  'bg-violet-50  dark:bg-violet-900/20  border-violet-200  dark:border-violet-700  text-violet-900  dark:text-violet-200',
    orange:  'bg-orange-50  dark:bg-orange-900/20  border-orange-200  dark:border-orange-700  text-orange-900  dark:text-orange-200',
  }

  return (
    <aside className="rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 p-4 h-fit">
      <div className="flex items-center gap-2 mb-3">
        <MessageCircle size={15} className="text-violet-500" />
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Transcript</h2>
        {session.status === 'running' && (
          <span className="ml-auto text-xs text-green-500 flex items-center gap-1"><span className="animate-pulse">●</span> live</span>
        )}
      </div>
      <div className="space-y-2.5 max-h-[480px] overflow-y-auto pr-1">
        {visibleTurns.length === 0 ? (
          <p className="text-xs text-slate-400 dark:text-slate-500 text-center py-8">
            {session.status === 'running' ? 'Waiting for OutSystems agents…' : 'No turns recorded.'}
          </p>
        ) : (
          visibleTurns.map(turn => (
            <div key={turn.id} className={`rounded-lg border p-2.5 ${cls[colorFor(turn)]}`}>
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-semibold leading-none">{turn.agent_name}</p>
                <span className="text-[10px] opacity-50 uppercase">{turn.turn_type}</span>
              </div>
              <p className="text-xs leading-relaxed">{turn.content}</p>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// SetupPanel
// ---------------------------------------------------------------------------

function SetupPanel({
  topic, setTopic, rounds, setRounds, humanInLoop, setHumanInLoop, sessions, onStart, starting, isDebating, onLoadSession, onReload,
}: {
  topic: string; setTopic: (v: string) => void
  rounds: number; setRounds: (v: number) => void
  humanInLoop: boolean; setHumanInLoop: (v: boolean) => void
  sessions: OSDebateSession[]
  onStart: () => void; starting: boolean; isDebating: boolean
  onLoadSession: (id: string) => void
  onReload: () => void
}) {
  const inputCls = 'border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-violet-500'
  const labelCls = 'block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1'

  return (
    <div className="flex flex-wrap items-end gap-4 p-4 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700">
      <div className="flex-1 min-w-[280px]">
        <label className={labelCls}>Question</label>
        <input
          className={`${inputCls} w-full`}
          placeholder="e.g. Should AI replace human jobs?"
          value={topic}
          onChange={e => setTopic(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && onStart()}
        />
      </div>

      <div>
        <label className={labelCls}>{humanInLoop ? 'Your speaking rounds' : 'Rounds'}</label>
        <select className={inputCls} value={rounds} onChange={e => setRounds(Number(e.target.value))}>
          {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>

      <div>
        <label className={labelCls}>Join as guest</label>
        <button
          type="button"
          onClick={() => !isDebating && setHumanInLoop(!humanInLoop)}
          disabled={isDebating}
          className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
            humanInLoop
              ? 'bg-orange-500 border-orange-500 text-white'
              : 'bg-white dark:bg-slate-700 border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:border-orange-400'
          }`}
        >
          <UserCircle2 size={14} />
          {humanInLoop ? 'Speaking' : 'Observer'}
        </button>
      </div>

      {sessions.length > 0 && (
        <div>
          <label className={labelCls}>Past debates</label>
          <div className="flex items-center gap-1.5">
            <select className={inputCls} defaultValue="" onChange={e => e.target.value && onLoadSession(e.target.value)}>
              <option value="">— load past debate —</option>
              {sessions.map(s => (
                <option key={s.id} value={s.id}>
                  {s.status === 'running' ? '🟢 ' : s.status === 'completed' ? '✓ ' : '✗ '}
                  {s.topic.slice(0, 45)} · {new Date(s.started_at).toLocaleTimeString()}
                </option>
              ))}
            </select>
            <button onClick={onReload} title="Refresh" className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors">
              <RefreshCw size={13} />
            </button>
          </div>
        </div>
      )}

      <button
        onClick={onStart}
        disabled={starting || isDebating || !topic.trim()}
        className="flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {starting ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
        {starting ? 'Triggering…' : 'Start Debate'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main OSDebateRoom
// ---------------------------------------------------------------------------

export function OSDebateRoom() {
  const [topic, setTopic]   = useState('')
  const [rounds, setRounds] = useState(2)
  const [humanInLoop, setHumanInLoop]   = useState(false)
  const [humanInput, setHumanInput]     = useState('')
  const [humanSubmitting, setHumanSubmitting] = useState(false)
  const [starting, setStarting]     = useState(false)
  const [stopping, setStopping]     = useState(false)
  const [triggerError, setTriggerError] = useState<string | null>(null)

  const [sessions, setSessions]           = useState<OSDebateSession[]>([])
  const [activeSession, setActiveSession] = useState<OSDebateSession | null>(null)

  // Typewriter state
  const [displayedCount, setDisplayedCount] = useState(0)
  const [typedChars, setTypedChars]         = useState(0)
  const [isTyping, setIsTyping]             = useState(false)

  const sessionIdRef = useRef<string | null>(null)
  const mountedRef   = useRef(true)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])

  useEffect(() => { loadSessions() }, [])

  function loadSessions() {
    api.listOSDebateSessions().then((s: OSDebateSession[]) => {
      if (!mountedRef.current) return
      setSessions(s)
    }).catch(() => {})
  }

  function loadSession(id: string) {
    api.getOSDebateSession(id).then((s: OSDebateSession) => {
      if (!mountedRef.current) return
      setActiveSession(s)
    }).catch(() => {})
  }

  // ── Typewriter: reset on session change ───────────────────────────────────
  useEffect(() => {
    if (!activeSession) {
      setDisplayedCount(0); setTypedChars(0); setIsTyping(false)
      sessionIdRef.current = null
      return
    }
    if (activeSession.id !== sessionIdRef.current) {
      sessionIdRef.current = activeSession.id
      setDisplayedCount(0); setTypedChars(0); setIsTyping(false)
    }
  }, [activeSession?.id])

  // Phase 1: start next turn
  useEffect(() => {
    if (!activeSession || isTyping) return
    if (displayedCount >= activeSession.turns.length) return
    setTypedChars(0)
    setIsTyping(true)
  }, [activeSession?.turns.length, displayedCount, isTyping])

  // Phase 2: advance chars
  useEffect(() => {
    if (!isTyping || !activeSession) return
    const turn = activeSession.turns[displayedCount]
    if (!turn) { setIsTyping(false); return }
    if (typedChars >= turn.content.length) {
      const t = setTimeout(() => {
        if (!mountedRef.current) return
        setIsTyping(false)
        setDisplayedCount(n => n + 1)
      }, INTER_TURN_MS)
      return () => clearTimeout(t)
    }
    const t = setTimeout(() => {
      if (!mountedRef.current) return
      setTypedChars(n => Math.min(n + CHARS_PER_TICK, turn.content.length))
    }, TICK_MS)
    return () => clearTimeout(t)
  }, [isTyping, typedChars, displayedCount, activeSession?.turns.length])

  // ── Poll while running ────────────────────────────────────────────────────
  useEffect(() => {
    if (!activeSession || !['running', 'waiting_for_human'].includes(activeSession.status)) return
    const iv = setInterval(async () => {
      if (!mountedRef.current) return
      try {
        const updated: OSDebateSession = await api.getOSDebateSession(activeSession.id)
        if (!mountedRef.current) return
        setActiveSession(updated)
        setSessions(prev => prev.map(s => s.id === updated.id ? updated : s))
        if (!['running', 'waiting_for_human'].includes(updated.status)) clearInterval(iv)
      } catch {}
    }, 1500)
    return () => clearInterval(iv)
  }, [activeSession?.id, activeSession?.status])

  // ── Start ─────────────────────────────────────────────────────────────────
  async function handleStart() {
    if (!topic.trim()) return
    setStarting(true)
    setTriggerError(null)
    setActiveSession(null)
    try {
      const ngrok = await api.getNgrokStatus()
      if (!ngrok.running) {
        setTriggerError('The ngrok tunnel is not active. OutSystems needs a public URL to reach the Critical Agent. Start the tunnel in Settings → Public Access before starting a debate.')
        setStarting(false)
        return
      }
      const { session_id, os_triggered } = await api.startOSDebateExternal({ rounds, Question: topic.trim(), human_in_loop: humanInLoop })
      if (!mountedRef.current) return
      if (!os_triggered) {
        setTriggerError('OutSystems returned false — debate flow did not start.')
        return
      }
      const session: OSDebateSession = await api.getOSDebateSession(session_id)
      if (!mountedRef.current) return
      setActiveSession(session)
      setSessions(prev => [session, ...prev.filter(s => s.id !== session_id)])
    } catch (err: any) {
      if (!mountedRef.current) return
      setTriggerError(err?.response?.data?.detail ?? err?.message ?? 'Request failed')
    } finally {
      if (mountedRef.current) setStarting(false)
    }
  }

  async function handleHumanTurn(isFinal: boolean) {
    if (!activeSession || !humanInput.trim()) return
    setHumanSubmitting(true)
    try {
      const updated = await api.postHumanTurn(activeSession.id, { content: humanInput.trim(), is_final: isFinal })
      if (!mountedRef.current) return
      if (updated.ok) {
        setHumanInput('')
        const refreshed: OSDebateSession = await api.getOSDebateSession(activeSession.id)
        if (!mountedRef.current) return
        setActiveSession(refreshed)
        setSessions(prev => prev.map(s => s.id === refreshed.id ? refreshed : s))
      }
    } catch (err: any) {
      setTriggerError(err?.response?.data?.detail ?? err?.message ?? 'Failed to submit turn')
    } finally {
      if (mountedRef.current) setHumanSubmitting(false)
    }
  }

  function handleReplay() {
    setDisplayedCount(0); setTypedChars(0); setIsTyping(false)
    sessionIdRef.current = null
  }

  function handleNextStep() {
    if (!activeSession) return
    if (isTyping) {
      setIsTyping(false)
      setDisplayedCount(n => n + 1)
    } else if (displayedCount < totalTurns) {
      setDisplayedCount(n => n + 1)
    }
  }

  async function handleStop() {
    if (!activeSession || stopping) return
    setStopping(true)
    try {
      await api.stopOSDebateSession(activeSession.id)
      const updated: OSDebateSession = await api.getOSDebateSession(activeSession.id)
      if (!mountedRef.current) return
      setActiveSession(updated)
      setSessions(prev => prev.map(s => s.id === updated.id ? updated : s))
      setIsTyping(false)
      setDisplayedCount(updated.turns.length)
    } catch (err: any) {
      setTriggerError(err?.response?.data?.detail ?? err?.message ?? 'Stop failed')
    } finally {
      if (mountedRef.current) setStopping(false)
    }
  }

  // ── Derived display state ─────────────────────────────────────────────────
  const balloonViews: Record<string, BalloonView> = {}
  if (activeSession) {
    for (const turn of activeSession.turns.slice(0, displayedCount)) {
      balloonViews[turn.agent_id] = { text: turn.content, isTyping: false, turnType: turn.turn_type }
    }
    if (isTyping && displayedCount < activeSession.turns.length) {
      const cur = activeSession.turns[displayedCount]
      balloonViews[cur.agent_id] = { text: cur.content.slice(0, typedChars), isTyping: true, turnType: cur.turn_type }
    }
  }

  const activeSpeakerId = isTyping && activeSession
    ? (activeSession.turns[displayedCount]?.agent_id ?? null)
    : (displayedCount > 0 && activeSession ? activeSession.turns[displayedCount - 1]?.agent_id ?? null : null)

  const isWaiting = !isTyping && activeSession?.status === 'running'
    && displayedCount >= (activeSession?.turns.length ?? 0)

  const totalTurns = activeSession?.turns.length ?? 0
  const shownTurns = isTyping ? displayedCount + 1 : displayedCount

  const isWaitingForHuman = activeSession?.status === 'waiting_for_human'
    && !!activeSession?.human_in_loop
    && !isTyping
    && displayedCount >= totalTurns

  const isLastRound = (activeSession?.os_rounds_done ?? 0) >= (activeSession?.total_human_rounds ?? 1)

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">
      <SetupPanel
        topic={topic} setTopic={setTopic}
        rounds={rounds} setRounds={setRounds}
        humanInLoop={humanInLoop} setHumanInLoop={setHumanInLoop}
        sessions={sessions}
        onStart={handleStart}
        starting={starting}
        isDebating={!!activeSession && ['running', 'waiting_for_human'].includes(activeSession.status)}
        onLoadSession={loadSession}
        onReload={loadSessions}
      />

      {triggerError && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl border bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-700 text-red-800 dark:text-red-300 text-sm">
          <span>✗</span><span>{triggerError}</span>
        </div>
      )}

      {activeSession ? (
        <div className="space-y-3">
          {/* Controls */}
          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={handleReplay}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 hover:bg-violet-200 dark:hover:bg-violet-800/60 transition-colors">
              <RotateCcw size={13} /> Replay
            </button>
            {['running', 'waiting_for_human'].includes(activeSession.status) && (
              <button onClick={handleStop} disabled={stopping}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-800/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                {stopping ? <Loader2 size={13} className="animate-spin" /> : <Square size={13} />} Stop
              </button>
            )}
            {displayedCount < totalTurns && (
              <>
                <button onClick={handleNextStep}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
                  Next turn
                </button>
                <button onClick={() => { setIsTyping(false); setDisplayedCount(totalTurns) }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
                  Skip to end
                </button>
              </>
            )}
            {isWaiting && (
              <span className="flex items-center gap-1.5 text-xs text-slate-400 dark:text-slate-500">
                <Loader2 size={12} className="animate-spin" /> Waiting for OS agents…
              </span>
            )}
            {isWaitingForHuman && (
              <span className="flex items-center gap-1.5 text-xs text-orange-500">
                <UserCircle2 size={12} /> Your turn to speak
              </span>
            )}
            <span className="ml-auto text-xs text-slate-400 dark:text-slate-500">
              {shownTurns} / {totalTurns} turns{activeSession.status === 'running' && ' (live)'}
            </span>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-[1fr_340px] gap-5">
            <DebateStage
              session={activeSession}
              agentMap={OS_AGENT_MAP}
              balloonViews={balloonViews}
              activeSpeakerId={activeSpeakerId}
              isWaiting={isWaiting}
              isWaitingForHuman={isWaitingForHuman}
            />

            {isWaitingForHuman && (
              <div className="rounded-xl border border-orange-300 dark:border-orange-700 bg-orange-50 dark:bg-orange-900/20 p-4 space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-orange-800 dark:text-orange-300">
                  <UserCircle2 size={15} />
                  Your turn — round {activeSession.os_rounds_done} of {activeSession.total_human_rounds}
                </div>
                <textarea
                  className="w-full rounded-lg border border-orange-300 dark:border-orange-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400 resize-none"
                  rows={3}
                  placeholder="Share your perspective…"
                  value={humanInput}
                  onChange={e => setHumanInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleHumanTurn(isLastRound) }}
                  disabled={humanSubmitting}
                />
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleHumanTurn(isLastRound)}
                    disabled={humanSubmitting || !humanInput.trim()}
                    className="flex items-center gap-1.5 px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {humanSubmitting ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                    {isLastRound ? 'Send & finish' : 'Send & continue'}
                  </button>
                  {!isLastRound && (
                    <button
                      onClick={() => handleHumanTurn(true)}
                      disabled={humanSubmitting || !humanInput.trim()}
                      className="flex items-center gap-1.5 px-4 py-2 bg-slate-200 dark:bg-slate-600 hover:bg-slate-300 dark:hover:bg-slate-500 text-slate-700 dark:text-slate-200 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Square size={13} /> End debate
                    </button>
                  )}
                  <span className="ml-auto text-xs text-slate-400">⌘↵ to send</span>
                </div>
              </div>
            )}
            <Transcript session={activeSession} visibleCount={displayedCount} />
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-900 p-4 shadow-inner flex items-center justify-center h-[548px] text-slate-500 text-sm">
          Enter a question and click Start — OutSystems agents will push their turns here in real time.
        </div>
      )}
    </div>
  )
}
