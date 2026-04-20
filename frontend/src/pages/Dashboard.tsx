import { useEffect, useState } from 'react'
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

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-4">
      <p className="text-sm text-slate-500 mb-1">{label}</p>
      <p className="text-2xl font-bold text-slate-800">{value}</p>
    </div>
  )
}

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

  // Aggregate runs per retrieval_mode
  const modeCountMap: Record<string, number> = {}
  for (const run of runs) {
    modeCountMap[run.retrieval_mode] = (modeCountMap[run.retrieval_mode] ?? 0) + 1
  }
  const modeChartData = Object.entries(modeCountMap).map(([mode, count]) => ({
    mode,
    count,
  }))

  const totalCost = runs.reduce((acc, r) => acc + (r.estimated_cost_usd ?? 0), 0)
  const avgLatency =
    runs.length > 0
      ? runs.reduce((acc, r) => acc + (r.latency_ms ?? 0), 0) / runs.length
      : 0

  const recentRuns = [...runs].slice(0, 10)

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    )
  }

  return (
    <div className="max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold text-slate-800 mb-6">Dashboard</h1>

      {error && (
        <div className="mb-4">
          <ErrorAlert message={error} />
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard label="Total Documents" value={documents.length} />
        <StatCard label="Total Runs" value={runs.length} />
        <StatCard label="Total Cost" value={`$${totalCost.toFixed(4)}`} />
        <StatCard label="Avg Latency" value={`${avgLatency.toFixed(0)}ms`} />
      </div>

      {/* Bar chart */}
      {modeChartData.length > 0 && (
        <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-4 mb-8">
          <h2 className="text-xl font-semibold text-slate-800 mb-4">Runs by Retrieval Mode</h2>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={modeChartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="mode" tick={{ fontSize: 12 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
              <Tooltip />
              <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Recent runs table */}
      <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-4">
        <h2 className="text-xl font-semibold text-slate-800 mb-4">Recent Runs</h2>
        {runs.length === 0 ? (
          <p className="text-slate-500 text-sm">
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
                <tr className="border-b border-slate-200">
                  <th className="text-left py-2 pr-4 text-slate-600 font-medium">Query</th>
                  <th className="text-left py-2 pr-4 text-slate-600 font-medium">Mode</th>
                  <th className="text-left py-2 pr-4 text-slate-600 font-medium">Model</th>
                  <th className="text-left py-2 pr-4 text-slate-600 font-medium">Latency</th>
                  <th className="text-left py-2 pr-4 text-slate-600 font-medium">Cost</th>
                  <th className="text-left py-2 text-slate-600 font-medium">Date</th>
                </tr>
              </thead>
              <tbody>
                {recentRuns.map((run) => (
                  <tr key={run.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="py-2 pr-4 text-slate-800 max-w-xs truncate">
                      {run.query.length > 60 ? run.query.slice(0, 60) + '…' : run.query}
                    </td>
                    <td className="py-2 pr-4 text-slate-600">{run.retrieval_mode}</td>
                    <td className="py-2 pr-4 text-slate-600 max-w-xs truncate">{run.model_name}</td>
                    <td className="py-2 pr-4 text-slate-600">{run.latency_ms?.toFixed(0)}ms</td>
                    <td className="py-2 pr-4 text-slate-600">${run.estimated_cost_usd?.toFixed(4)}</td>
                    <td className="py-2 text-slate-500">
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
