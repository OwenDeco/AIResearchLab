import { useEffect, useRef, useState } from 'react'
import { Loader2, MessageCircle, Play, RefreshCw, RotateCcw } from 'lucide-react'
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
  system_prompt: string
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

interface DebateSession {
  id: string
  status: 'running' | 'completed' | 'failed'
  host_id: string
  guest_ids: string[]
  topic: string
  rounds: number
  turns: DebateTurn[]
  started_at: string
  ended_at: string | null
}

// ---------------------------------------------------------------------------
// Typewriter constants
// ---------------------------------------------------------------------------

// Characters added per tick while typing
const CHARS_PER_TICK = 4
// Tick interval in ms
const TICK_MS = 150
// Pause between turns (after one finishes, before next starts)
const INTER_TURN_PAUSE_MS = 900

// ---------------------------------------------------------------------------
// Stage layout
// ---------------------------------------------------------------------------

const AGENT_SLOTS = [
  { role: 'host',   x: 50, y: 22, spriteId: 'coderBlue',      balloonBg: '#fbbf24', balloonText: '#1c1917', label: 'Host'    },
  { role: 'guest1', x: 18, y: 68, spriteId: 'plannerGreen',   balloonBg: '#10b981', balloonText: '#ffffff', label: 'Guest 1' },
  { role: 'guest2', x: 82, y: 68, spriteId: 'reviewerPurple', balloonBg: '#8b5cf6', balloonText: '#ffffff', label: 'Guest 2' },
  { role: 'guest3', x: 50, y: 75, spriteId: 'coderBlue',      balloonBg: '#ec4899', balloonText: '#ffffff', label: 'Guest 3' },
]

// ---------------------------------------------------------------------------
// SpeechBalloon
// ---------------------------------------------------------------------------

function SpeechBalloon({
  text,
  bg,
  textColor,
  isActive,
  isTyping,
}: {
  text: string
  bg: string
  textColor: string
  isActive: boolean
  isTyping: boolean
}) {
  return (
    <div
      className="absolute bottom-full mb-3 z-10"
      style={{ left: '50%', transform: 'translateX(-50%)', width: '190px' }}
    >
      <div
        className={`relative rounded-xl px-3 py-2.5 text-xs leading-snug shadow-lg transition-all duration-300 ${
          isActive ? 'opacity-100 scale-100' : 'opacity-55 scale-95'
        }`}
        style={{ backgroundColor: bg, color: textColor }}
      >
        <span className="whitespace-pre-line">{text}</span>
        {isTyping && (
          <span
            className="inline-block w-[2px] h-[11px] ml-[1px] align-middle animate-pulse"
            style={{ backgroundColor: textColor, opacity: 0.8 }}
          />
        )}
        {/* Tail */}
        <div
          className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0"
          style={{
            borderLeft: '7px solid transparent',
            borderRight: '7px solid transparent',
            borderTop: `9px solid ${bg}`,
          }}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// DebateStage
// ---------------------------------------------------------------------------

// What each agent's balloon shows at any given moment
interface BalloonView {
  text: string
  isTyping: boolean
  turnType: string
}

function DebateStage({
  session,
  agentMap,
  balloonViews,     // keyed by agent_id
  activeSpeakerId,
  isWaiting,
}: {
  session: DebateSession
  agentMap: Record<string, AgentConfig>
  balloonViews: Record<string, BalloonView>
  activeSpeakerId: string | null
  isWaiting: boolean
}) {
  // Determine next speaker for thinking dots while waiting for backend
  const speakOrder = [session.host_id, ...session.guest_ids]
  const lastIdx = speakOrder.indexOf(activeSpeakerId ?? '')
  const nextAgentId = isWaiting ? speakOrder[(lastIdx + 1) % speakOrder.length] : null

  const participants: { agent: AgentConfig; slot: typeof AGENT_SLOTS[0] }[] = []
  const hostAgent = agentMap[session.host_id]
  if (hostAgent) participants.push({ agent: hostAgent, slot: AGENT_SLOTS[0] })
  session.guest_ids.forEach((gid, i) => {
    const agent = agentMap[gid]
    const slot = AGENT_SLOTS[i + 1]
    if (agent && slot) participants.push({ agent, slot })
  })

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-inner">
      <div
        className="relative mx-auto rounded-lg border-4 border-slate-700"
        style={{
          height: '520px',
          maxWidth: '900px',
          background: 'radial-gradient(ellipse at 50% 0%, #1e3a5f 0%, #0f172a 70%)',
        }}
      >
        {/* Spotlight */}
        <div
          className="absolute top-0 left-1/2 -translate-x-1/2 w-32 opacity-10 pointer-events-none"
          style={{
            height: '200px',
            background: 'linear-gradient(to bottom, #fbbf24, transparent)',
            clipPath: 'polygon(30% 0%, 70% 0%, 100% 100%, 0% 100%)',
          }}
        />
        {/* Floor glow */}
        <div
          className="absolute bottom-0 left-0 right-0 h-20 rounded-b-lg pointer-events-none"
          style={{ background: 'linear-gradient(to top, #312e8133, transparent)' }}
        />

        {/* Topic label — sits below the host sprite, hoverable for full text */}
        <div
          className="absolute -translate-x-1/2 group z-10"
          style={{ top: '36%', left: '50%' }}
        >
          <div className="px-3 py-1 bg-slate-800/90 border border-slate-600 rounded-full text-xs text-slate-300 max-w-[200px] text-center truncate cursor-default select-none">
            {session.topic}
          </div>
          <div className="absolute top-full mt-2 left-1/2 -translate-x-1/2 hidden group-hover:block w-64 bg-slate-900 border border-slate-500 rounded-lg px-3 py-2 text-xs text-slate-200 shadow-2xl text-center leading-relaxed pointer-events-none">
            {session.topic}
          </div>
        </div>

        {/* Status */}
        <div className="absolute top-3 right-3 text-xs">
          {session.status === 'running'   && <span className="flex items-center gap-1 text-green-400"><span className="animate-pulse">●</span> live</span>}
          {session.status === 'completed' && <span className="text-blue-400">● done</span>}
          {session.status === 'failed'    && <span className="text-red-400">● failed</span>}
        </div>

        {/* Podium */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none opacity-15">
          <div className="w-14 h-8 border-2 border-amber-400 rounded-sm" />
          <div className="w-10 h-3 bg-amber-400/60 mx-auto rounded-sm mt-0.5" />
        </div>

        {/* Agent sprites */}
        {participants.map(({ agent, slot }) => {
          const bv = balloonViews[agent.id]
          const isActive = agent.id === activeSpeakerId
          const isThinking = agent.id === nextAgentId
          const sprite = spriteLibrary[slot.spriteId]

          return (
            <div
              key={agent.id}
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${slot.x}%`, top: `${slot.y}%` }}
            >
              {/* Speech balloon */}
              {bv && bv.text && !isThinking && (
                <SpeechBalloon
                  text={bv.text}
                  bg={slot.balloonBg}
                  textColor={slot.balloonText}
                  isActive={isActive}
                  isTyping={bv.isTyping}
                />
              )}

              {/* Thinking dots */}
              {isThinking && (
                <div
                  className="absolute bottom-full mb-3 z-10"
                  style={{ left: '50%', transform: 'translateX(-50%)', width: '56px' }}
                >
                  <div
                    className="relative rounded-xl px-3 py-2 shadow-lg"
                    style={{ backgroundColor: slot.balloonBg, color: slot.balloonText }}
                  >
                    <span className="flex gap-1 items-center justify-center">
                      {[0, 150, 300].map(delay => (
                        <span
                          key={delay}
                          className="w-1.5 h-1.5 rounded-full bg-current opacity-80 animate-bounce"
                          style={{ animationDelay: `${delay}ms` }}
                        />
                      ))}
                    </span>
                    <div
                      className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0"
                      style={{
                        borderLeft: '7px solid transparent',
                        borderRight: '7px solid transparent',
                        borderTop: `9px solid ${slot.balloonBg}`,
                      }}
                    />
                  </div>
                </div>
              )}

              <div
                className={`rounded-lg border p-1.5 transition-all duration-300 ${
                  isActive    ? 'border-white/50 shadow-[0_0_16px_4px_rgba(255,255,255,0.15)] scale-110'
                  : isThinking ? 'border-white/30 animate-pulse'
                  : 'border-slate-600/30'
                }`}
              >
                {sprite && <PixelSprite sprite={sprite} size={8} />}
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
// Transcript
// ---------------------------------------------------------------------------

function Transcript({ session, visibleCount }: { session: DebateSession; visibleCount: number }) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const visibleTurns = session.turns.slice(0, visibleCount)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [visibleTurns.length])

  const colorFor = (turn: DebateTurn) => {
    if (turn.agent_id === session.host_id) return 'amber'
    const idx = session.guest_ids.indexOf(turn.agent_id)
    return idx === 0 ? 'emerald' : idx === 1 ? 'violet' : 'pink'
  }

  const cls: Record<string, string> = {
    amber:   'bg-amber-50  dark:bg-amber-900/20  border-amber-200  dark:border-amber-700  text-amber-900  dark:text-amber-200',
    emerald: 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-700 text-emerald-900 dark:text-emerald-200',
    violet:  'bg-violet-50  dark:bg-violet-900/20  border-violet-200  dark:border-violet-700  text-violet-900  dark:text-violet-200',
    pink:    'bg-pink-50    dark:bg-pink-900/20    border-pink-200    dark:border-pink-700    text-pink-900    dark:text-pink-200',
  }

  return (
    <aside className="rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 p-4 h-fit">
      <div className="flex items-center gap-2 mb-3">
        <MessageCircle size={15} className="text-violet-500" />
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Transcript</h2>
        {session.status === 'running' && (
          <span className="ml-auto text-xs text-green-500 flex items-center gap-1">
            <span className="animate-pulse">●</span> live
          </span>
        )}
      </div>

      <div className="space-y-2.5 max-h-[480px] overflow-y-auto pr-1">
        {visibleTurns.length === 0 ? (
          <p className="text-xs text-slate-400 dark:text-slate-500 text-center py-8">
            {session.status === 'running' ? 'Debate starting…' : 'No turns recorded.'}
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
  agents, hostId, setHostId, guestIds, setGuestIds,
  topic, setTopic, rounds, setRounds,
  sessions, selectedSessionId, setSelectedSessionId,
  onStart, starting, onReload,
}: {
  agents: AgentConfig[]
  hostId: string; setHostId: (v: string) => void
  guestIds: string[]; setGuestIds: (v: string[]) => void
  topic: string; setTopic: (v: string) => void
  rounds: number; setRounds: (v: number) => void
  sessions: DebateSession[]; selectedSessionId: string | null; setSelectedSessionId: (v: string | null) => void
  onStart: () => void; starting: boolean
  onReload: () => void
}) {
  const inputCls = 'border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-violet-500'
  const labelCls = 'block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1'

  const debateFirst = [
    ...agents.filter(a => a.name.toLowerCase().startsWith('debate')),
    ...agents.filter(a => !a.name.toLowerCase().startsWith('debate')),
  ]

  function toggleGuest(id: string) {
    if (guestIds.includes(id)) setGuestIds(guestIds.filter(x => x !== id))
    else if (guestIds.length < 3) setGuestIds([...guestIds, id])
  }

  return (
    <div className="flex flex-wrap items-end gap-4 p-4 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700">
      <div>
        <label className={labelCls}>Host Agent</label>
        <select className={inputCls} value={hostId} onChange={e => setHostId(e.target.value)}>
          <option value="">— select host —</option>
          {debateFirst.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>

      <div>
        <label className={labelCls}>Guest Agents (up to 3)</label>
        <div className="flex flex-wrap gap-3">
          {debateFirst.filter(a => a.id !== hostId).map(a => (
            <label key={a.id} className="flex items-center gap-1.5 text-sm cursor-pointer">
              <input type="checkbox" checked={guestIds.includes(a.id)} onChange={() => toggleGuest(a.id)}
                className="rounded border-slate-300 dark:border-slate-600 text-violet-600 focus:ring-violet-500" />
              <span className="text-slate-700 dark:text-slate-200">{a.name}</span>
            </label>
          ))}
          {debateFirst.filter(a => a.id !== hostId).length === 0 && (
            <p className="text-xs text-slate-400 dark:text-slate-500 italic">No other agents yet.</p>
          )}
        </div>
      </div>

      <div className="flex-1 min-w-[220px]">
        <label className={labelCls}>Debate Topic</label>
        <input className={`${inputCls} w-full`} placeholder="e.g. Should AI replace human jobs?"
          value={topic} onChange={e => setTopic(e.target.value)} onKeyDown={e => e.key === 'Enter' && onStart()} />
      </div>

      <div>
        <label className={labelCls}>Rounds</label>
        <select className={inputCls} value={rounds} onChange={e => setRounds(Number(e.target.value))}>
          {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>

      {sessions.length > 0 && (
        <div>
          <label className={labelCls}>Past debates</label>
          <div className="flex items-center gap-1.5">
            <select className={inputCls} value={selectedSessionId ?? ''}
              onChange={e => setSelectedSessionId(e.target.value || null)}>
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

      <button onClick={onStart} disabled={starting || !hostId || guestIds.length === 0 || !topic.trim()}
        className="flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
        {starting ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
        {starting ? 'Starting…' : 'Start Debate'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main DebateRoom
// ---------------------------------------------------------------------------

export function DebateRoom() {
  const [agents, setAgents]         = useState<AgentConfig[]>([])
  const [sessions, setSessions]     = useState<DebateSession[]>([])
  const [activeSession, setActiveSession] = useState<DebateSession | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)

  // Form
  const [hostId, setHostId]   = useState('')
  const [guestIds, setGuestIds] = useState<string[]>([])
  const [topic, setTopic]     = useState('')
  const [rounds, setRounds]   = useState(2)
  const [starting, setStarting] = useState(false)

  // ── Typewriter state ──────────────────────────────────────────────────────
  // How many turns have been fully typed and shown
  const [displayedCount, setDisplayedCount] = useState(0)
  // How many characters of the current turn are visible
  const [typedChars, setTypedChars] = useState(0)
  // True while a turn's text is still being typed out
  const [isTyping, setIsTyping] = useState(false)

  const sessionIdRef = useRef<string | null>(null)
  const mountedRef   = useRef(true)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])

  // ── Reset typewriter when session changes ─────────────────────────────────
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

  // ── Typewriter engine ─────────────────────────────────────────────────────
  // Phase 1: start typing the next available turn
  useEffect(() => {
    if (!activeSession || isTyping) return
    if (displayedCount >= activeSession.turns.length) return   // waiting for backend
    // Kick off typing for turn at index `displayedCount`
    setTypedChars(0)
    setIsTyping(true)
  }, [activeSession?.turns.length, displayedCount, isTyping])

  // Phase 2: advance chars while typing
  useEffect(() => {
    if (!isTyping || !activeSession) return
    const turn = activeSession.turns[displayedCount]
    if (!turn) { setIsTyping(false); return }

    if (typedChars >= turn.content.length) {
      // Turn fully typed — pause then advance
      const t = setTimeout(() => {
        if (!mountedRef.current) return
        setIsTyping(false)
        setDisplayedCount(n => n + 1)
      }, INTER_TURN_PAUSE_MS)
      return () => clearTimeout(t)
    }

    const t = setTimeout(() => {
      if (!mountedRef.current) return
      setTypedChars(n => Math.min(n + CHARS_PER_TICK, turn.content.length))
    }, TICK_MS)
    return () => clearTimeout(t)
  }, [isTyping, typedChars, displayedCount, activeSession?.turns.length])

  // ── Poll backend while session is running ─────────────────────────────────
  useEffect(() => {
    if (!activeSession || activeSession.status !== 'running') return
    const iv = setInterval(async () => {
      if (!mountedRef.current) return
      try {
        const updated: DebateSession = await api.getDebateSession(activeSession.id)
        if (!mountedRef.current) return
        setActiveSession(updated)
        setSessions(prev => prev.map(s => s.id === updated.id ? updated : s))
        if (updated.status !== 'running') clearInterval(iv)
      } catch {}
    }, 1500)
    return () => clearInterval(iv)
  }, [activeSession?.id, activeSession?.status])

  // ── Load past session ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedSessionId) return
    api.getDebateSession(selectedSessionId).then((s: DebateSession) => {
      if (!mountedRef.current) return
      setActiveSession(s)
    }).catch(() => {})
  }, [selectedSessionId])

  // ── On mount ──────────────────────────────────────────────────────────────
  useEffect(() => {
    api.listAgentConfigs().then((cfgs: AgentConfig[]) => {
      if (!mountedRef.current) return
      setAgents(cfgs)
      const debate = cfgs.filter(a => a.name.toLowerCase().startsWith('debate'))
      const host = debate.find(a =>
        a.role.toLowerCase().includes('host') || a.name.toLowerCase().includes('host')
      )
      const guests = debate.filter(a => a.id !== host?.id)
      if (host) setHostId(host.id)
      setGuestIds(guests.slice(0, 3).map(a => a.id))
    }).catch(() => {})
    loadSessions()
  }, [])

  function loadSessions() {
    api.listDebateSessions().then((s: DebateSession[]) => {
      if (!mountedRef.current) return
      setSessions(s)
    }).catch(() => {})
  }

  async function handleStart() {
    if (!hostId || guestIds.length === 0 || !topic.trim()) return
    setStarting(true)
    setActiveSession(null)
    setSelectedSessionId(null)
    try {
      const { session_id } = await api.startDebate({ host_id: hostId, guest_ids: guestIds, topic: topic.trim(), rounds })
      const newSession: DebateSession = await api.getDebateSession(session_id)
      if (!mountedRef.current) return
      setActiveSession(newSession)
      setSessions(prev => [newSession, ...prev])
    } catch (err) {
      console.error(err)
    } finally {
      setStarting(false)
    }
  }

  function handleReplay() {
    setDisplayedCount(0)
    setTypedChars(0)
    setIsTyping(false)
    // Force reset of session id ref so the reset effect fires
    sessionIdRef.current = null
  }

  // ── Derived display state ─────────────────────────────────────────────────

  const agentMap: Record<string, AgentConfig> = {}
  for (const a of agents) agentMap[a.id] = a

  // Build balloon views:
  // - For completed turns (0..displayedCount-1): each agent shows its latest full text
  // - For the currently typing turn (displayedCount): show partial text with cursor
  const balloonViews: Record<string, BalloonView> = {}

  if (activeSession) {
    // Completed turns — latest per agent
    for (const turn of activeSession.turns.slice(0, displayedCount)) {
      balloonViews[turn.agent_id] = {
        text: turn.content,
        isTyping: false,
        turnType: turn.turn_type,
      }
    }
    // Currently typing turn
    if (isTyping && displayedCount < activeSession.turns.length) {
      const currentTurn = activeSession.turns[displayedCount]
      balloonViews[currentTurn.agent_id] = {
        text: currentTurn.content.slice(0, typedChars),
        isTyping: true,
        turnType: currentTurn.turn_type,
      }
    }
  }

  const activeSpeakerId = isTyping && activeSession
    ? (activeSession.turns[displayedCount]?.agent_id ?? null)
    : (displayedCount > 0 && activeSession ? activeSession.turns[displayedCount - 1]?.agent_id ?? null : null)

  const isWaiting = !isTyping
    && activeSession !== null
    && activeSession.status === 'running'
    && displayedCount >= activeSession.turns.length

  const totalBackendTurns = activeSession?.turns.length ?? 0
  const currentlyDisplaying = isTyping ? displayedCount + 1 : displayedCount

  return (
    <div className="space-y-5">
      <SetupPanel
        agents={agents}
        hostId={hostId} setHostId={setHostId}
        guestIds={guestIds} setGuestIds={setGuestIds}
        topic={topic} setTopic={setTopic}
        rounds={rounds} setRounds={setRounds}
        sessions={sessions}
        selectedSessionId={selectedSessionId}
        setSelectedSessionId={id => { setSelectedSessionId(id); if (!id) setActiveSession(null) }}
        onStart={handleStart}
        starting={starting}
        onReload={loadSessions}
      />

      {activeSession ? (
        <div className="space-y-3">
          {/* Controls row */}
          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={handleReplay}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 hover:bg-violet-200 dark:hover:bg-violet-800/60 transition-colors"
              title="Replay from beginning">
              <RotateCcw size={13} /> Replay
            </button>

            {/* Skip to end: only when there are buffered turns not yet shown */}
            {displayedCount < totalBackendTurns && (
              <button
                onClick={() => { setIsTyping(false); setDisplayedCount(totalBackendTurns) }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
                Skip to end
              </button>
            )}

            {isWaiting && (
              <span className="flex items-center gap-1.5 text-xs text-slate-400 dark:text-slate-500">
                <Loader2 size={12} className="animate-spin" /> Waiting for response…
              </span>
            )}

            <span className="ml-auto text-xs text-slate-400 dark:text-slate-500">
              {currentlyDisplaying} / {totalBackendTurns} turns
              {activeSession.status === 'running' && ' (generating…)'}
            </span>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-[1fr_340px] gap-5">
            <DebateStage
              session={activeSession}
              agentMap={agentMap}
              balloonViews={balloonViews}
              activeSpeakerId={activeSpeakerId}
              isWaiting={isWaiting}
            />
            <Transcript
              session={activeSession}
              visibleCount={isTyping ? displayedCount : displayedCount}
            />
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-900 p-4 shadow-inner flex items-center justify-center h-[548px] text-slate-500 text-sm">
          Configure a debate above and click Start, or load a past debate.
        </div>
      )}
    </div>
  )
}
