import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, RotateCcw, X, Bot, Server, Plug, Cpu } from 'lucide-react'
import { api } from '../api/client'

// ---------------------------------------------------------------------------
// Layout persistence helpers
// ---------------------------------------------------------------------------

const LAYOUT_KEY = 'flow-layout-positions'

function loadSavedPositions(): Record<string, { x: number; y: number }> {
  try { return JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}') }
  catch { return {} }
}

function saveNodePosition(nodeId: string, x: number, y: number) {
  const positions = loadSavedPositions()
  positions[nodeId] = { x, y }
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(positions))
}

function clearSavedPositions() {
  localStorage.removeItem(LAYOUT_KEY)
}

const ForceGraph2D = React.lazy(() => import('react-force-graph-2d'))

// ── Types ──────────────────────────────────────────────────────────────────

type NodeKind = 'agent' | 'mcp' | 'a2a'

interface FlowNode {
  id: string
  kind: NodeKind
  label: string
  sublabel: string
  color: string
  val: number
  data: Record<string, unknown>
  // force-graph sets these at runtime
  x?: number
  y?: number
}

interface FlowLink {
  source: string
  target: string
  linkKind: 'mcp' | 'a2a' | 'agent'
}

// ── Constants ───────────────────────────────────────────────────────────────

const KIND_COLOR: Record<NodeKind, string> = {
  agent: '#6366f1',
  mcp:   '#f59e0b',
  a2a:   '#a855f7',
}

const KIND_LETTER: Record<NodeKind, string> = {
  agent: 'A',
  mcp:   'M',
  a2a:   'C',
}

// ── Panel component ─────────────────────────────────────────────────────────

function NodePanel({ node, onClose }: { node: FlowNode; onClose: () => void }) {
  const Icon = node.kind === 'agent' ? Bot : node.kind === 'mcp' ? Server : Plug
  const color = KIND_COLOR[node.kind]

  const fields: [string, unknown][] = Object.entries(node.data).filter(
    ([k]) => !['id', 'created_at', 'updated_at', 'tool_schemas', 'skills'].includes(k)
  )

  return (
    <div className="w-72 flex-shrink-0 bg-slate-900 border-l border-slate-700 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-700">
        <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: color }}>
          <Icon size={14} className="text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-slate-100 truncate">{node.label}</p>
          <p className="text-xs text-slate-400 capitalize">{node.kind} · {node.sublabel}</p>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-300 flex-shrink-0">
          <X size={14} />
        </button>
      </div>

      {/* Fields */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-xs">
        {fields.map(([key, value]) => {
          if (value === null || value === undefined || value === '') return null
          const display = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
          const isLong = display.length > 80
          return (
            <div key={key}>
              <p className="text-slate-500 uppercase tracking-wider font-semibold mb-0.5">
                {key.replace(/_/g, ' ')}
              </p>
              {isLong ? (
                <pre className="text-slate-300 whitespace-pre-wrap break-words font-mono leading-relaxed text-[11px] bg-slate-800 rounded p-2">
                  {display}
                </pre>
              ) : (
                <p className="text-slate-300 leading-relaxed">{display}</p>
              )}
            </div>
          )
        })}
        {fields.length === 0 && (
          <p className="text-slate-500">No additional details.</p>
        )}
      </div>
    </div>
  )
}

// ── Legend ──────────────────────────────────────────────────────────────────

function Legend({ counts }: { counts: Record<NodeKind, number> }) {
  const items: [NodeKind, string, React.ElementType][] = [
    ['agent', 'Agent', Bot],
    ['mcp',   'MCP Server', Server],
    ['a2a',   'A2A Connection', Plug],
  ]
  return (
    <div className="absolute top-3 left-3 z-10 bg-slate-900/80 backdrop-blur border border-slate-700 rounded-lg px-3 py-2 flex flex-col gap-1.5">
      {items.map(([kind, label, Icon]) => (
        <div key={kind} className="flex items-center gap-2 text-xs">
          <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: KIND_COLOR[kind] }} />
          <Icon size={11} className="text-slate-400" />
          <span className="text-slate-300">{label}</span>
          <span className="text-slate-500 ml-auto pl-3">{counts[kind]}</span>
        </div>
      ))}
      <div className="border-t border-slate-700 mt-0.5 pt-1.5 flex flex-col gap-1">
        {([['#22c55e', 'Agent → Agent'], ['#f59e0b', 'Agent → MCP'], ['#a855f7', 'Agent → A2A']] as [string, string][]).map(([color, label]) => (
          <div key={label} className="flex items-center gap-2 text-xs">
            <div className="w-5 h-0.5 flex-shrink-0 rounded" style={{ background: color }} />
            <span className="text-slate-400">{label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Stats bar ───────────────────────────────────────────────────────────────

function StatsBar({
  nodeCount, linkCount, onRefresh, refreshing, onResetLayout,
}: {
  nodeCount: number; linkCount: number; onRefresh: () => void; refreshing: boolean; onResetLayout: () => void
}) {
  return (
    <div className="absolute top-3 right-3 z-10 flex items-center gap-2">
      {/* Reset layout — standalone pill button so it can't be missed */}
      <button
        onClick={onResetLayout}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-200 transition-colors"
        title="Reset node positions to auto-layout"
      >
        <RotateCcw size={11} />
        Reset layout
      </button>

      {/* Stats + refresh */}
      <div className="flex items-center gap-2 bg-slate-900/80 backdrop-blur border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-400">
        <span>{nodeCount} nodes</span>
        <span className="text-slate-600">·</span>
        <span>{linkCount} link{linkCount !== 1 ? 's' : ''}</span>
        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="ml-1 text-slate-400 hover:text-slate-200 disabled:opacity-40"
          title="Refresh data"
        >
          <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>
    </div>
  )
}

// ── Main page ───────────────────────────────────────────────────────────────

export function Flow() {
  const [agents, setAgents] = useState<any[]>([])
  const [connections, setConnections] = useState<{ mcp: any[]; a2a: any[] }>({ mcp: [], a2a: [] })
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selected, setSelected] = useState<FlowNode | null>(null)
  const [dims, setDims] = useState({ w: 800, h: 600 })
  const [resetKey, setResetKey] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const fgRef = useRef<any>(null)

  async function load(quiet = false) {
    if (!quiet) setLoading(true)
    else setRefreshing(true)
    try {
      const [agentsData, connsData] = await Promise.all([
        api.listAgentConfigs(),
        api.getRegisteredConnections(),
      ])
      setAgents(agentsData)
      setConnections(connsData)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => { load() }, [])

  // Track container size
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    // Capture current size immediately so the graph doesn't start with the 800×600 default
    const rect = el.getBoundingClientRect()
    setDims({ w: rect.width, h: rect.height })
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        setDims({ w: entry.contentRect.width, h: entry.contentRect.height })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [loading, selected]) // recalculate when panel opens/closes or canvas first mounts

  function handleResetLayout() {
    clearSavedPositions()
    setResetKey(k => k + 1)
    setTimeout(() => fgRef.current?.d3ReheatSimulation(), 80)
  }

  // Build graph data
  const graphData = useMemo(() => {
    const positions = loadSavedPositions()  // resetKey in deps ensures this re-reads after clear
    const nodes: FlowNode[] = []
    const links: FlowLink[] = []

    for (const a of agents) {
      nodes.push({
        id: 'agent:' + a.id,
        kind: 'agent',
        label: a.name,
        sublabel: a.role || 'agent',
        color: KIND_COLOR.agent,
        val: 5,
        data: {
          role: a.role,
          system_prompt: a.system_prompt,
          rag_enabled: a.rag?.enabled,
          ...(a.rag?.enabled ? {
            retrieval_mode: a.rag?.retrieval_mode,
            model: a.rag?.model_name,
          } : {}),
        },
      })
    }

    for (const m of connections.mcp) {
      nodes.push({
        id: 'mcp:' + m.id,
        kind: 'mcp',
        label: m.name,
        sublabel: m.transport || 'sse',
        color: KIND_COLOR.mcp,
        val: 3,
        data: {
          server_url: m.server_url,
          transport: m.transport,
          tool_count: m.tool_schemas?.length ?? 0,
          tools: m.tool_schemas?.length
            ? m.tool_schemas.map((t: any) => `${t.name}${t.description ? ' — ' + t.description : ''}`).join('\n')
            : undefined,
        },
      })
    }

    for (const a of connections.a2a) {
      nodes.push({
        id: 'a2a:' + a.id,
        kind: 'a2a',
        label: a.name,
        sublabel: a.task_url || '',
        color: KIND_COLOR.a2a,
        val: 3,
        data: {
          task_url: a.task_url,
          version: a.version,
          description: a.description,
        },
      })
    }

    for (const agent of agents) {
      const src = 'agent:' + agent.id
      for (const mcpId of agent.tools?.mcp_connection_ids ?? []) {
        if (nodes.find(n => n.id === 'mcp:' + mcpId)) {
          links.push({ source: src, target: 'mcp:' + mcpId, linkKind: 'mcp' })
        }
      }
      for (const a2aId of agent.tools?.a2a_connection_ids ?? []) {
        if (nodes.find(n => n.id === 'a2a:' + a2aId)) {
          links.push({ source: src, target: 'a2a:' + a2aId, linkKind: 'a2a' })
        }
      }
      for (const agentId of agent.tools?.agent_ids ?? []) {
        if (nodes.find(n => n.id === 'agent:' + agentId)) {
          links.push({ source: src, target: 'agent:' + agentId, linkKind: 'agent' })
        }
      }
    }

    // Apply positions: saved nodes are pinned; unsaved nodes get evenly-spaced
    // starting positions in a circle so they never pile up at the origin.
    const total = nodes.length
    nodes.forEach((node, i) => {
      const saved = positions[node.id]
      if (saved) {
        node.x = saved.x
        node.y = saved.y
        ;(node as any).fx = saved.x
        ;(node as any).fy = saved.y
      } else {
        const angle = (i / Math.max(total, 1)) * 2 * Math.PI
        const radius = 180 + total * 12   // grow radius with node count
        node.x = radius * Math.cos(angle)
        node.y = radius * Math.sin(angle)
      }
    })

    return { nodes, links }
  }, [agents, connections, resetKey])

  // Increase link distance so edges are longer
  useEffect(() => {
    const fg = fgRef.current
    if (!fg) return
    fg.d3Force('link')?.distance(60)
    fg.d3ReheatSimulation()
  }, [graphData])

  const counts: Record<NodeKind, number> = {
    agent: agents.length,
    mcp:   connections.mcp.length,
    a2a:   connections.a2a.length,
  }

  // Custom node canvas drawing — card style
  const drawNode = useCallback((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const isSelected = selected?.id === node.id
    const s = 1 / globalScale

    const W = 130 * s
    const H = 30 * s
    const R = 6 * s
    const x = node.x - W / 2
    const y = node.y - H / 2

    // Glow on selected
    if (isSelected) {
      ctx.shadowColor = node.color
      ctx.shadowBlur = 14
    }

    // Card background
    ctx.beginPath()
    ctx.roundRect(x, y, W, H, R)
    ctx.fillStyle = '#0f172a'
    ctx.fill()

    // Left accent bar
    ctx.beginPath()
    ctx.roundRect(x, y, 4 * s, H, [R, 0, 0, R])
    ctx.fillStyle = node.color
    ctx.fill()

    // Border
    ctx.beginPath()
    ctx.roundRect(x, y, W, H, R)
    ctx.strokeStyle = isSelected ? node.color : '#334155'
    ctx.lineWidth = (isSelected ? 1.5 : 0.8) * s
    ctx.stroke()

    ctx.shadowBlur = 0

    // Badge circle
    const bx = x + 18 * s
    const by = node.y
    const br = 9 * s
    ctx.beginPath()
    ctx.arc(bx, by, br, 0, 2 * Math.PI)
    ctx.fillStyle = node.color + 'cc'
    ctx.fill()

    // Badge letter
    ctx.font = `bold ${10 * s}px sans-serif`
    ctx.fillStyle = '#ffffff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(KIND_LETTER[node.kind as NodeKind] ?? '?', bx, by)

    // Label
    const labelX = x + 32 * s
    const maxLabelW = W - 36 * s
    ctx.font = `${10 * s}px sans-serif`
    ctx.fillStyle = isSelected ? '#f1f5f9' : '#cbd5e1'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(node.label, labelX, node.y, maxLabelW)
  }, [selected])

  const panelWidth = selected ? 288 : 0
  const graphWidth = dims.w - panelWidth

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96 text-slate-400">
        Loading flow…
      </div>
    )
  }

  return (
    // negative margins to break out of the page padding and go full-bleed
    <div className="flex -mx-6 -my-6" style={{ height: 'calc(100vh - 0px)' }}>
      {/* Canvas area */}
      <div ref={containerRef} className="flex-1 relative overflow-hidden bg-slate-950">
        <Legend counts={counts} />
        <StatsBar
          nodeCount={graphData.nodes.length}
          linkCount={graphData.links.length}
          onRefresh={() => load(true)}
          refreshing={refreshing}
          onResetLayout={handleResetLayout}
        />

        <React.Suspense fallback={
          <div className="flex items-center justify-center h-full text-slate-500">Loading graph…</div>
        }>
          <ForceGraph2D
            ref={fgRef}
            graphData={graphData}
            width={graphWidth}
            height={dims.h}
            backgroundColor="#020617"
            nodeCanvasObject={drawNode}
            nodeCanvasObjectMode={() => 'replace'}
            nodePointerAreaPaint={(node: any, color, ctx, globalScale) => {
              const s = 1 / globalScale
              const W = 130 * s, H = 30 * s
              ctx.fillStyle = color
              ctx.fillRect(node.x - W / 2, node.y - H / 2, W, H)
            }}
            onNodeClick={(node: any) => setSelected(prev => prev?.id === node.id ? null : node)}
            onNodeDragEnd={(node: any) => {
              node.fx = node.x
              node.fy = node.y
              saveNodePosition(node.id, node.x, node.y)
            }}
            linkColor={(link: any) => link.linkKind === 'mcp' ? '#f59e0b80' : link.linkKind === 'agent' ? '#22c55e80' : '#a855f780'}
            linkWidth={1.5}
            linkDirectionalArrowLength={5}
            linkDirectionalArrowRelPos={1}
            linkCurvature={0.1}
            cooldownTicks={120}
            nodeLabel={(node: any) => `${node.label} (${node.kind})`}
          />
        </React.Suspense>

        {graphData.nodes.length === 0 && !loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-500 pointer-events-none">
            <Cpu size={40} className="mb-3 opacity-30" />
            <p className="text-sm">No agents or connections yet.</p>
            <p className="text-xs mt-1 opacity-60">Create agents and register connections to see the flow.</p>
          </div>
        )}
      </div>

      {/* Side panel */}
      {selected && (
        <NodePanel node={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  )
}
