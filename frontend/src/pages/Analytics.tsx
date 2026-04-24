import { useEffect, useState } from 'react'
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import { api } from '../api/client'
import { Spinner } from '../components/Spinner'
import { ErrorAlert } from '../components/ErrorAlert'
import type { Run } from '../types'
import { parseUTC } from '../utils/date'

// ─── Types ────────────────────────────────────────────────────────────────────

type DateRange = '7d' | '30d' | 'all'
type Tab = 'queries' | 'connections' | 'tokens' | 'platform'

type AnalyticsSummary = Awaited<ReturnType<typeof api.getAnalyticsSummary>>

// ─── Legacy helpers (kept for CSV export) ────────────────────────────────────

function downloadCSV(runs: Run[]) {
  const headers = [
    'id', 'query', 'retrieval_mode', 'model_name', 'embed_model',
    'latency_ms', 'prompt_tokens', 'completion_tokens', 'estimated_cost_usd',
    'chunk_count', 'created_at',
  ]
  const escape = (v: unknown) => {
    const s = String(v ?? '')
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s
  }
  const rows = runs.map((r) => headers.map((h) => escape(r[h as keyof Run])).join(','))
  const csv = [headers.join(','), ...rows].join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'rag_runs.csv'
  a.click()
  URL.revokeObjectURL(url)
}

// ─── Date filtering ───────────────────────────────────────────────────────────

function filterByDateStr<T extends { date: string }>(rows: T[], range: DateRange): T[] {
  if (range === 'all') return rows
  const days = range === '7d' ? 7 : 30
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const cutoffStr = cutoff.toISOString().slice(0, 10)
  return rows.filter((r) => r.date >= cutoffStr)
}

// ─── Small UI components ──────────────────────────────────────────────────────

function KPIBox({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 shadow-sm p-4 flex flex-col gap-1">
      <span className="text-2xl font-bold text-slate-800 dark:text-slate-100">{value}</span>
      <span className="text-xs text-slate-500">{label}</span>
    </div>
  )
}

function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 shadow-sm p-4">
      {title && <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">{title}</h2>}
      {children}
    </div>
  )
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm rounded-md border transition-colors ${
        active
          ? 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100 font-medium shadow-sm'
          : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-300 dark:hover:text-slate-100'
      }`}
    >
      {label}
    </button>
  )
}

// ─── RAG Queries Tab ─────────────────────────────────────────────────────────

function QueriesTab({
  summary,
  range,
  runs,
}: {
  summary: AnalyticsSummary
  range: DateRange
  runs: Run[]
}) {
  const byDay = filterByDateStr(summary.runs.by_day, range)
  const { by_mode, by_model, latency_percentiles } = summary.runs

  const totalRuns = byDay.reduce((s, d) => s + d.count, 0)
  const totalCost = byDay.reduce((s, d) => s + d.total_cost_usd, 0)
  const avgLatency =
    byDay.length > 0
      ? byDay.reduce((s, d) => s + d.avg_latency_ms * d.count, 0) / (totalRuns || 1)
      : 0
  const totalTokens = byDay.reduce(
    (s, d) => s + d.total_prompt_tokens + d.total_completion_tokens,
    0
  )
  const avgTokensPerRun = totalRuns > 0 ? Math.round(totalTokens / totalRuns) : 0

  return (
    <div className="space-y-4">
      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KPIBox label="Total Runs" value={totalRuns} />
        <KPIBox label="Avg Latency" value={`${Math.round(avgLatency)} ms`} />
        <KPIBox label="Total Cost" value={`$${totalCost.toFixed(4)}`} />
        <KPIBox label="Avg Tokens / Run" value={avgTokensPerRun.toLocaleString()} />
      </div>

      {/* Charts row 1 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card title="Runs per Day">
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={byDay} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Line type="monotone" dataKey="count" stroke="#2563eb" strokeWidth={2} dot={{ r: 3 }} name="Runs" />
            </LineChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Avg Latency by Retrieval Mode (ms)">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={by_mode} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="mode" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v) => [`${v} ms`, 'Avg Latency']} />
              <Bar dataKey="avg_latency_ms" fill="#3b82f6" radius={[3, 3, 0, 0]} name="Avg Latency (ms)" />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Avg Cost by Retrieval Mode ($)">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={by_mode} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="mode" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v) => [`$${Number(v).toFixed(6)}`, 'Avg Cost']} />
              <Bar dataKey="avg_cost_usd" fill="#60a5fa" radius={[3, 3, 0, 0]} name="Avg Cost ($)" />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Token Usage by Model (total)">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={by_model} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="model" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="total_prompt_tokens" stackId="a" fill="#3b82f6" name="Prompt" />
              <Bar dataKey="total_completion_tokens" stackId="a" fill="#93c5fd" name="Completion" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      {/* Summary table + percentiles */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="md:col-span-2">
          <Card title="Summary by Retrieval Mode">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-600">
                    <th className="text-left py-2 pr-4 text-slate-600 dark:text-slate-300 font-medium">Mode</th>
                    <th className="text-right py-2 pr-4 text-slate-600 dark:text-slate-300 font-medium">Runs</th>
                    <th className="text-right py-2 pr-4 text-slate-600 dark:text-slate-300 font-medium">Avg Latency</th>
                    <th className="text-right py-2 pr-4 text-slate-600 dark:text-slate-300 font-medium">Avg Cost</th>
                    <th className="text-right py-2 text-slate-600 dark:text-slate-300 font-medium">Avg Chunks</th>
                  </tr>
                </thead>
                <tbody>
                  {by_mode.map((row) => (
                    <tr key={row.mode} className="border-b border-slate-100 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700/50">
                      <td className="py-2 pr-4 text-slate-800 dark:text-slate-100 font-medium">{row.mode}</td>
                      <td className="py-2 pr-4 text-right text-slate-600 dark:text-slate-300">{row.count}</td>
                      <td className="py-2 pr-4 text-right text-slate-600 dark:text-slate-300">{row.avg_latency_ms.toFixed(0)} ms</td>
                      <td className="py-2 pr-4 text-right text-slate-600 dark:text-slate-300">${row.avg_cost_usd.toFixed(4)}</td>
                      <td className="py-2 text-right text-slate-600 dark:text-slate-300">{row.avg_chunks.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        <Card title="Latency Percentiles">
          <div className="space-y-4 mt-2">
            {(['p50', 'p90', 'p99'] as const).map((p) => (
              <div key={p} className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-600 dark:text-slate-300 uppercase">{p}</span>
                <span className="text-xl font-bold text-slate-800 dark:text-slate-100">
                  {latency_percentiles[p].toLocaleString()} ms
                </span>
              </div>
            ))}
          </div>
          <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-700 flex items-center justify-between">
            <span className="text-xs text-slate-500">Export runs as CSV</span>
            <button
              className="border border-slate-300 rounded px-3 py-1 text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700"
              onClick={() => downloadCSV(runs)}
            >
              Export CSV
            </button>
          </div>
        </Card>
      </div>
    </div>
  )
}

// ─── Connections Tab ──────────────────────────────────────────────────────────

function ConnectionsTab({
  summary,
  range,
}: {
  summary: AnalyticsSummary
  range: DateRange
}) {
  const { connections } = summary
  const errByDay = filterByDateStr(connections.errors_by_day, range)
  const callsByDay = filterByDateStr(connections.agent_calls_by_day, range)

  return (
    <div className="space-y-4">
      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KPIBox label="Total Events" value={connections.total_events} />
        <KPIBox label="Inbound Calls" value={connections.inbound_calls} />
        <KPIBox label="Outbound Calls" value={connections.outbound_calls} />
        <KPIBox label="Internal Events" value={connections.internal_events} />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card title="Agent Calls per Day">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={callsByDay} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="ui_calls" stackId="a" fill="#3b82f6" name="UI Calls" />
              <Bar dataKey="a2a_calls" stackId="a" fill="#60a5fa" name="A2A Calls" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Events by Type">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart
              data={connections.by_event_type}
              layout="vertical"
              margin={{ top: 5, right: 10, left: 80, bottom: 5 }}
            >
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
              <YAxis dataKey="event_type" type="category" tick={{ fontSize: 10 }} width={80} />
              <Tooltip />
              <Bar dataKey="count" fill="#3b82f6" radius={[0, 3, 3, 0]} name="Count" />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Errors per Day vs Total Events">
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={errByDay} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="total" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3 }} name="Total" />
              <Line type="monotone" dataKey="errors" stroke="#ef4444" strokeWidth={2} dot={{ r: 3 }} name="Errors" />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      </div>

      {/* Per-connection table */}
      <Card title="Per-Connection Breakdown">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-600">
                <th className="text-left py-2 pr-4 text-slate-600 dark:text-slate-300 font-medium">Name</th>
                <th className="text-left py-2 pr-4 text-slate-600 dark:text-slate-300 font-medium">Type</th>
                <th className="text-right py-2 pr-4 text-slate-600 dark:text-slate-300 font-medium">Inbound</th>
                <th className="text-right py-2 pr-4 text-slate-600 dark:text-slate-300 font-medium">Outbound</th>
                <th className="text-right py-2 pr-4 text-slate-600 dark:text-slate-300 font-medium">Errors</th>
                <th className="text-right py-2 text-slate-600 dark:text-slate-300 font-medium">Error Rate</th>
              </tr>
            </thead>
            <tbody>
              {connections.by_connection.map((row) => {
                const total = row.inbound + row.outbound
                const rate = total > 0 ? ((row.errors / total) * 100).toFixed(1) : '0.0'
                return (
                  <tr key={row.name} className="border-b border-slate-100 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700/50">
                    <td className="py-2 pr-4 text-slate-800 dark:text-slate-100 font-medium">{row.name}</td>
                    <td className="py-2 pr-4 text-slate-500 dark:text-slate-400">{row.type || '—'}</td>
                    <td className="py-2 pr-4 text-right text-slate-600 dark:text-slate-300">{row.inbound}</td>
                    <td className="py-2 pr-4 text-right text-slate-600 dark:text-slate-300">{row.outbound}</td>
                    <td className="py-2 pr-4 text-right text-red-600 dark:text-red-400">{row.errors}</td>
                    <td className="py-2 text-right text-slate-600 dark:text-slate-300">{rate}%</td>
                  </tr>
                )
              })}
              {connections.by_connection.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-4 text-center text-slate-500">No connection data yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

// ─── Token & Cost Tab ─────────────────────────────────────────────────────────

function TokensTab({
  summary,
  range,
}: {
  summary: AnalyticsSummary
  range: DateRange
}) {
  const runsByDay   = filterByDateStr(summary.runs.by_day, range)
  const agentByDay  = filterByDateStr(summary.agent_tokens.by_day, range)

  // Combine runs + agent into a single day map for charts
  const allDates = Array.from(new Set([
    ...runsByDay.map(d => d.date),
    ...agentByDay.map(d => d.date),
  ])).sort()

  const runsMap  = Object.fromEntries(runsByDay.map(d => [d.date, d]))
  const agentMap = Object.fromEntries(agentByDay.map(d => [d.date, d]))

  const combinedByDay = allDates.map(date => ({
    date,
    runs_cost:    runsMap[date]?.total_cost_usd ?? 0,
    agent_cost:   agentMap[date]?.cost_usd ?? 0,
    run_prompt:   runsMap[date]?.total_prompt_tokens ?? 0,
    run_completion: runsMap[date]?.total_completion_tokens ?? 0,
    agent_prompt: agentMap[date]?.prompt_tokens ?? 0,
    agent_completion: agentMap[date]?.completion_tokens ?? 0,
  }))

  // Merge run + agent tokens per model
  const modelCostMap: Record<string, { model: string; runs_cost: number; agent_cost: number; run_prompt: number; run_completion: number; agent_prompt: number; agent_completion: number }> = {}
  for (const m of summary.runs.by_model) {
    if (!modelCostMap[m.model]) modelCostMap[m.model] = { model: m.model, runs_cost: 0, agent_cost: 0, run_prompt: 0, run_completion: 0, agent_prompt: 0, agent_completion: 0 }
    modelCostMap[m.model].runs_cost += m.total_cost_usd
    modelCostMap[m.model].run_prompt += m.total_prompt_tokens
    modelCostMap[m.model].run_completion += m.total_completion_tokens
  }
  for (const m of summary.agent_tokens.by_model) {
    if (!modelCostMap[m.model]) modelCostMap[m.model] = { model: m.model, runs_cost: 0, agent_cost: 0, run_prompt: 0, run_completion: 0, agent_prompt: 0, agent_completion: 0 }
    modelCostMap[m.model].agent_cost += m.cost_usd
    modelCostMap[m.model].agent_prompt += m.prompt_tokens
    modelCostMap[m.model].agent_completion += m.completion_tokens
  }
  const byModel = Object.values(modelCostMap)

  const totalRunsCost  = runsByDay.reduce((s, d) => s + d.total_cost_usd, 0)
  const totalAgentCost = agentByDay.reduce((s, d) => s + d.cost_usd, 0)
  const totalRuns      = runsByDay.reduce((s, d) => s + d.count, 0)
  const avgCostPerRun  = totalRuns > 0 ? (totalRunsCost + totalAgentCost) / totalRuns : 0

  return (
    <div className="space-y-4">
      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KPIBox label="Playground / Runs Cost" value={`$${totalRunsCost.toFixed(4)}`} />
        <KPIBox label="Agent Tool-Calling Cost" value={`$${totalAgentCost.toFixed(4)}`} />
        <KPIBox label="Combined Total" value={`$${(totalRunsCost + totalAgentCost).toFixed(4)}`} />
        <KPIBox label="Avg Cost / Run" value={`$${avgCostPerRun.toFixed(4)}`} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Combined daily cost */}
        <Card title="Daily Cost Breakdown ($)">
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={combinedByDay} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <defs>
                <linearGradient id="gradRuns" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gradAgent" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v) => [`$${Number(v).toFixed(6)}`]} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area type="monotone" dataKey="runs_cost"  stackId="1" stroke="#2563eb" fill="url(#gradRuns)"  name="Playground" strokeWidth={2} />
              <Area type="monotone" dataKey="agent_cost" stackId="1" stroke="#7c3aed" fill="url(#gradAgent)" name="Agent calls" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </Card>

        {/* Combined daily tokens */}
        <Card title="Daily Token Usage (Playground + Agent)">
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={combinedByDay} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <defs>
                <linearGradient id="gradP" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gradC" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#93c5fd" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#93c5fd" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gradAP" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gradAC" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#c4b5fd" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#c4b5fd" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area type="monotone" dataKey="run_prompt"       stackId="1" stroke="#2563eb" fill="url(#gradP)"  name="Run prompt"      strokeWidth={1} />
              <Area type="monotone" dataKey="run_completion"   stackId="1" stroke="#60a5fa" fill="url(#gradC)"  name="Run completion"  strokeWidth={1} />
              <Area type="monotone" dataKey="agent_prompt"     stackId="1" stroke="#7c3aed" fill="url(#gradAP)" name="Agent prompt"    strokeWidth={1} />
              <Area type="monotone" dataKey="agent_completion" stackId="1" stroke="#a78bfa" fill="url(#gradAC)" name="Agent completion" strokeWidth={1} />
            </AreaChart>
          </ResponsiveContainer>
        </Card>

        {/* Cost by model */}
        <Card title="Total Cost by Model ($)">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={byModel} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="model" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v) => [`$${Number(v).toFixed(6)}`]} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="runs_cost"  stackId="a" fill="#3b82f6" name="Playground" />
              <Bar dataKey="agent_cost" stackId="a" fill="#7c3aed" name="Agent calls" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        {/* Tokens by model */}
        <Card title="Total Tokens by Model">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={byModel} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="model" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="run_prompt"       stackId="a" fill="#3b82f6" name="Run prompt" />
              <Bar dataKey="run_completion"   stackId="a" fill="#93c5fd" name="Run completion" />
              <Bar dataKey="agent_prompt"     stackId="a" fill="#7c3aed" name="Agent prompt" />
              <Bar dataKey="agent_completion" stackId="a" fill="#c4b5fd" name="Agent completion" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

    </div>
  )
}

// ─── Platform Tab ─────────────────────────────────────────────────────────────

const SYSTEM_EVENT_ICONS: Record<string, string> = {
  ngrok_start: '🟢',
  ngrok_stop: '🔴',
  registered: '➕',
  deleted: '🗑',
  tested: '🔍',
}

function PlatformTab({
  summary,
  range,
}: {
  summary: AnalyticsSummary
  range: DateRange
}) {
  const { platform } = summary
  const docsByDay = filterByDateStr(platform.documents_by_day, range)

  return (
    <div className="space-y-4">
      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KPIBox label="Documents Ingested" value={platform.documents_ingested} />
        <KPIBox label="Total Chunks" value={platform.total_chunks.toLocaleString()} />
        <KPIBox label="Benchmark Runs" value={platform.benchmark_runs} />
        <KPIBox label="Agent Sessions" value={platform.agent_sessions} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card title="Documents Ingested per Day">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={docsByDay} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="count" fill="#10b981" radius={[3, 3, 0, 0]} name="Documents" />
              <Bar dataKey="chunks" fill="#6ee7b7" radius={[3, 3, 0, 0]} name="Chunks" />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        {/* Risk signals */}
        <Card title="Risk Signals (last 24h)">
          {platform.risk_signals.length === 0 ? (
            <div className="flex items-center gap-2 py-4">
              <span className="text-emerald-600 font-semibold">All clear</span>
              <span className="text-slate-400 text-sm">— no risk signals detected in the last 24 hours.</span>
            </div>
          ) : (
            <div className="space-y-2">
              {platform.risk_signals.map((s, i) => (
                <div
                  key={i}
                  className={`flex items-start justify-between rounded-md border px-3 py-2 ${
                    s.level === 'error'
                      ? 'bg-red-50 border-red-200 text-red-800'
                      : 'bg-amber-50 border-amber-200 text-amber-800'
                  }`}
                >
                  <div>
                    <span className="font-medium text-sm">{s.signal}</span>
                    <span className="ml-2 text-xs opacity-75">({s.since})</span>
                  </div>
                  <span className="text-sm font-bold ml-4 shrink-0">{s.count}×</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* System events + agent activity */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card title="System Events Timeline">
          {platform.system_events.length === 0 ? (
            <p className="text-sm text-slate-500 py-2">No system events yet.</p>
          ) : (
            <div className="max-h-64 overflow-y-auto space-y-1 text-sm">
              {platform.system_events.map((ev, i) => (
                <div key={i} className="flex items-start gap-2 py-1 border-b border-slate-100 last:border-0">
                  <span className="shrink-0 w-5 text-center">
                    {SYSTEM_EVENT_ICONS[ev.event_type] ?? '•'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <span className="text-slate-700 dark:text-slate-200">{ev.summary}</span>
                  </div>
                  <span className="text-xs text-slate-400 shrink-0 whitespace-nowrap">
                    {parseUTC(ev.timestamp).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Agent Activity">
          <div className="mb-3 flex items-center gap-2">
            <span className="text-sm text-slate-600">
              {platform.agent_sessions} sessions · {platform.agent_messages_total.toLocaleString()} messages total
            </span>
          </div>
          {/* If we have summary per session, that comes from the main runs data — just show totals */}
          <div className="text-xs text-slate-400 pt-2 border-t border-slate-100">
            Detailed session breakdown available in the Agent page.
          </div>
        </Card>
      </div>
    </div>
  )
}

// ─── Root component ───────────────────────────────────────────────────────────

export function Analytics() {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null)
  const [runs, setRuns] = useState<Run[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dateRange, setDateRange] = useState<DateRange>('all')
  const [tab, setTab] = useState<Tab>('queries')

  async function load() {
    try {
      setLoading(true)
      const [s, r] = await Promise.all([api.getAnalyticsSummary(), api.getRuns(500)])
      setSummary(s)
      setRuns(r)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    )
  }

  return (
    <div className="max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold text-slate-800 dark:text-slate-100 mb-6">Analytics</h1>

      {error && (
        <div className="mb-4">
          <ErrorAlert message={error} />
        </div>
      )}

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-4 mb-5">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-slate-600 dark:text-slate-300">Date Range:</label>
          <select
            className="border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 text-sm bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value as DateRange)}
          >
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="all">All time</option>
          </select>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 ml-auto bg-slate-100 dark:bg-slate-700 rounded-lg p-1">
          {(
            [
              { key: 'queries', label: 'RAG Queries' },
              { key: 'connections', label: 'Connections' },
              { key: 'tokens', label: 'Token & Cost' },
              { key: 'platform', label: 'Platform' },
            ] as { key: Tab; label: string }[]
          ).map((t) => (
            <TabButton
              key={t.key}
              label={t.label}
              active={tab === t.key}
              onClick={() => setTab(t.key)}
            />
          ))}
        </div>
      </div>

      {/* Tab content */}
      {summary === null ? (
        <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 shadow-sm p-8 text-center">
          <p className="text-slate-500">No analytics data available yet.</p>
        </div>
      ) : (
        <>
          {tab === 'queries' && <QueriesTab summary={summary} range={dateRange} runs={runs} />}
          {tab === 'connections' && <ConnectionsTab summary={summary} range={dateRange} />}
          {tab === 'tokens' && <TokensTab summary={summary} range={dateRange} />}
          {tab === 'platform' && <PlatformTab summary={summary} range={dateRange} />}
        </>
      )}
    </div>
  )
}
