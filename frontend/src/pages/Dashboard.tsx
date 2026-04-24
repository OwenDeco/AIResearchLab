import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { api } from '../api/client'
import { useAppStore } from '../store/useAppStore'
import { Spinner } from '../components/Spinner'
import { ErrorAlert } from '../components/ErrorAlert'
import type { Run } from '../types'

function StatCard({ label, value, helper }: { label: string; value: string | number; helper?: string }) {
  return (
    <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 shadow-sm p-4">
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-1">{label}</p>
      <p className="text-2xl font-bold text-slate-800 dark:text-slate-100">{value}</p>
      {helper && <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{helper}</p>}
    </div>
  )
}

function formatHoursSince(dateIso?: string): string {
  if (!dateIso) return 'No runs yet'
  const deltaMs = Date.now() - new Date(dateIso).getTime()
  const hours = Math.max(0, Math.floor(deltaMs / (1000 * 60 * 60)))
  if (hours < 1) return 'Within the last hour'
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

const quickActions = [
  {
    title: 'Run a retrieval query',
    description: 'Use Playground to validate retrieval quality with real prompts.',
    to: '/playground',
    cta: 'Open Playground',
  },
  {
    title: 'Ingest new documents',
    description: 'Refresh your corpus so metrics and recent runs reflect current data.',
    to: '/ingestion',
    cta: 'Go to Ingestion',
  },
  {
    title: 'Compare experiment runs',
    description: 'Inspect run history and drill into timing, cost, and output quality.',
    to: '/runs',
    cta: 'View Runs',
  },
  {
    title: 'Check graph extraction',
    description: 'Verify entity relationships were extracted and connected correctly.',
    to: '/graph',
    cta: 'Open Graph Explorer',
  },
]

export function Dashboard() {
  const { documents, setDocuments } = useAppStore()
  const [runs, setRuns] = useState<Run[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      try {
        setLoading(true)
        const [runsData, docsData] = await Promise.all([
          api.getRuns(50),
          api.getDocuments(),
        ])
        setRuns(runsData)
        setDocuments(docsData)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [setDocuments])

  const modeChartData = useMemo(() => {
    const modeCountMap: Record<string, number> = {}
    for (const run of runs) {
      modeCountMap[run.retrieval_mode] = (modeCountMap[run.retrieval_mode] ?? 0) + 1
    }

    return Object.entries(modeCountMap)
      .map(([mode, count]) => ({ mode, count }))
      .sort((a, b) => b.count - a.count)
  }, [runs])

  const totalCost = runs.reduce((acc, r) => acc + (r.estimated_cost_usd ?? 0), 0)
  const avgLatency =
    runs.length > 0
      ? runs.reduce((acc, r) => acc + (r.latency_ms ?? 0), 0) / runs.length
      : 0

  const runsInLast24h = runs.filter((run) => Date.now() - new Date(run.created_at).getTime() <= 24 * 60 * 60 * 1000).length
  const docsWithGraph = documents.filter((doc) => doc.graph_extracted).length
  const graphCoveragePct = documents.length ? Math.round((docsWithGraph / documents.length) * 100) : 0
  const avgChunksPerDoc = documents.length
    ? Math.round(documents.reduce((acc, doc) => acc + (doc.chunk_count ?? 0), 0) / documents.length)
    : 0
  const recentRuns = [...runs].slice(0, 10)
  const newestRunDate = runs[0]?.created_at

  const checklist = [
    {
      label: 'At least one document ingested',
      done: documents.length > 0,
      action: '/ingestion',
      actionLabel: 'Upload documents',
    },
    {
      label: 'At least one retrieval run executed',
      done: runs.length > 0,
      action: '/playground',
      actionLabel: 'Run a query',
    },
    {
      label: 'Graph extraction completed for documents',
      done: docsWithGraph > 0,
      action: '/graph',
      actionLabel: 'Inspect graph',
    },
  ]

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    )
  }

  return (
    <div className="max-w-7xl mx-auto">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 dark:text-slate-100">Project Dashboard</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Snapshot of ingestion coverage, retrieval activity, and next steps.
          </p>
        </div>
        <div className="text-sm text-slate-500 dark:text-slate-400">Latest run: {formatHoursSince(newestRunDate)}</div>
      </div>

      {error && (
        <div className="mb-4">
          <ErrorAlert message={error} />
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 mb-8">
        <StatCard label="Corpus Size" value={`${documents.length} docs`} helper={`${avgChunksPerDoc} avg chunks/doc`} />
        <StatCard label="Runs (24h)" value={runsInLast24h} helper={`${runs.length} total tracked runs`} />
        <StatCard label="Graph Coverage" value={`${graphCoveragePct}%`} helper={`${docsWithGraph}/${documents.length || 0} docs extracted`} />
        <StatCard label="Spend + Latency" value={`$${totalCost.toFixed(4)}`} helper={`${avgLatency.toFixed(0)}ms average`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-8">
        <div className="lg:col-span-2 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 shadow-sm p-4">
          <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100 mb-4">Runs by Retrieval Mode</h2>
          {modeChartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={modeChartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="mode" tick={{ fontSize: 12 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                <Tooltip />
                <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-sm text-slate-500 dark:text-slate-400">No runs yet. Execute one in Playground to populate this chart.</p>
          )}
        </div>

        <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 shadow-sm p-4">
          <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100 mb-3">Setup Checklist</h2>
          <ul className="space-y-3">
            {checklist.map((item) => (
              <li key={item.label} className="flex items-start justify-between gap-4">
                <div className="text-sm">
                  <p className="text-slate-700 dark:text-slate-200">{item.label}</p>
                  <p className={`text-xs mt-1 ${item.done ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                    {item.done ? 'Done' : 'Needs attention'}
                  </p>
                </div>
                {!item.done && (
                  <Link to={item.action} className="text-xs text-blue-600 hover:underline whitespace-nowrap">
                    {item.actionLabel}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 shadow-sm p-4 mb-8">
        <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100 mb-4">Quick Actions</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {quickActions.map((action) => (
            <div key={action.title} className="rounded-md border border-slate-200 dark:border-slate-700 p-3">
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{action.title}</p>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{action.description}</p>
              <Link to={action.to} className="inline-block text-sm text-blue-600 hover:underline mt-2">
                {action.cta}
              </Link>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 shadow-sm p-4">
        <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100 mb-4">Recent Runs</h2>
        {runs.length === 0 ? (
          <p className="text-slate-500 dark:text-slate-400 text-sm">
            No runs yet. Head to the{' '}
            <Link to="/playground" className="text-blue-600 hover:underline">
              Playground
            </Link>{' '}
            to get started.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-700">
                  <th className="text-left py-2 pr-4 text-slate-600 dark:text-slate-300 font-medium">Query</th>
                  <th className="text-left py-2 pr-4 text-slate-600 dark:text-slate-300 font-medium">Mode</th>
                  <th className="text-left py-2 pr-4 text-slate-600 dark:text-slate-300 font-medium">Model</th>
                  <th className="text-left py-2 pr-4 text-slate-600 dark:text-slate-300 font-medium">Latency</th>
                  <th className="text-left py-2 pr-4 text-slate-600 dark:text-slate-300 font-medium">Cost</th>
                  <th className="text-left py-2 text-slate-600 dark:text-slate-300 font-medium">Date</th>
                </tr>
              </thead>
              <tbody>
                {recentRuns.map((run) => (
                  <tr key={run.id} className="border-b border-slate-100 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700">
                    <td className="py-2 pr-4 text-slate-800 dark:text-slate-100 max-w-xs truncate">
                      {run.query.length > 60 ? run.query.slice(0, 60) + '…' : run.query}
                    </td>
                    <td className="py-2 pr-4 text-slate-600 dark:text-slate-300">{run.retrieval_mode}</td>
                    <td className="py-2 pr-4 text-slate-600 dark:text-slate-300 max-w-xs truncate">{run.model_name}</td>
                    <td className="py-2 pr-4 text-slate-600 dark:text-slate-300">{run.latency_ms?.toFixed(0)}ms</td>
                    <td className="py-2 pr-4 text-slate-600 dark:text-slate-300">${run.estimated_cost_usd?.toFixed(4)}</td>
                    <td className="py-2 text-slate-500 dark:text-slate-400">
                      {new Date(run.created_at).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
