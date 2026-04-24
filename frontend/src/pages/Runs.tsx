import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, ChevronRight } from 'lucide-react'
import { api } from '../api/client'
import { Spinner } from '../components/Spinner'
import { parseUTC } from '../utils/date'

interface RunSummary {
  name?: string
  total_latency_ms?: number
  total_tokens?: number
  total_cost_usd?: number
  error_count?: number
  step_count?: number
  final_output?: string
  retrieval_mode?: string
  score?: number
}

interface UnifiedRun {
  id: string
  parent_run_id: string | null
  primary_domain: string
  run_type: string
  initiated_by: string
  status: string
  started_at: string
  ended_at: string | null
  source_id: string | null
  source_table: string | null
  summary: RunSummary | null
}

interface RunStep {
  id: string
  run_id: string
  domain: string
  step_type: string
  component: string | null
  started_at: string
  ended_at: string | null
  duration_ms: number | null
  status: string
  metrics: Record<string, unknown> | null
  input_summary: string | null
  output_summary: string | null
  error_message: string | null
}

interface RunEvent {
  id: string
  run_id: string | null
  step_id: string | null
  event_type: string
  category: string
  severity: string
  timestamp: string
  payload: Record<string, unknown> | null
  summary: string | null
  source: string | null
}

// ---- Helpers ----

function domainColor(domain: string): string {
  const map: Record<string, string> = {
    orchestration: 'blue',
    evaluation: 'green',
    interoperability: 'orange',
    context_engineering: 'teal',
    governance: 'rose',
  }
  return map[domain] || 'slate'
}

function DomainBadge({ domain }: { domain: string }) {
  const c = domainColor(domain)
  const classes: Record<string, string> = {
    blue: 'bg-blue-50 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-700',
    green: 'bg-green-50 dark:bg-green-900/40 text-green-700 dark:text-green-300 border-green-200 dark:border-green-700',
    orange: 'bg-orange-50 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300 border-orange-200 dark:border-orange-700',
    teal: 'bg-teal-50 dark:bg-teal-900/40 text-teal-700 dark:text-teal-300 border-teal-200 dark:border-teal-700',
    rose: 'bg-rose-50 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-700',
    slate: 'bg-slate-50 dark:bg-slate-700 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-600',
  }
  return (
    <span className={`inline-flex items-center text-xs font-medium border rounded-full px-2 py-0.5 ${classes[c] || classes.slate}`}>
      {domain.replace('_', ' ')}
    </span>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    running: 'bg-amber-50 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-700',
    completed: 'bg-emerald-50 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-700',
    failed: 'bg-red-50 dark:bg-red-900/40 text-red-700 dark:text-red-300 border-red-200 dark:border-red-700',
  }
  return (
    <span className={`inline-flex text-xs font-medium border rounded-full px-2 py-0.5 ${map[status] || 'bg-slate-50 dark:bg-slate-700 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-600'}`}>
      {status}
    </span>
  )
}

function formatDuration(startedAt: string, endedAt: string | null): string {
  if (!endedAt) return '—'
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime()
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// ---- RunDetail ----

const STEP_COLORS: Record<string, string> = {
  retrieve_chunks: '#3b82f6',
  rag_retrieval: '#3b82f6',
  llm_call: '#a855f7',
  tool_call: '#f59e0b',
  mcp_tool_call: '#f59e0b',
  a2a_tool_call: '#f97316',
  score_answer: '#22c55e',
  agent_handoff: '#f97316',
  embed_query: '#14b8a6',
}

const CAT_CLASSES: Record<string, string> = {
  execution: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
  data: 'bg-teal-500/10 text-teal-400 border-teal-500/30',
  ai: 'bg-purple-500/10 text-purple-400 border-purple-500/30',
  connection: 'bg-orange-500/10 text-orange-400 border-orange-500/30',
  evaluation: 'bg-green-500/10 text-green-400 border-green-500/30',
  governance: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
}

function RunDetail({ run, steps, events }: { run: UnifiedRun; steps: RunStep[]; events: RunEvent[] }) {
  const [openEvents, setOpenEvents] = useState<Set<string>>(new Set())

  function toggle(id: string) {
    setOpenEvents(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  function hasDetail(ev: RunEvent) {
    const p = ev.payload
    return !!(p && (p.input || p.output || p.error || p.metrics))
  }

  const maxMs = Math.max(...steps.map(s => s.duration_ms ?? 0), 1)

  const stats: [string, string][] = [
    ['Latency', run.summary?.total_latency_ms != null ? `${(run.summary.total_latency_ms / 1000).toFixed(2)}s` : '—'],
    ['Tokens', run.summary?.total_tokens != null ? run.summary.total_tokens.toLocaleString() : '—'],
    ['Cost', run.summary?.total_cost_usd != null ? `$${run.summary.total_cost_usd.toFixed(5)}` : '—'],
    ['Steps', String(run.summary?.step_count ?? '—')],
  ]

  const output = run.summary?.final_output?.replace(/^```\w*\n?/, '').replace(/```$/, '').trim()

  return (
    <div className="space-y-5 text-xs">

      {/* ── Summary ── */}
      <div>
        {run.summary?.name && (
          <p className="text-sm font-semibold text-slate-100 mb-3">{run.summary.name}</p>
        )}
        <div className="flex gap-6 flex-wrap mb-3">
          {stats.map(([label, value]) => (
            <div key={label}>
              <p className="text-slate-500 mb-0.5">{label}</p>
              <p className="font-mono font-semibold text-slate-200">{value}</p>
            </div>
          ))}
        </div>
        {output && (
          <div className="bg-slate-800 border border-slate-700 rounded p-3">
            <p className="text-slate-500 mb-1">Output preview</p>
            <p className="text-slate-300 line-clamp-3 leading-relaxed">{output}</p>
          </div>
        )}
      </div>

      {/* ── Steps ── */}
      {steps.length > 0 && (
        <div>
          <p className="uppercase tracking-widest text-slate-500 font-semibold mb-2">Steps Timeline</p>
          <div className="space-y-1">
            {steps.map(step => {
              const pct = step.duration_ms != null ? Math.max(2, (step.duration_ms / maxMs) * 100) : 0
              const color = STEP_COLORS[step.step_type] ?? '#64748b'
              const isOk = step.status === 'completed'
              const isFail = step.status === 'failed'
              return (
                <div
                  key={step.id}
                  style={{ display: 'grid', gridTemplateColumns: '8px 120px 160px 1fr 60px 72px', gap: '10px', alignItems: 'center' }}
                  className="bg-slate-800/70 border border-slate-700/60 rounded px-3 py-2"
                >
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
                  <span className="font-mono text-slate-200 truncate">{step.step_type.replace(/_/g, ' ')}</span>
                  <span className="font-mono text-slate-500 truncate">{step.component ?? '—'}</span>
                  <div style={{ background: '#1e293b', borderRadius: 999, height: 4, overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: color, opacity: 0.75, borderRadius: 999 }} />
                  </div>
                  <span className="font-mono text-slate-400 text-right">{step.duration_ms != null ? `${step.duration_ms.toFixed(0)}ms` : '—'}</span>
                  <span className={`text-right font-medium ${isOk ? 'text-emerald-400' : isFail ? 'text-red-400' : 'text-slate-500'}`}>{step.status}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Events ── */}
      {events.length > 0 && (
        <div>
          <p className="uppercase tracking-widest text-slate-500 font-semibold mb-2">Events</p>
          <div className="border border-slate-700 rounded overflow-hidden divide-y divide-slate-700/50">
            {events.map(ev => {
              const open = openEvents.has(ev.id)
              const expandable = hasDetail(ev)
              const catCls = CAT_CLASSES[ev.category] ?? 'bg-slate-700/40 text-slate-400 border-slate-600'
              const sevCls = ev.severity === 'error' ? 'text-red-400' : ev.severity === 'warning' ? 'text-amber-400' : 'text-slate-500'
              const p = ev.payload ?? {}
              return (
                <div key={ev.id} className="bg-slate-800/50">
                  <div
                    style={{ display: 'grid', gridTemplateColumns: '56px 80px 112px 1fr 36px 16px', gap: '10px', alignItems: 'center' }}
                    className={`px-3 py-2 ${expandable ? 'cursor-pointer hover:bg-slate-700/30' : ''}`}
                    onClick={() => expandable && toggle(ev.id)}
                  >
                    <span className="font-mono text-slate-500">{parseUTC(ev.timestamp).toLocaleTimeString('en-GB')}</span>
                    <span className={`inline-flex items-center justify-center border rounded-full px-2 py-0.5 text-center ${catCls}`}>{ev.category}</span>
                    <span className="font-mono text-slate-300 truncate">{ev.event_type.replace(/_/g, ' ')}</span>
                    <span className="text-slate-400 truncate">{ev.summary || '—'}</span>
                    <span className={`text-right font-medium ${sevCls}`}>{ev.severity}</span>
                    <span className="text-slate-500 flex justify-end">
                      {expandable && (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
                    </span>
                  </div>
                  {open && expandable && (
                    <div className="px-3 pb-3 pt-1 bg-slate-900/40 space-y-2">
                      {(['input', 'output', 'error'] as const).map(key =>
                        p[key] ? (
                          <div key={key}>
                            <p className="text-slate-500 font-semibold capitalize mb-0.5">{key}</p>
                            <p className="text-slate-300 whitespace-pre-wrap break-words leading-relaxed">{String(p[key])}</p>
                          </div>
                        ) : null
                      )}
                      {!!(p.metrics) && typeof p.metrics === 'object' && (
                        <div>
                          <p className="text-slate-500 font-semibold mb-1">Metrics</p>
                          <div className="flex flex-wrap gap-x-4 gap-y-1">
                            {Object.entries(p.metrics as Record<string, unknown>)
                              .filter(([k]) => k !== 'tool_name')
                              .map(([k, v]) => (
                                <span key={k} className="text-slate-400">
                                  {k.replace(/_/g, ' ')}: <span className="font-mono text-slate-200">{String(v as string | number | boolean)}</span>
                                </span>
                              ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ---- Page ----

export function Runs() {
  const [runs, setRuns] = useState<UnifiedRun[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [domainFilter, setDomainFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null)
  const [expandedSteps, setExpandedSteps] = useState<RunStep[]>([])
  const [expandedEvents, setExpandedEvents] = useState<RunEvent[]>([])
  const [detailLoading, setDetailLoading] = useState(false)

  useEffect(() => { loadRuns() }, [domainFilter, typeFilter, statusFilter]) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadRuns() {
    setLoading(true)
    try {
      const params: { limit: number; domain?: string; run_type?: string; status?: string } = { limit: 100 }
      if (domainFilter !== 'all') params.domain = domainFilter
      if (typeFilter !== 'all') params.run_type = typeFilter
      if (statusFilter !== 'all') params.status = statusFilter
      const data = await api.getUnifiedRuns(params)
      setRuns(data.runs)
      setTotal(data.total)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load runs')
    } finally {
      setLoading(false)
    }
  }

  async function toggleRun(runId: string) {
    if (expandedRunId === runId) {
      setExpandedRunId(null)
      return
    }
    setExpandedRunId(runId)
    setDetailLoading(true)
    try {
      const [stepsData, eventsData] = await Promise.all([
        api.getRunSteps(runId),
        api.getRunEvents(runId),
      ])
      setExpandedSteps(stepsData.steps)
      setExpandedEvents(eventsData.events)
    } catch {
      setExpandedSteps([])
      setExpandedEvents([])
    } finally {
      setDetailLoading(false)
    }
  }

  return (
    <div className="max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold text-slate-800 dark:text-slate-100 mb-1">Runs</h1>
      <p className="text-sm text-slate-500 mb-6">All runs across domains — retrieval, evaluation, agent sessions, and connections.</p>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        {/* Domain tabs */}
        <div className="flex items-center bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden shadow-sm">
          {['all', 'orchestration', 'evaluation', 'interoperability', 'context_engineering', 'governance'].map(d => (
            <button
              key={d}
              onClick={() => setDomainFilter(d)}
              className={`px-3 py-1.5 text-xs font-medium capitalize transition-colors ${domainFilter === d ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-50 dark:hover:bg-slate-700'}`}
            >
              {d === 'all' ? 'All' : d.replace('_', ' ')}
            </button>
          ))}
        </div>

        {/* Type select */}
        <select
          className="border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 shadow-sm focus:outline-none"
          value={typeFilter}
          onChange={e => setTypeFilter(e.target.value)}
        >
          <option value="all">All Types</option>
          <option value="runtime_test">Runtime Test</option>
          <option value="retrieval_test">Retrieval Test</option>
          <option value="benchmark_run">Benchmark Run</option>
          <option value="connection_test">Connection Test</option>
          <option value="agent_session">Agent Session</option>
        </select>

        {/* Status select */}
        <select
          className="border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 shadow-sm focus:outline-none"
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
        >
          <option value="all">All Status</option>
          <option value="running">Running</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
        </select>

        <span className="text-xs text-slate-400 ml-auto">{total} runs</span>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      )}

      {/* Table */}
      <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-32"><Spinner size="lg" /></div>
        ) : runs.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-slate-400 text-sm">No runs recorded yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-700/50 border-b border-slate-200 dark:border-slate-700">
              <tr>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-slate-500 dark:text-slate-400">Domain</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-slate-500 dark:text-slate-400">Type</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-slate-500 dark:text-slate-400">Status</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-slate-500 dark:text-slate-400">Started</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-slate-500 dark:text-slate-400">Duration</th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-slate-500 dark:text-slate-400">Tokens</th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-slate-500 dark:text-slate-400">Cost</th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-slate-500 dark:text-slate-400">Steps</th>
                <th className="w-8"></th>
              </tr>
            </thead>
            <tbody>
              {runs.map(run => (
                <RunRows
                  key={run.id}
                  run={run}
                  expanded={expandedRunId === run.id}
                  detailLoading={detailLoading}
                  expandedSteps={expandedSteps}
                  expandedEvents={expandedEvents}
                  onToggle={() => toggleRun(run.id)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// Extracted to avoid fragment-with-key issues in the map
function RunRows({
  run,
  expanded,
  detailLoading,
  expandedSteps,
  expandedEvents,
  onToggle,
}: {
  run: UnifiedRun
  expanded: boolean
  detailLoading: boolean
  expandedSteps: RunStep[]
  expandedEvents: RunEvent[]
  onToggle: () => void
}) {
  return (
    <>
      <tr
        className={`border-b border-slate-100 dark:border-slate-700 cursor-pointer transition-colors ${expanded ? 'bg-slate-50 dark:bg-slate-700/30' : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'}`}
        onClick={onToggle}
      >
        <td className="px-4 py-2.5"><DomainBadge domain={run.primary_domain} /></td>
        <td className="px-4 py-2.5 text-xs text-slate-600 dark:text-slate-300 font-mono">
          <span>{run.run_type.replace('_', ' ')}</span>
          {run.summary?.name && (
            <span className="ml-1.5 text-slate-400 dark:text-slate-500">· {run.summary.name}</span>
          )}
        </td>
        <td className="px-4 py-2.5"><StatusBadge status={run.status} /></td>
        <td className="px-4 py-2.5 text-xs text-slate-500 whitespace-nowrap">
          {parseUTC(run.started_at).toLocaleString('en-GB', {
            day: '2-digit',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })}
        </td>
        <td className="px-4 py-2.5 text-xs text-slate-600 dark:text-slate-300 font-mono">{formatDuration(run.started_at, run.ended_at)}</td>
        <td className="px-4 py-2.5 text-right text-xs font-mono text-slate-600 dark:text-slate-300">
          {run.summary?.total_tokens
            ? run.summary.total_tokens >= 1000
              ? `${(run.summary.total_tokens / 1000).toFixed(1)}K`
              : run.summary.total_tokens
            : '—'}
        </td>
        <td className="px-4 py-2.5 text-right text-xs font-mono text-slate-600 dark:text-slate-300">
          {run.summary?.total_cost_usd != null ? `$${run.summary.total_cost_usd.toFixed(4)}` : '—'}
        </td>
        <td className="px-4 py-2.5 text-right text-xs text-slate-500">{run.summary?.step_count ?? '—'}</td>
        <td className="px-2 py-2.5 text-slate-400">
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-700">
          <td colSpan={9} className="px-6 py-4">
            {detailLoading ? (
              <div className="flex items-center gap-2 text-slate-400 text-sm">
                <Spinner size="sm" /> Loading details…
              </div>
            ) : (
              <RunDetail run={run} steps={expandedSteps} events={expandedEvents} />
            )}
          </td>
        </tr>
      )}
    </>
  )
}
