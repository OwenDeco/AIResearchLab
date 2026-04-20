import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { Spinner } from '../components/Spinner'
import { ErrorAlert } from '../components/ErrorAlert'
import { Badge } from '../components/Badge'
import type { GraphData, GraphNode, GraphEdge, Document } from '../types'

// Lazy import react-force-graph-2d because it uses browser APIs
const ForceGraph2D = React.lazy(() => import('react-force-graph-2d'))

type Document_ = Document

interface EntityType {
  name: string
  color: string
}

const DEFAULT_ENTITY_TYPES: EntityType[] = [
  { name: 'Person', color: '#3b82f6' },
  { name: 'Organization', color: '#22c55e' },
  { name: 'Technology', color: '#f97316' },
  { name: 'Concept', color: '#a855f7' },
  { name: 'Location', color: '#ef4444' },
  { name: 'Other', color: '#94a3b8' },
]

interface FGNode {
  id: string
  label: string
  type: string
  color: string
  val: number
  doc_ids?: string[]
  chunk_ids?: string[]
}

interface FGLink {
  source: string
  target: string
  predicate: string
  chunk_id: string
}

interface GraphStats {
  node_count: number
  edge_count: number
  top_entities: Array<{ node?: string; label?: string; id?: string; degree: number; type?: string }>
  doc_count: number
}

export function GraphExplorer() {
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], edges: [] })
  const [stats, setStats] = useState<GraphStats | null>(null)
  const [documents, setDocuments] = useState<Document_[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [selectedNode, setSelectedNode] = useState<FGNode | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<FGLink | null>(null)

  // Dynamic entity types
  const [entityTypes, setEntityTypes] = useState<EntityType[]>(DEFAULT_ENTITY_TYPES)
  const [editingTypes, setEditingTypes] = useState<EntityType[]>(DEFAULT_ENTITY_TYPES)
  const [savingTypes, setSavingTypes] = useState(false)
  const [newTypeName, setNewTypeName] = useState('')
  const [newTypeColor, setNewTypeColor] = useState('#6366f1')

  // Predicates config
  type PredicateItem = { name: string; description: string; enabled: boolean }
  const [predicates, setPredicates] = useState<PredicateItem[]>([])
  const [editingPredicates, setEditingPredicates] = useState<PredicateItem[]>([])
  const [savingPredicates, setSavingPredicates] = useState(false)

  // Extraction config
  const [extractionConfig, setExtractionConfig] = useState({ min_confidence: 0.65, preprocess_text: true })
  const [editingConfig, setEditingConfig] = useState({ min_confidence: 0.65, preprocess_text: true })
  const [savingConfig, setSavingConfig] = useState(false)

  // Config panel state
  const [showConfig, setShowConfig] = useState(false)
  const [configTab, setConfigTab] = useState<'types' | 'predicates' | 'extraction'>('types')

  const [filterEntityTypes, setFilterEntityTypes] = useState<Set<string>>(
    new Set(DEFAULT_ENTITY_TYPES.map((t) => t.name))
  )
  const [filterDocId, setFilterDocId] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [searchResult, setSearchResult] = useState<{
    nodes: GraphNode[]
    edges: GraphEdge[]
    chunk_ids: string[]
  } | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const [containerSize, setContainerSize] = useState({ width: 800, height: 600 })

  // Observe container size
  useEffect(() => {
    if (!containerRef.current) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) {
        setContainerSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        })
      }
    })
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    async function load() {
      try {
        setLoading(true)
        const [gd, gs, docs, types, preds, cfg] = await Promise.all([
          api.getGraph(),
          api.getGraphStats(),
          api.getDocuments(),
          api.getEntityTypes(),
          api.getPredicates(),
          api.getExtractionConfig(),
        ])
        setGraphData(gd)
        setStats(gs)
        setDocuments(docs)
        if (types && types.length > 0) {
          setEntityTypes(types)
          setEditingTypes(types)
          setFilterEntityTypes(new Set(types.map((t) => t.name)))
        }
        if (preds && preds.length > 0) {
          setPredicates(preds)
          setEditingPredicates(preds)
        }
        setExtractionConfig(cfg)
        setEditingConfig(cfg)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  // Apply search result overlay
  const activeGraph = searchResult
    ? { nodes: searchResult.nodes, edges: searchResult.edges }
    : graphData

  // Build a name→color map from current entity types
  const typeColorMap = React.useMemo(() => {
    const map: Record<string, string> = {}
    for (const t of entityTypes) {
      map[t.name] = t.color
    }
    return map
  }, [entityTypes])

  const typeNames = React.useMemo(() => entityTypes.map((t) => t.name), [entityTypes])

  // Normalise a node type to one of the known categories (backend may return "entity")
  function resolveType(raw: string): string {
    return typeNames.includes(raw) ? raw : (typeNames.includes('Other') ? 'Other' : typeNames[typeNames.length - 1] ?? raw)
  }

  // Build force-graph data with filters
  const fgData = React.useMemo(() => {
    const filteredNodes = activeGraph.nodes.filter((n) => {
      const t = resolveType(n.type)
      if (!filterEntityTypes.has(t)) return false
      if (filterDocId && !n.doc_ids.includes(filterDocId)) return false
      return true
    })
    const nodeIds = new Set(filteredNodes.map((n) => n.id))
    const filteredEdges = activeGraph.edges.filter(
      (e) => nodeIds.has(e.source) && nodeIds.has(e.target)
    )

    return {
      nodes: filteredNodes.map((n) => {
        const t = resolveType(n.type)
        return {
          id: n.id,
          label: n.label,
          type: t,
          color: typeColorMap[t] ?? '#94a3b8',
          val: 3,
          doc_ids: n.doc_ids,
          chunk_ids: n.chunk_ids,
        }
      }),
      links: filteredEdges.map((e) => ({
        source: e.source,
        target: e.target,
        predicate: e.predicate,
        chunk_id: e.chunk_id,
      })),
    }
  }, [activeGraph, filterEntityTypes, filterDocId, typeColorMap, typeNames])

  function toggleEntityType(type: string) {
    setFilterEntityTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) {
        next.delete(type)
      } else {
        next.add(type)
      }
      return next
    })
  }

  async function handleEntityFocus(label: string) {
    try {
      setSearching(true)
      setSearchQuery(label)
      const res = await api.queryGraph(label)
      setSearchResult(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setSearching(false)
    }
  }

  async function handleSearchGraph() {
    if (!searchQuery.trim()) return
    try {
      setSearching(true)
      const res = await api.queryGraph(searchQuery.trim())
      setSearchResult(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setSearching(false)
    }
  }

  function clearSearch() {
    setSearchResult(null)
    setSearchQuery('')
  }

  function openConfig(tab: 'types' | 'predicates' | 'extraction' = 'types') {
    setEditingTypes([...entityTypes])
    setEditingPredicates([...predicates])
    setEditingConfig({ ...extractionConfig })
    setConfigTab(tab)
    setShowConfig(true)
  }

  function addEditingType() {
    const name = newTypeName.trim()
    if (!name || editingTypes.some((t) => t.name.toLowerCase() === name.toLowerCase())) return
    setEditingTypes((prev) => [...prev, { name, color: newTypeColor }])
    setNewTypeName('')
    setNewTypeColor('#6366f1')
  }

  function removeEditingType(name: string) {
    setEditingTypes((prev) => prev.filter((t) => t.name !== name))
  }

  function updateEditingTypeColor(name: string, color: string) {
    setEditingTypes((prev) => prev.map((t) => (t.name === name ? { ...t, color } : t)))
  }

  async function saveEntityTypes() {
    try {
      setSavingTypes(true)
      await api.updateEntityTypes(editingTypes)
      setEntityTypes(editingTypes)
      setFilterEntityTypes(new Set(editingTypes.map((t) => t.name)))
      setShowConfig(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save entity types')
    } finally {
      setSavingTypes(false)
    }
  }

  async function savePredicates() {
    try {
      setSavingPredicates(true)
      await api.updatePredicates(editingPredicates)
      setPredicates(editingPredicates)
      setShowConfig(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save predicates')
    } finally {
      setSavingPredicates(false)
    }
  }

  async function saveExtractionConfig() {
    try {
      setSavingConfig(true)
      await api.updateExtractionConfig(editingConfig)
      setExtractionConfig(editingConfig)
      setShowConfig(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save extraction config')
    } finally {
      setSavingConfig(false)
    }
  }

  async function handleClearGraph() {
    if (!confirm('Delete all graph data? You will need to re-ingest documents to rebuild it.')) return
    try {
      setClearing(true)
      await api.clearGraph()
      setGraphData({ nodes: [], edges: [] })
      setStats(null)
      setSearchResult(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setClearing(false)
    }
  }

  const handleNodeClick = useCallback((node: object) => {
    setSelectedNode(node as FGNode)
    setSelectedEdge(null)
  }, [])

  const handleLinkClick = useCallback((link: object) => {
    setSelectedEdge(link as FGLink)
    setSelectedNode(null)
  }, [])

  const isEmpty = graphData.nodes.length === 0 && !loading

  return (
    <div className="max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold text-slate-800 mb-6">Graph Explorer</h1>

      {error && (
        <div className="mb-4">
          <ErrorAlert message={error} />
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <Spinner size="lg" />
        </div>
      ) : isEmpty ? (
        <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-8 text-center">
          <p className="text-slate-500">
            No graph data. Ingest documents with "Extract Graph" enabled.
          </p>
        </div>
      ) : (
        <div className="flex gap-4">
          {/* Left: graph + filter bar (70%) */}
          <div className="flex-1 min-w-0">
            {/* Filter bar */}
            <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-3 mb-3 flex flex-wrap gap-3 items-center">
              {/* Entity type checkboxes */}
              <div className="flex flex-wrap gap-2">
                {entityTypes.map(({ name, color }) => (
                  <label key={name} className="flex items-center gap-1 cursor-pointer text-sm">
                    <input
                      type="checkbox"
                      className="accent-blue-600"
                      checked={filterEntityTypes.has(name)}
                      onChange={() => toggleEntityType(name)}
                    />
                    <span className="text-xs font-medium" style={{ color }}>
                      {name}
                    </span>
                  </label>
                ))}
              </div>

              {/* Document filter */}
              <select
                className="border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={filterDocId}
                onChange={(e) => setFilterDocId(e.target.value)}
              >
                <option value="">All Documents</option>
                {documents.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.filename}
                  </option>
                ))}
              </select>

              {/* Search */}
              <div className="flex gap-2 items-center ml-auto">
                <input
                  type="text"
                  className="border border-slate-300 rounded px-2 py-1 text-sm w-40 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Search graph…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearchGraph()}
                />
                <button
                  className="bg-blue-600 hover:bg-blue-700 text-white rounded px-3 py-1 text-sm disabled:opacity-50 flex items-center gap-1"
                  onClick={handleSearchGraph}
                  disabled={searching || !searchQuery.trim()}
                >
                  {searching && <Spinner size="sm" />}
                  Search
                </button>
                {searchResult && (
                  <button
                    className="text-sm text-slate-500 hover:text-slate-700"
                    onClick={clearSearch}
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {/* Graph canvas */}
            <div
              ref={containerRef}
              className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden"
              style={{ height: 600 }}
            >
              <React.Suspense
                fallback={
                  <div className="flex items-center justify-center h-full">
                    <Spinner size="lg" />
                  </div>
                }
              >
                <ForceGraph2D
                  graphData={fgData}
                  width={containerSize.width || 800}
                  height={600}
                  nodeLabel="label"
                  nodeColor="color"
                  nodeVal="val"
                  linkLabel="predicate"
                  onNodeClick={handleNodeClick}
                  onLinkClick={handleLinkClick}
                />
              </React.Suspense>
            </div>

            {searchResult && (
              <p className="text-xs text-slate-500 mt-1">
                Showing {searchResult.nodes.length} nodes and {searchResult.edges.length} edges
                from search. {searchResult.chunk_ids.length} chunks referenced.
              </p>
            )}
          </div>

          {/* Right panel (30%) */}
          <div className="w-72 flex-shrink-0 space-y-4">
            {/* Clear graph */}
            <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-4">
              <h3 className="text-sm font-semibold text-slate-700 mb-2">Actions</h3>
              <button
                className="w-full bg-red-600 hover:bg-red-700 text-white rounded px-3 py-1.5 text-sm disabled:opacity-50 flex items-center justify-center gap-1"
                onClick={handleClearGraph}
                disabled={clearing}
              >
                {clearing && <Spinner size="sm" />}
                Clear Graph Data
              </button>
              <p className="text-xs text-slate-400 mt-1">Re-ingest documents to rebuild with LLM extraction.</p>
            </div>

            {/* Stats */}
            {stats && (
              <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-4">
                <h3 className="text-sm font-semibold text-slate-700 mb-3">Graph Statistics</h3>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Nodes</span>
                    <span className="text-slate-800 font-medium">{stats.node_count}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Edges</span>
                    <span className="text-slate-800 font-medium">{stats.edge_count}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Documents</span>
                    <span className="text-slate-800 font-medium">{stats.doc_count}</span>
                  </div>
                </div>
                {stats.top_entities && stats.top_entities.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-medium text-slate-600 mb-1">Top Entities</p>
                    <div className="space-y-1">
                      {stats.top_entities.slice(0, 5).map((e, i) => (
                        <div key={i} className="flex justify-between text-xs items-center">
                          <button
                            className="text-blue-600 hover:underline truncate max-w-32 text-left"
                            onClick={() => handleEntityFocus(e.label ?? e.node ?? e.id ?? '')}
                            title="Focus graph on this entity"
                          >
                            {e.label ?? e.node ?? e.id}
                          </button>
                          <Badge variant="blue">{e.degree}</Badge>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Node type legend */}
            <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-slate-700">Node Types</h3>
                <button
                  className="text-xs text-blue-600 hover:underline"
                  onClick={() => openConfig('types')}
                >
                  Graph Config
                </button>
              </div>
              <div className="space-y-1">
                {entityTypes.map(({ name, color }) => (
                  <div key={name} className="flex items-center gap-2 text-xs">
                    <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
                    <span className="text-slate-600">{name}</span>
                  </div>
                ))}
              </div>
              {predicates.length > 0 && (
                <div className="mt-3 pt-3 border-t border-slate-100">
                  <p className="text-xs font-medium text-slate-500 mb-1">Active predicates</p>
                  <div className="flex flex-wrap gap-1">
                    {predicates.filter(p => p.enabled).map(p => (
                      <span key={p.name} className="text-xs bg-slate-100 text-slate-600 rounded px-1.5 py-0.5 font-mono">
                        {p.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Graph config panel (tabbed) */}
            {showConfig && (
              <div className="bg-white rounded-lg border border-blue-300 shadow-sm p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-slate-700">Graph Config</h3>
                  <button className="text-xs text-slate-400 hover:text-slate-600" onClick={() => setShowConfig(false)}>✕</button>
                </div>

                {/* Tab bar */}
                <div className="flex border-b border-slate-200 mb-3 -mx-4 px-4">
                  {(['types', 'predicates', 'extraction'] as const).map((tab) => (
                    <button
                      key={tab}
                      className={`text-xs px-3 py-1.5 font-medium border-b-2 transition-colors ${
                        configTab === tab
                          ? 'border-blue-600 text-blue-600'
                          : 'border-transparent text-slate-500 hover:text-slate-700'
                      }`}
                      onClick={() => setConfigTab(tab)}
                    >
                      {tab === 'types' ? 'Entity Types' : tab === 'predicates' ? 'Predicates' : 'Extraction'}
                    </button>
                  ))}
                </div>

                {/* Entity Types tab */}
                {configTab === 'types' && (
                  <>
                    <div className="space-y-2 mb-3">
                      {editingTypes.map(({ name, color }) => (
                        <div key={name} className="flex items-center gap-2">
                          <input
                            type="color"
                            value={color}
                            onChange={(e) => updateEditingTypeColor(name, e.target.value)}
                            className="w-6 h-6 rounded cursor-pointer border-0 p-0"
                            title="Pick color"
                          />
                          <span className="text-xs text-slate-700 flex-1">{name}</span>
                          <button
                            className="text-xs text-red-400 hover:text-red-600"
                            onClick={() => removeEditingType(name)}
                            title="Remove"
                          >✕</button>
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-1 mb-3">
                      <input
                        type="color"
                        value={newTypeColor}
                        onChange={(e) => setNewTypeColor(e.target.value)}
                        className="w-7 h-7 rounded cursor-pointer border border-slate-300 p-0"
                        title="New type color"
                      />
                      <input
                        type="text"
                        className="border border-slate-300 rounded px-2 py-1 text-xs flex-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        placeholder="New type name…"
                        value={newTypeName}
                        onChange={(e) => setNewTypeName(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && addEditingType()}
                      />
                      <button
                        className="bg-slate-100 hover:bg-slate-200 text-slate-700 rounded px-2 py-1 text-xs"
                        onClick={addEditingType}
                      >Add</button>
                    </div>
                    <button
                      className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded px-3 py-1.5 text-sm disabled:opacity-50 flex items-center justify-center gap-1"
                      onClick={saveEntityTypes}
                      disabled={savingTypes || editingTypes.length === 0}
                    >
                      {savingTypes && <Spinner size="sm" />}
                      Save
                    </button>
                  </>
                )}

                {/* Predicates tab */}
                {configTab === 'predicates' && (
                  <>
                    <p className="text-xs text-slate-500 mb-2">
                      Only enabled predicates are used during extraction. Disable noisy relations to reduce graph noise.
                    </p>
                    <div className="space-y-1.5 mb-3 max-h-56 overflow-y-auto pr-1">
                      {editingPredicates.map((p) => (
                        <label key={p.name} className="flex items-start gap-2 cursor-pointer group">
                          <input
                            type="checkbox"
                            className="mt-0.5 accent-blue-600 flex-shrink-0"
                            checked={p.enabled}
                            onChange={(e) =>
                              setEditingPredicates((prev) =>
                                prev.map((x) => x.name === p.name ? { ...x, enabled: e.target.checked } : x)
                              )
                            }
                          />
                          <div className="min-w-0">
                            <span className="text-xs font-mono text-slate-800">{p.name}</span>
                            {p.description && (
                              <p className="text-xs text-slate-400 leading-tight">{p.description}</p>
                            )}
                          </div>
                        </label>
                      ))}
                    </div>
                    <div className="flex gap-2 mb-2">
                      <button
                        className="text-xs text-blue-600 hover:underline"
                        onClick={() => setEditingPredicates((prev) => prev.map((p) => ({ ...p, enabled: true })))}
                      >Enable all</button>
                      <span className="text-slate-300">|</span>
                      <button
                        className="text-xs text-slate-500 hover:underline"
                        onClick={() => setEditingPredicates((prev) => prev.map((p) => ({ ...p, enabled: false })))}
                      >Disable all</button>
                    </div>
                    <button
                      className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded px-3 py-1.5 text-sm disabled:opacity-50 flex items-center justify-center gap-1"
                      onClick={savePredicates}
                      disabled={savingPredicates}
                    >
                      {savingPredicates && <Spinner size="sm" />}
                      Save
                    </button>
                  </>
                )}

                {/* Extraction tab */}
                {configTab === 'extraction' && (
                  <>
                    <div className="space-y-4 mb-3">
                      <div>
                        <div className="flex justify-between items-center mb-1">
                          <label className="text-xs font-medium text-slate-700">Min Confidence</label>
                          <span className="text-xs font-mono text-slate-600">{editingConfig.min_confidence.toFixed(2)}</span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={editingConfig.min_confidence}
                          onChange={(e) => setEditingConfig((c) => ({ ...c, min_confidence: parseFloat(e.target.value) }))}
                          className="w-full accent-blue-600"
                        />
                        <p className="text-xs text-slate-400 mt-0.5">Triples with confidence below this are discarded. Default: 0.65</p>
                      </div>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          className="accent-blue-600"
                          checked={editingConfig.preprocess_text}
                          onChange={(e) => setEditingConfig((c) => ({ ...c, preprocess_text: e.target.checked }))}
                        />
                        <div>
                          <span className="text-xs font-medium text-slate-700">Preprocess text</span>
                          <p className="text-xs text-slate-400">Strip HTML tags, normalize whitespace and quotes before extraction.</p>
                        </div>
                      </label>
                    </div>
                    <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-3">
                      Changes take effect on the next extraction run. Existing graph data is not affected.
                    </p>
                    <button
                      className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded px-3 py-1.5 text-sm disabled:opacity-50 flex items-center justify-center gap-1"
                      onClick={saveExtractionConfig}
                      disabled={savingConfig}
                    >
                      {savingConfig && <Spinner size="sm" />}
                      Save
                    </button>
                  </>
                )}
              </div>
            )}

            {/* Selected node */}
            {selectedNode && (
              <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-4">
                <h3 className="text-sm font-semibold text-slate-700 mb-2">Selected Node</h3>
                <div className="space-y-1 text-sm">
                  <div>
                    <span className="text-slate-500 text-xs">Label</span>
                    <p className="text-slate-800 font-medium">{selectedNode.label}</p>
                  </div>
                  <div>
                    <span className="text-slate-500 text-xs">Type</span>
                    <p className="flex items-center gap-1 mt-0.5">
                      <span
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                        style={{ backgroundColor: typeColorMap[selectedNode.type] ?? '#94a3b8' }}
                      />
                      <span className="text-xs text-slate-700">{selectedNode.type}</span>
                    </p>
                  </div>
                  {selectedNode.chunk_ids && (
                    <div>
                      <span className="text-slate-500 text-xs">Chunks</span>
                      <p className="text-slate-800">{selectedNode.chunk_ids.length}</p>
                    </div>
                  )}
                  {selectedNode.doc_ids && selectedNode.doc_ids.length > 0 && (
                    <div>
                      <span className="text-slate-500 text-xs">Documents</span>
                      <div className="space-y-0.5 mt-0.5">
                        {selectedNode.doc_ids.map((id) => {
                          const doc = documents.find((d) => d.id === id)
                          return (
                            <p key={id} className="text-xs text-slate-600 font-mono truncate">
                              {doc ? doc.filename : id.slice(0, 16) + '…'}
                            </p>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Selected edge */}
            {selectedEdge && (
              <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-4">
                <h3 className="text-sm font-semibold text-slate-700 mb-2">Selected Edge</h3>
                <div className="text-sm space-y-1">
                  <p className="text-slate-800">
                    <span className="font-medium">
                      {typeof selectedEdge.source === 'object'
                        ? (selectedEdge.source as FGNode).label
                        : selectedEdge.source}
                    </span>
                    {' → '}
                    <span className="text-blue-600 italic">{selectedEdge.predicate}</span>
                    {' → '}
                    <span className="font-medium">
                      {typeof selectedEdge.target === 'object'
                        ? (selectedEdge.target as FGNode).label
                        : selectedEdge.target}
                    </span>
                  </p>
                  <div>
                    <span className="text-slate-500 text-xs">Chunk ID</span>
                    <p className="text-xs font-mono text-slate-600 truncate">
                      {selectedEdge.chunk_id}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
