import { useEffect, useState } from 'react'
import { RefreshCw, Trash2 } from 'lucide-react'
import { api } from '../api/client'

interface LogEntry {
  id: string
  timestamp: string
  trace_id: string | null
  run_id: string | null
  event_type: string
  direction: string
  connection_type: string | null
  connection_name: string | null
  connection_id: string | null
  caller: string | null
  summary: string
  details: any
}

const DIR_COLORS: Record<string, string> = {
  inbound:  'bg-violet-50 text-violet-700 border-violet-200',
  outbound: 'bg-blue-50 text-blue-700 border-blue-200',
  internal: 'bg-amber-50 text-amber-700 border-amber-200',
  system:   'bg-slate-100 text-slate-600 border-slate-200',
}

const TYPE_COLORS: Record<string, string> = {
  a2a:   'bg-violet-50 text-violet-600',
  mcp:   'bg-blue-50 text-blue-600',
  ngrok: 'bg-amber-50 text-amber-600',
  agent: 'bg-emerald-50 text-emerald-600',
}

// Deterministic color palette for trace badges — cycles by hash
const TRACE_COLORS = [
  'bg-sky-100 text-sky-700',
  'bg-fuchsia-100 text-fuchsia-700',
  'bg-lime-100 text-lime-700',
  'bg-orange-100 text-orange-700',
  'bg-teal-100 text-teal-700',
  'bg-rose-100 text-rose-700',
  'bg-indigo-100 text-indigo-700',
  'bg-yellow-100 text-yellow-700',
]

function traceColor(traceId: string): string {
  let hash = 0
  for (let i = 0; i < traceId.length; i++) hash = (hash * 31 + traceId.charCodeAt(i)) >>> 0
  return TRACE_COLORS[hash % TRACE_COLORS.length]
}

type Direction = 'all' | 'inbound' | 'outbound' | 'internal' | 'system'

export function Logs() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [direction, setDirection] = useState<Direction>('all')
  const [activeTrace, setActiveTrace] = useState<string | null>(null)
  const [filterRunId, setFilterRunId] = useState<string | null>(null)

  async function load(quiet = false) {
    if (!quiet) setLoading(true)
    else setRefreshing(true)
    try {
      const data = await api.getConnectionLogs({ limit: 500 })
      setLogs(data)
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleClear() {
    setClearing(true)
    await api.clearConnectionLogs().catch(console.error)
    setLogs([])
    setActiveTrace(null)
    setFilterRunId(null)
    setClearing(false)
  }

  const filtered = logs.filter((l) => {
    if (direction !== 'all' && l.direction !== direction) return false
    if (activeTrace && l.trace_id !== activeTrace) return false
    if (filterRunId && l.run_id !== filterRunId) return false
    return true
  })

  return (
    <div className="max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 dark:text-slate-100">Logs</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">Audit trail for all connection events — inbound calls, registrations, tunnel changes</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => load(true)}
            disabled={refreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-slate-300 dark:border-slate-600 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors text-slate-600 dark:text-slate-300 disabled:opacity-50"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button
            onClick={handleClear}
            disabled={clearing || logs.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-red-200 rounded-lg hover:bg-red-50 transition-colors text-red-600 disabled:opacity-40"
          >
            <Trash2 size={14} />
            {clearing ? 'Clearing…' : 'Clear all'}
          </button>
        </div>
      </div>

      {/* Direction filter + trace filter */}
      <div className="flex flex-wrap gap-1 mb-4 items-center">
        {(['all', 'inbound', 'outbound', 'internal', 'system'] as Direction[]).map((d) => (
          <button
            key={d}
            onClick={() => setDirection(d)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${direction === d ? 'bg-slate-800 dark:bg-slate-600 text-white' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'}`}
          >
            {d.charAt(0).toUpperCase() + d.slice(1)}
            {d !== 'all' && (
              <span className="ml-1.5 text-xs opacity-70">
                {logs.filter((l) => l.direction === d).length}
              </span>
            )}
          </button>
        ))}

        {activeTrace && (
          <div className={`ml-2 flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-mono font-semibold ${traceColor(activeTrace)}`}>
            trace: {activeTrace.slice(0, 8)}
            <button onClick={() => setActiveTrace(null)} className="ml-1 opacity-60 hover:opacity-100">✕</button>
          </div>
        )}

        {filterRunId && (
          <div className="flex items-center gap-1 bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-700 rounded px-2 py-1 text-xs text-indigo-700 dark:text-indigo-300">
            <span>Run: {filterRunId.slice(0, 8)}</span>
            <button onClick={() => setFilterRunId(null)} className="ml-1 hover:text-indigo-900 font-medium">✕</button>
          </div>
        )}

        <span className="ml-auto text-xs text-slate-400 dark:text-slate-500 self-center">{filtered.length} event{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      {loading ? (
        <div className="flex justify-center py-20 text-slate-400 dark:text-slate-500">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-12 text-center text-slate-400 dark:text-slate-500">
          <p className="text-base font-medium mb-1">No events yet</p>
          <p className="text-sm">Connection activity will appear here as you use the lab.</p>
        </div>
      ) : (
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-800">
                <th className="text-left px-4 py-3 text-slate-500 dark:text-slate-300 font-medium w-40">Time</th>
                <th className="text-left px-3 py-3 text-slate-500 dark:text-slate-300 font-medium w-20">Trace</th>
                <th className="text-left px-3 py-3 text-slate-500 dark:text-slate-300 font-medium w-20">Run</th>
                <th className="text-left px-4 py-3 text-slate-500 dark:text-slate-300 font-medium w-24">Direction</th>
                <th className="text-left px-4 py-3 text-slate-500 dark:text-slate-300 font-medium w-16">Type</th>
                <th className="text-left px-4 py-3 text-slate-500 dark:text-slate-300 font-medium w-36">Event</th>
                <th className="text-left px-4 py-3 text-slate-500 dark:text-slate-300 font-medium">Summary</th>
                <th className="text-left px-4 py-3 text-slate-500 dark:text-slate-300 font-medium w-28">Caller</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((log) => (
                <tr
                  key={log.id}
                  className={`border-b border-slate-50 hover:bg-slate-50/60 transition-colors ${activeTrace && log.trace_id === activeTrace ? 'bg-slate-50/80' : ''}`}
                >
                  <td className="px-4 py-2.5 font-mono text-slate-400 whitespace-nowrap">
                    {new Date(log.timestamp).toLocaleString(undefined, {
                      month: 'short', day: '2-digit',
                      hour: '2-digit', minute: '2-digit', second: '2-digit',
                    })}
                  </td>
                  <td className="px-3 py-2.5">
                    {log.trace_id ? (
                      <button
                        title={`Filter to trace ${log.trace_id}`}
                        onClick={() => setActiveTrace(activeTrace === log.trace_id ? null : log.trace_id)}
                        className={`inline-flex items-center px-1.5 py-0.5 rounded font-mono text-[10px] font-semibold cursor-pointer hover:opacity-80 transition-opacity ${traceColor(log.trace_id)}`}
                      >
                        {log.trace_id.slice(0, 8)}
                      </button>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {log.run_id ? (
                      <button
                        className="inline-flex items-center text-xs font-mono bg-indigo-50 text-indigo-600 border border-indigo-200 rounded px-1.5 py-0.5 hover:bg-indigo-100 whitespace-nowrap"
                        onClick={() => setFilterRunId(filterRunId === log.run_id ? null : log.run_id)}
                        title={log.run_id}
                      >
                        {log.run_id.slice(0, 8)}
                      </button>
                    ) : (
                      <span className="text-slate-300 text-xs">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-semibold uppercase tracking-wide ${DIR_COLORS[log.direction] ?? 'bg-slate-100 text-slate-500 border-slate-200'}`}>
                      {log.direction}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    {log.connection_type && (
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold uppercase ${TYPE_COLORS[log.connection_type] ?? 'bg-slate-50 text-slate-500'}`}>
                        {log.connection_type}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-slate-500">{log.event_type}</td>
                  <td className="px-4 py-2.5 text-slate-700">{log.summary}</td>
                  <td className="px-4 py-2.5 font-mono text-slate-400 truncate max-w-[7rem]">{log.caller ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
