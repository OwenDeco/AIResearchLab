import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { useAppStore } from '../store/useAppStore'
import { Spinner } from '../components/Spinner'
import { ErrorAlert } from '../components/ErrorAlert'
import { Badge } from '../components/Badge'
import type { QueryResponse } from '../types'
import { ChevronDown, ChevronUp, Plug } from 'lucide-react'

const RETRIEVAL_MODES = [
  { value: 'lexical', label: 'Lexical' },
  { value: 'vector', label: 'Vector' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'semantic_rerank', label: 'Semantic Rerank' },
  { value: 'graph_rag', label: 'Graph RAG' },
  { value: 'parent_child', label: 'Parent-Child' },
]

function ContextCard({ ctx, index }: { ctx: QueryResponse['contexts'][0]; index: number }) {
  const [expanded, setExpanded] = useState(false)
  const graphSummary = ctx.metadata?.graph_summary as string | undefined

  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-lg p-3">
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <Badge variant="blue">#{index + 1}</Badge>
        <Badge variant="green">score: {ctx.score.toFixed(3)}</Badge>
        <span className="text-xs text-slate-500 dark:text-slate-400 font-mono">
          {ctx.doc_id.length > 20 ? ctx.doc_id.slice(0, 20) + '…' : ctx.doc_id}
        </span>
      </div>

      {graphSummary && (
        <p className="text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800 rounded p-1.5 mb-2 font-mono leading-relaxed">
          {graphSummary}
        </p>
      )}

      <p className="text-sm text-slate-700 dark:text-slate-200">
        {expanded ? ctx.content : ctx.content.slice(0, 300) + (ctx.content.length > 300 ? '…' : '')}
      </p>
      {ctx.content.length > 300 && (
        <button
          className="mt-1 text-xs text-blue-600 hover:underline flex items-center gap-1"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? (
            <>
              <ChevronUp size={12} /> Show less
            </>
          ) : (
            <>
              <ChevronDown size={12} /> Show more
            </>
          )}
        </button>
      )}
    </div>
  )
}

export function Playground() {
  const { models, setModels } = useAppStore()

  const [query, setQuery] = useState('')
  const [retrievalMode, setRetrievalMode] = useState('vector')
  const [modelName, setModelName] = useState('')
  const [embedModel, setEmbedModel] = useState('')
  const [topK, setTopK] = useState(5)
  const [alpha, setAlpha] = useState(0.5)
  const [graphHops, setGraphHops] = useState(2)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<QueryResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  // External connection
  const [useExternalConn, setUseExternalConn] = useState(false)
  const [extConnections, setExtConnections] = useState<{ id: string; name: string; type: string }[]>([])
  const [selectedExtConn, setSelectedExtConn] = useState('')

  // Load models if not yet loaded
  useEffect(() => {
    if (!models) {
      api
        .getModels()
        .then((m) => {
          setModels(m)
        })
        .catch(console.error)
    }
  }, [models, setModels])

  // Set defaults when models are available
  useEffect(() => {
    if (models) {
      if (!modelName && models.llms.length > 0) setModelName(models.llms[0])
      if (!embedModel && models.embed_models.length > 0) setEmbedModel(models.embed_models[0])
    }
  }, [models, modelName, embedModel])

  // Load registered connections
  useEffect(() => {
    api.getRegisteredConnections().then((reg) => {
      const all = [
        ...reg.a2a.map((c: any) => ({ id: c.id, name: c.name, type: 'a2a' })),
        ...reg.mcp.map((c: any) => ({ id: c.id, name: c.name, type: 'mcp' })),
      ]
      setExtConnections(all)
      if (all.length > 0 && !selectedExtConn) setSelectedExtConn(all[0].id)
    }).catch(console.error)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleRun() {
    if (!query.trim()) return
    try {
      setLoading(true)
      setError(null)
      setResult(null)
      const req: Parameters<typeof api.query>[0] = {
        query: query.trim(),
        retrieval_mode: retrievalMode,
        model_name: modelName,
        embed_model: embedModel,
        top_k: topK,
      }
      if (retrievalMode === 'hybrid') req.alpha = alpha
      if (retrievalMode === 'graph_rag') req.graph_hops = graphHops
      if (useExternalConn && selectedExtConn) {
        const conn = extConnections.find((c) => c.id === selectedExtConn)
        req.external_connection_id = selectedExtConn
        req.external_connection_type = conn?.type ?? 'a2a'
      }
      const res = await api.query(req)
      setResult(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setLoading(false)
    }
  }

  const llmOptions = models?.llms ?? []
  const embedOptions = models?.embed_models ?? []

  return (
    <div className="max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold text-slate-800 dark:text-slate-100 mb-6">Runtime Playground</h1>

      <div className="flex gap-6">
        {/* Left panel */}
        <div className="w-96 flex-shrink-0 space-y-4">
          <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 shadow-sm p-4">
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1">Query</label>
            <textarea
              className="w-full border border-slate-300 dark:border-slate-600 rounded-lg p-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y min-h-32 dark:bg-slate-700 dark:text-slate-100"
              placeholder="Enter your query…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 shadow-sm p-4 space-y-3">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Configuration</h3>

            <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">Retrieval</p>

            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                Retrieval Mode
              </label>
              <select
                className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-slate-700 dark:text-slate-100"
                value={retrievalMode}
                onChange={(e) => setRetrievalMode(e.target.value)}
              >
                {RETRIEVAL_MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>

            <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400 pt-1 border-t border-slate-100 dark:border-slate-700">Models</p>

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">LLM</label>
              <select
                className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
              >
                {llmOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                {llmOptions.length === 0 && <option value="">Loading…</option>}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Embedding Model
              </label>
              <select
                className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={embedModel}
                onChange={(e) => setEmbedModel(e.target.value)}
              >
                {embedOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                {embedOptions.length === 0 && <option value="">Loading…</option>}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Top K ({topK})
              </label>
              <input
                type="number"
                className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={topK}
                min={1}
                max={20}
                onChange={(e) => setTopK(Number(e.target.value))}
              />
            </div>

            {retrievalMode === 'hybrid' && (
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Alpha (vector weight): {alpha.toFixed(1)}
                </label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  className="w-full accent-blue-600"
                  value={alpha}
                  onChange={(e) => setAlpha(Number(e.target.value))}
                />
                <div className="flex justify-between text-xs text-slate-400 mt-0.5">
                  <span>Lexical</span>
                  <span>Vector</span>
                </div>
              </div>
            )}

            {retrievalMode === 'graph_rag' && (
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Graph Hops
                </label>
                <select
                  className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  value={graphHops}
                  onChange={(e) => setGraphHops(Number(e.target.value))}
                >
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                  <option value={3}>3</option>
                </select>
              </div>
            )}

            {/* External connection toggle */}
            <div className="border-t border-slate-100 pt-3">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="accent-blue-600"
                  checked={useExternalConn}
                  onChange={(e) => setUseExternalConn(e.target.checked)}
                />
                <Plug size={13} className="text-slate-500" />
                <span className="text-xs font-medium text-slate-600">Use registered connection</span>
              </label>

              {useExternalConn && (
                <div className="mt-2">
                  {extConnections.length === 0 ? (
                    <p className="text-xs text-slate-400 italic">
                      No connections registered. Add one in the Connections page.
                    </p>
                  ) : (
                    <select
                      className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      value={selectedExtConn}
                      onChange={(e) => setSelectedExtConn(e.target.value)}
                    >
                      {extConnections.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.type.toUpperCase()})
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}
            </div>

            <button
              className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 mt-2"
              onClick={handleRun}
              disabled={loading || !query.trim()}
            >
              {loading && <Spinner size="sm" />}
              {loading ? 'Running…' : 'Run Query'}
            </button>
          </div>
        </div>

        {/* Right panel */}
        <div className="flex-1 min-w-0">
          {error && (
            <div className="mb-4">
              <ErrorAlert message={error} />
            </div>
          )}

          {loading && (
            <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-4 flex items-center justify-center h-64">
              <div className="flex flex-col items-center gap-3">
                <Spinner size="lg" />
                <p className="text-slate-500 text-sm">Running query…</p>
              </div>
            </div>
          )}

          {!loading && result && (
            <div className="space-y-4">
              {/* Answer */}
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-slate-800">
                <h3 className="font-semibold text-blue-900 mb-2 text-sm">Answer</h3>
                <p className="text-sm whitespace-pre-wrap">{result.answer}</p>
              </div>

              {/* Metrics */}
              <div className="flex flex-wrap gap-2">
                <Badge variant="blue">{result.latency_ms?.toFixed(0)}ms</Badge>
                <Badge variant="purple">
                  {(result.prompt_tokens ?? 0) + (result.completion_tokens ?? 0)} tokens
                </Badge>
                <Badge variant="green">${result.estimated_cost_usd?.toFixed(4)}</Badge>
                <Badge variant="gray">{result.retrieval_mode}</Badge>
              </div>

              {/* Stage timings */}
              {result.stage_timings && Object.keys(result.stage_timings).length > 0 && (
                <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-4">
                  <h3 className="text-sm font-semibold text-slate-700 mb-2">Stage Timings</h3>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100">
                        <th className="text-left py-1 text-slate-500 font-medium text-xs">Stage</th>
                        <th className="text-right py-1 text-slate-500 font-medium text-xs">ms</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(result.stage_timings).map(([stage, ms]) => (
                        <tr key={stage} className="border-b border-slate-50">
                          <td className="py-1 text-slate-700">{stage}</td>
                          <td className="py-1 text-right text-slate-600 font-mono">
                            {Number(ms).toFixed(1)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Graph traversal summary — only for graph_rag */}
              {result.retrieval_mode === 'graph_rag' && result.contexts.length > 0 && (() => {
                const meta = result.contexts[0].metadata ?? {}
                const seeds = meta.seed_entities as string[] | undefined
                const nodeCount = meta.traversal_node_count as number | undefined
                const edgeCount = meta.traversal_edge_count as number | undefined
                return (
                  <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
                    <h3 className="text-sm font-semibold text-purple-900 mb-2">Graph Traversal</h3>
                    {seeds && seeds.length > 0 && (
                      <div className="mb-2">
                        <span className="text-xs font-medium text-purple-700 mr-2">Query matched:</span>
                        {seeds.map((e) => (
                          <span key={e} className="text-xs bg-purple-200 text-purple-800 rounded px-1.5 py-0.5 font-medium mr-1">
                            {e}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="flex gap-4 text-xs text-purple-700">
                      {nodeCount !== undefined && <span>{nodeCount} nodes visited</span>}
                      {edgeCount !== undefined && <span>{edgeCount} relations traversed</span>}
                    </div>
                  </div>
                )
              })()}

              {/* External agent note — no local context */}
              {result.contexts && result.contexts.length === 0 && result.retrieval_mode?.startsWith('external') && (
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 text-sm text-slate-500 italic flex items-center gap-2">
                  <Plug size={14} className="text-slate-400 flex-shrink-0" />
                  Answer provided by external agent — no local context retrieved.
                </div>
              )}

              {/* Retrieved contexts */}
              {result.contexts && result.contexts.length > 0 && (
                <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-4">
                  <h3 className="text-sm font-semibold text-slate-700 mb-3">
                    Retrieved Contexts ({result.contexts.length})
                  </h3>
                  <div className="space-y-3">
                    {result.contexts.map((ctx, i) => (
                      <ContextCard key={ctx.chunk_id} ctx={ctx} index={i} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {!loading && !result && !error && (
            <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-8 flex items-center justify-center text-slate-400 text-sm">
              Results will appear here after running a query.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
