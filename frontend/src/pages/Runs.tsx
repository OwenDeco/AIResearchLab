import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { api } from '../api/client'
import { Spinner } from '../components/Spinner'

interface RunSummary {
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
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    green: 'bg-green-50 text-green-700 border-green-200',
    orange: 'bg-orange-50 text-orange-700 border-orange-200',
    teal: 'bg-teal-50 text-teal-700 border-teal-200',
    rose: 'bg-rose-50 text-rose-700 border-rose-200',
    slate: 'bg-slate-50 text-slate-700 border-slate-200',
  }
  return (
    <span className={`inline-flex items-center text-xs font-medium border rounded-full px-2 py-0.5 ${classes[c] || classes.slate}`}>
      {domain.replace('_', ' ')}
    </span>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    running: 'bg-amber-50 text-amber-700 border-amber-200',
    completed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    failed: 'bg-red-50 text-red-700 border-red-200',
  }
  return (
    <span className={`inline-flex text-xs font-medium border rounded-full px-2 py-0.5 ${map[status] || 'bg-slate-50 text-slate-600 border-slate-200'}`}>
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

function RunDetail({ run, steps, events }: { run: UnifiedRun; steps: RunStep[]; events: RunEvent[] }) {
  const STEP_COLORS: Record<string, string> = {
    retrieve_chunks: 'bg-blue-500',
    llm_call: 'bg-purple-500',
    tool_call: 'bg-amber-500',
    score_answer: 'bg-green-500',
    agent_handoff: 'bg-orange-500',
    embed_query: 'bg-teal-500',
  }
  const CAT_COLORS: Record<string, string> = {
    execution: 'bg-blue-50 text-blue-700 border-blue-200',
    data: 'bg-teal-50 text-teal-700 border-teal-200',
    ai: 'bg-purple-50 text-purple-700 border-purple-200',
    connection: 'bg-orange-50 text-orange-700 border-orange-200',
    evaluation: 'bg-green-50 text-green-700 border-green-200',
    governance: 'bg-rose-50 text-rose-700 border-rose-200',
  }
  const SEV_COLORS: Record<string, string> = {
    info: 'text-slate-500',
    warning: 'text-amber-600',
    error: 'text-red-600',
  }

  return (
    <div className="space-y-5">
      {/* Summary */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-2">Run Summary</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {(
            [
              ['Latency', run.summary?.total_latency_ms != null ? `${run.summary.total_latency_ms.toFixed(0)}ms` : '—'],
              ['Tokens', run.summary?.total_tokens != null ? run.summary.total_tokens.toLocaleString() : '—'],
              ['Cost', run.summary?.total_cost_usd != null ? `$${run.summary.total_cost_usd.toFixed(5)}` : '—'],
              ['Errors', run.summary?.error_count ?? '—'],
            ] as [string, string | number][]
          ).map(([label, value]) => (
            <div key={label} className="bg-white border border-slate-200 rounded-lg p-3">
              <p className="text-xs text-slate-400 mb-0.5">{label}</p>
              <p className="text-sm font-semibold text-slate-700 font-mono">{value}</p>
            </div>
          ))}
        </div>
        {run.summary?.final_output && (
          <div className="mt-2 bg-white border border-slate-200 rounded-lg p-3">
            <p className="text-xs text-slate-400 mb-1">Output preview</p>
            <p className="text-xs text-slate-600 line-clamp-2">{run.summary.final_output}</p>
          </div>
        )}
      </div>

      {/* Steps timeline */}
      {steps.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-2">Steps Timeline</p>
          <div className="space-y-1.5">
            {steps.map(step => (
              <div key={step.id} className="flex items-center gap-3 bg-white border border-slate-200 rounded-lg px-3 py-2">
                <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${STEP_COLORS[step.step_type] || 'bg-slate-400'}`} />
                <span className="text-xs font-mono text-slate-700 w-32 flex-shrink-0">{step.step_type.replace('_', ' ')}</span>
                {step.component && <span className="text-xs text-slate-400 font-mono">{step.component}</span>}
                <div className="flex-1 mx-2">
                  {step.duration_ms != null && (
                    <div className="w-full bg-slate-100 rounded-full h-1.5">
                      <div
                        className={`h-1.5 rounded-full ${STEP_COLORS[step.step_type] || 'bg-slate-400'} opacity-60`}
                        style={{ width: `${Math.min(100, (step.duration_ms / 5000) * 100)}%`, minWidth: '4px' }}
                      />
                    </div>
                  )}
                </div>
                <span className="text-xs font-mono text-slate-500 w-16 text-right">
                  {step.duration_ms != null ? `${step.duration_ms.toFixed(0)}ms` : '—'}
                </span>
                <span className={`text-xs px-1.5 py-0.5 rounded ${step.status === 'completed' ? 'text-emerald-600' : step.status === 'failed' ? 'text-red-500' : 'text-slate-400'}`}>
                  {step.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Events log */}
      {events.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-2">Events</p>
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-100">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-slate-500">Time</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-500">Category</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-500">Event</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-500">Summary</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-500">Sev</th>
                </tr>
              </thead>
              <tbody>
                {events.map(ev => (
                  <tr key={ev.id} className="border-b border-slate-50 last:border-0">
                    <td className="px-3 py-1.5 font-mono text-slate-400 whitespace-nowrap">
                      {new Date(ev.timestamp).toLocaleTimeString('en-GB')}
                    </td>
                    <td className="px-3 py-1.5">
                      <span className={`inline-flex text-xs border rounded-full px-1.5 py-0.5 ${CAT_COLORS[ev.category] || 'bg-slate-50 text-slate-500 border-slate-200'}`}>
                        {ev.category}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 font-mono text-slate-600">{ev.event_type}</td>
                    <td className="px-3 py-1.5 text-slate-500 max-w-xs truncate">{ev.summary || '—'}</td>
                    <td className={`px-3 py-1.5 font-medium ${SEV_COLORS[ev.severity] || 'text-slate-400'}`}>{ev.severity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
      <h1 className="text-2xl font-bold text-slate-800 mb-1">Runs</h1>
      <p className="text-sm text-slate-500 mb-6">All runs across domains — retrieval, evaluation, agent sessions, and connections.</p>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        {/* Domain tabs */}
        <div className="flex items-center bg-white border border-slate-200 rounded-lg overflow-hidden shadow-sm">
          {['all', 'orchestration', 'evaluation', 'interoperability', 'context_engineering', 'governance'].map(d => (
            <button
              key={d}
              onClick={() => setDomainFilter(d)}
              className={`px-3 py-1.5 text-xs font-medium capitalize transition-colors ${domainFilter === d ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
            >
              {d === 'all' ? 'All' : d.replace('_', ' ')}
            </button>
          ))}
        </div>

        {/* Type select */}
        <select
          className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-700 bg-white shadow-sm focus:outline-none"
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
          className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-700 bg-white shadow-sm focus:outline-none"
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
      <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-32"><Spinner size="lg" /></div>
        ) : runs.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-slate-400 text-sm">No runs recorded yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-slate-500">Domain</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-slate-500">Type</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-slate-500">Status</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-slate-500">Started</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-slate-500">Duration</th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-slate-500">Tokens</th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-slate-500">Cost</th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-slate-500">Steps</th>
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
        className={`border-b border-slate-100 cursor-pointer transition-colors ${expanded ? 'bg-slate-50' : 'hover:bg-slate-50'}`}
        onClick={onToggle}
      >
        <td className="px-4 py-2.5"><DomainBadge domain={run.primary_domain} /></td>
        <td className="px-4 py-2.5 text-xs text-slate-600 font-mono">{run.run_type.replace('_', ' ')}</td>
        <td className="px-4 py-2.5"><StatusBadge status={run.status} /></td>
        <td className="px-4 py-2.5 text-xs text-slate-500 whitespace-nowrap">
          {new Date(run.started_at).toLocaleString('en-GB', {
            day: '2-digit',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })}
        </td>
        <td className="px-4 py-2.5 text-xs text-slate-600 font-mono">{formatDuration(run.started_at, run.ended_at)}</td>
        <td className="px-4 py-2.5 text-right text-xs font-mono text-slate-600">
          {run.summary?.total_tokens
            ? run.summary.total_tokens >= 1000
              ? `${(run.summary.total_tokens / 1000).toFixed(1)}K`
              : run.summary.total_tokens
            : '—'}
        </td>
        <td className="px-4 py-2.5 text-right text-xs font-mono text-slate-600">
          {run.summary?.total_cost_usd != null ? `$${run.summary.total_cost_usd.toFixed(4)}` : '—'}
        </td>
        <td className="px-4 py-2.5 text-right text-xs text-slate-500">{run.summary?.step_count ?? '—'}</td>
        <td className="px-2 py-2.5 text-slate-400">
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-slate-50 border-b border-slate-200">
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
