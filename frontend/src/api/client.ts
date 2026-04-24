import axios from 'axios'
import type {
  ModelsInfo,
  Document,
  Chunk,
  QueryResponse,
  Run,
  GraphData,
  GraphNode,
  GraphEdge,
  BenchmarkRun,
  BenchmarkResult,
  BenchmarkQuestion,
  BenchmarkConfig,
} from '../types'

// The types file exports Document but the backend/usage uses Document_ as alias
// to avoid collision with the global DOM Document type.
export type Document_ = Document

const http = axios.create({ baseURL: '/api' })

export const api = {
  async getModels(): Promise<ModelsInfo> {
    const res = await http.get<ModelsInfo>('/models')
    return res.data
  },

  async ingestDocument(
    file: File,
    opts: {
      chunk_strategy: string
      chunk_size: number
      chunk_overlap: number
      embed_model: string
      extract_graph: boolean
      percentile_threshold?: number
      max_chunk_tokens?: number
    }
  ): Promise<Document_> {
    const form = new FormData()
    form.append('file', file)
    form.append('chunk_strategy', opts.chunk_strategy)
    form.append('chunk_size', String(opts.chunk_size))
    form.append('chunk_overlap', String(opts.chunk_overlap))
    form.append('embed_model', opts.embed_model)
    form.append('extract_graph', String(opts.extract_graph))
    if (opts.percentile_threshold !== undefined)
      form.append('percentile_threshold', String(opts.percentile_threshold))
    if (opts.max_chunk_tokens !== undefined)
      form.append('max_chunk_tokens', String(opts.max_chunk_tokens))
    const res = await http.post<Document_>('/documents/ingest', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    return res.data
  },

  async getDocuments(): Promise<Document_[]> {
    const res = await http.get<Document_[]>('/documents')
    return res.data
  },

  async getChunks(docId: string, page = 1, pageSize = 20): Promise<Chunk[]> {
    const res = await http.get<Chunk[]>(`/documents/${docId}/chunks`, {
      params: { page, page_size: pageSize },
    })
    return res.data
  },

  async deleteDocument(docId: string): Promise<void> {
    await http.delete(`/documents/${docId}`)
  },

  async query(req: {
    query: string
    retrieval_mode: string
    model_name: string
    embed_model: string
    top_k: number
    alpha?: number
    graph_hops?: number
    external_connection_id?: string
    external_connection_type?: string
  }): Promise<QueryResponse> {
    const res = await http.post<QueryResponse>('/query', req)
    return res.data
  },

  async getRuns(limit = 50): Promise<Run[]> {
    const res = await http.get<Run[]>('/runs', { params: { limit } })
    return res.data
  },

  async getRun(id: string): Promise<Run> {
    const res = await http.get<Run>(`/runs/${id}`)
    return res.data
  },

  async getGraph(filters?: { doc_id?: string; entity_type?: string }): Promise<GraphData> {
    const params: Record<string, string> = {}
    if (filters?.doc_id) params.doc_id = filters.doc_id
    if (filters?.entity_type) params.entity_type = filters.entity_type
    const res = await http.get<GraphData>('/graph', { params })
    return res.data
  },

  async getGraphStats(): Promise<{
    node_count: number
    edge_count: number
    top_entities: Array<{ node: string; degree: number }>
    doc_count: number
  }> {
    const res = await http.get('/graph/stats')
    return res.data
  },

  async queryGraph(
    query: string,
    hops = 2
  ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; chunk_ids: string[] }> {
    const res = await http.post('/graph/query', { query, hops })
    return res.data
  },

  async clearGraph(): Promise<void> {
    await http.delete('/graph')
  },

  async getEntityTypes(): Promise<{ name: string; color: string }[]> {
    const res = await http.get('/graph/entity-types')
    return res.data
  },

  async updateEntityTypes(types: { name: string; color: string }[]): Promise<void> {
    await http.put('/graph/entity-types', { types })
  },

  async getPredicates(): Promise<{ name: string; description: string; enabled: boolean }[]> {
    const res = await http.get('/graph/predicates')
    return res.data
  },

  async updatePredicates(predicates: { name: string; description: string; enabled: boolean }[]): Promise<void> {
    await http.put('/graph/predicates', { predicates })
  },

  async getExtractionConfig(): Promise<{ min_confidence: number; preprocess_text: boolean }> {
    const res = await http.get('/graph/extraction-config')
    return res.data
  },

  async updateExtractionConfig(config: { min_confidence: number; preprocess_text: boolean }): Promise<void> {
    await http.put('/graph/extraction-config', config)
  },

  async createBenchmarkRun(req: {
    name: string
    question_set: BenchmarkQuestion[]
    configs: BenchmarkConfig[]
  }): Promise<BenchmarkRun> {
    const res = await http.post<BenchmarkRun>('/benchmarks', req)
    return res.data
  },

  async getBenchmarkRuns(): Promise<BenchmarkRun[]> {
    const res = await http.get<BenchmarkRun[]>('/benchmarks')
    return res.data
  },

  async getBenchmarkRun(id: string): Promise<BenchmarkRun> {
    const res = await http.get<BenchmarkRun>(`/benchmarks/${id}`)
    return res.data
  },

  async getBenchmarkResults(id: string): Promise<BenchmarkResult[]> {
    const res = await http.get<BenchmarkResult[]>(`/benchmarks/${id}/results`)
    return res.data
  },

  async getDefaultQuestionSet(): Promise<BenchmarkQuestion[]> {
    const res = await http.get<BenchmarkQuestion[]>('/benchmarks/question-sets/default')
    return res.data
  },

  async generateQuestionSet(n: number = 10, docId?: string): Promise<BenchmarkQuestion[]> {
    const params: Record<string, string | number> = { n }
    if (docId) params.doc_id = docId
    const res = await http.post<BenchmarkQuestion[]>('/benchmarks/question-sets/generate', null, { params })
    return res.data
  },

  async getBenchmarkSession(): Promise<{ question_set: BenchmarkQuestion[]; configs: BenchmarkConfig[] }> {
    const res = await http.get<{ question_set: BenchmarkQuestion[]; configs: BenchmarkConfig[] }>('/benchmarks/session')
    return res.data
  },

  async saveBenchmarkSession(questionSet: BenchmarkQuestion[], configs: BenchmarkConfig[]): Promise<void> {
    await http.post('/benchmarks/session', { question_set: questionSet, configs })
  },

  async getCustomModels(): Promise<{ llms: string[]; embed_models: string[] }> {
    const res = await http.get('/models/custom')
    return res.data
  },

  async getModelSuggestions(): Promise<Record<string, { configured: boolean; llms: string[]; embed_models: string[]; note?: string }>> {
    const res = await http.get('/models/suggestions')
    return res.data
  },

  async updateCustomModels(data: { llms: string[]; embed_models: string[] }): Promise<void> {
    await http.put('/models/custom', data)
  },

  async getProviderSettings(): Promise<{
    openai_api_key: string
    azure_api_key: string
    azure_endpoint: string
    azure_deployment: string
    ollama_base_url: string
  }> {
    const res = await http.get('/settings')
    return res.data
  },

  async updateProviderSettings(data: {
    openai_api_key: string
    azure_api_key: string
    azure_endpoint: string
    azure_deployment: string
    ollama_base_url: string
  }): Promise<void> {
    await http.put('/settings', data)
  },

  async getProviderNotes(): Promise<{ openai: string; azure: string; ollama: string }> {
    const res = await http.get('/settings/provider-notes')
    return res.data
  },

  async updateProviderNotes(data: { openai: string; azure: string; ollama: string }): Promise<void> {
    await http.put('/settings/provider-notes', data)
  },

  async getA2ASettings(): Promise<{ a2a_synthesize: boolean; agent_model: string }> {
    const res = await http.get('/settings/a2a')
    return res.data
  },

  async updateA2ASettings(data: { a2a_synthesize: boolean; agent_model: string }): Promise<void> {
    await http.put('/settings/a2a', data)
  },

  async agentChat(
    message: string,
    history: { role: string; content: string }[],
  ): Promise<{ answer: string; sources: { chunk_id: string; doc_id: string; content: string; score: number }[]; latency_ms: number }> {
    const res = await http.post('/agent/chat', { message, history })
    return res.data
  },

  async getAgentHistory(): Promise<{ role: string; content: string }[]> {
    const res = await http.get('/agent/history')
    return res.data
  },

  async saveAgentHistory(messages: { role: string; content: string }[]): Promise<void> {
    await http.put('/agent/history', messages)
  },

  async clearAgentHistory(): Promise<void> {
    await http.delete('/agent/history')
  },

  async getConnections(): Promise<{
    exposed: any[]
    consumed: any[]
  }> {
    const res = await http.get('/connections')
    return res.data
  },

  async getAgentCard(): Promise<any> {
    const res = await http.get('/connections/agent-card')
    return res.data
  },

  async getRegisteredConnections(): Promise<{ a2a: any[]; mcp: any[] }> {
    const res = await http.get('/connections/registered')
    return res.data
  },

  async registerA2AConnection(name: string, agentCardUrl: string): Promise<any> {
    const res = await http.post('/connections/registered/a2a', { name, agent_card_url: agentCardUrl })
    return res.data
  },

  async registerMCPConnection(name: string, serverUrl: string, description?: string, transport?: string): Promise<any> {
    const res = await http.post('/connections/registered/mcp', { name, server_url: serverUrl, description: description ?? '', transport: transport ?? 'sse' })
    return res.data
  },

  async deleteRegisteredConnection(id: string): Promise<void> {
    await http.delete(`/connections/registered/${id}`)
  },

  async testRegisteredConnection(id: string): Promise<{ id: string; status: string; message: string }> {
    const res = await http.post(`/connections/registered/${id}/test`)
    return res.data
  },

  async setMCPAgentToolEnabled(id: string, enabled: boolean): Promise<void> {
    await http.patch(`/connections/registered/${id}/agent-tool`, { enabled })
  },

  async callRegisteredTool(id: string, toolName: string, args: Record<string, unknown>): Promise<{ result: string }> {
    const res = await http.post(`/connections/registered/${id}/call`, { tool_name: toolName, arguments: args })
    return res.data
  },

  async getSamples(): Promise<{ filename: string; size_bytes: number; ext: string }[]> {
    const res = await http.get('/documents/samples')
    return res.data
  },

  async ingestSamples(
    filenames: string[],
    opts: {
      chunk_strategy: string
      chunk_size: number
      chunk_overlap: number
      embed_model: string
      extract_graph: boolean
      percentile_threshold?: number
      max_chunk_tokens?: number
    }
  ): Promise<Document_[]> {
    const res = await http.post<Document_[]>('/documents/ingest-samples', {
      filenames,
      ...opts,
    })
    return res.data
  },

  // ---- Connection Logs ----

  async getConnectionLogs(params?: { limit?: number; direction?: string; event_type?: string }): Promise<any[]> {
    const res = await http.get('/logs/connections', { params })
    return res.data
  },

  async clearConnectionLogs(): Promise<void> {
    await http.delete('/logs/connections')
  },

  // ---- Agent Sessions ----

  async listAgentSessions(): Promise<any[]> {
    const res = await http.get('/agent/sessions')
    return res.data
  },

  async createAgentSession(): Promise<any> {
    const res = await http.post('/agent/sessions')
    return res.data
  },

  async getSessionMessages(sessionId: string): Promise<{ role: string; content: string }[]> {
    const res = await http.get(`/agent/sessions/${sessionId}/messages`)
    return res.data
  },

  async saveSessionMessages(sessionId: string, messages: { role: string; content: string }[]): Promise<void> {
    await http.put(`/agent/sessions/${sessionId}/messages`, messages)
  },

  async renameAgentSession(sessionId: string, name: string): Promise<any> {
    const res = await http.patch(`/agent/sessions/${sessionId}`, { name })
    return res.data
  },

  async deleteAgentSession(sessionId: string): Promise<void> {
    await http.delete(`/agent/sessions/${sessionId}`)
  },

  // ---- ngrok ----

  async getNgrokStatus(): Promise<{ running: boolean; url: string | null }> {
    const res = await http.get('/ngrok/status')
    return res.data
  },

  async startNgrok(): Promise<{ running: boolean; url: string }> {
    const res = await http.post('/ngrok/start')
    return res.data
  },

  async stopNgrok(): Promise<{ running: boolean; url: string | null }> {
    const res = await http.post('/ngrok/stop')
    return res.data
  },

  async triggerGraphExtraction(docId: string): Promise<void> {
    await http.post(`/documents/${docId}/extract-graph`)
  },

  async getExtractProgress(docId: string): Promise<{
    total: number; done: number; triples: number
    status: 'running' | 'rate_limited'; wait_remaining_secs: number
  } | null> {
    try {
      const res = await http.get<{
        total: number; done: number; triples: number
        status: 'running' | 'rate_limited'; wait_remaining_secs: number
      }>(`/documents/${docId}/extract-progress`)
      return res.data
    } catch {
      return null  // 404 = not running
    }
  },

  async cancelGraphExtraction(docId: string): Promise<void> {
    await http.post(`/documents/${docId}/cancel-graph`)
  },

  // ---- Analytics ----

  async getAnalyticsSummary(): Promise<{
    runs: {
      total: number
      by_day: { date: string; count: number; avg_latency_ms: number; total_cost_usd: number; total_prompt_tokens: number; total_completion_tokens: number }[]
      by_mode: { mode: string; count: number; avg_latency_ms: number; avg_cost_usd: number; avg_chunks: number }[]
      by_model: { model: string; count: number; total_prompt_tokens: number; total_completion_tokens: number; total_cost_usd: number }[]
      latency_percentiles: { p50: number; p90: number; p99: number }
    }
    agent_tokens: {
      by_day: { date: string; prompt_tokens: number; completion_tokens: number; cost_usd: number }[]
      by_model: { model: string; prompt_tokens: number; completion_tokens: number; cost_usd: number }[]
      total_prompt_tokens: number
      total_completion_tokens: number
      total_cost_usd: number
    }
    system_costs: {
      entries: { id: string; date: string; description: string; model: string; prompt_tokens: number; completion_tokens: number; cost_usd: number }[]
      by_day: { date: string; cost_usd: number; prompt_tokens: number; completion_tokens: number }[]
      total_cost_usd: number
    }
    connections: {
      total_events: number
      inbound_calls: number
      outbound_calls: number
      internal_events: number
      by_connection: { name: string; type: string; inbound: number; outbound: number; errors: number }[]
      by_event_type: { event_type: string; count: number }[]
      errors_by_day: { date: string; errors: number; total: number }[]
      agent_calls_by_day: { date: string; ui_calls: number; a2a_calls: number }[]
    }
    platform: {
      documents_ingested: number
      total_chunks: number
      benchmark_runs: number
      agent_sessions: number
      agent_messages_total: number
      documents_by_day: { date: string; count: number; chunks: number }[]
      system_events: { timestamp: string; event_type: string; summary: string }[]
      risk_signals: { level: 'warning' | 'error'; signal: string; count: number; since: string }[]
    }
  }> {
    const res = await http.get('/analytics/summary')
    return res.data
  },

  async addSystemCost(entry: {
    date: string; description: string; model: string
    prompt_tokens: number; completion_tokens: number; cost_usd: number
  }): Promise<{ id: string }> {
    const res = await http.post('/analytics/system-costs', entry)
    return res.data
  },

  async deleteSystemCost(id: string): Promise<void> {
    await http.delete(`/analytics/system-costs/${id}`)
  },

  // ---- Agent Configs ----

  async listAgentConfigs(): Promise<any[]> {
    const res = await http.get('/agent-configs')
    return res.data
  },

  async createAgentConfig(data: {
    name: string
    role: string
    system_prompt: string
    tools: { mcp_connection_ids: string[]; a2a_connection_ids: string[]; use_own_a2a: boolean }
    rag: { enabled: boolean; retrieval_mode: string; model_name: string; embed_model: string; top_k: number }
  }): Promise<any> {
    const res = await http.post('/agent-configs', data)
    return res.data
  },

  async updateAgentConfig(id: string, data: {
    name: string
    role: string
    system_prompt: string
    tools: { mcp_connection_ids: string[]; a2a_connection_ids: string[]; use_own_a2a: boolean }
    rag: { enabled: boolean; retrieval_mode: string; model_name: string; embed_model: string; top_k: number }
  }): Promise<any> {
    const res = await http.put(`/agent-configs/${id}`, data)
    return res.data
  },

  async deleteAgentConfig(id: string): Promise<void> {
    await http.delete(`/agent-configs/${id}`)
  },

  async chatWithAgentConfig(
    id: string,
    message: string,
    history: { role: string; content: string }[]
  ): Promise<{ answer: string; latency_ms: number; rag_used: boolean }> {
    const res = await http.post(`/agent-configs/${id}/chat`, { message, history })
    return res.data
  },

  // ---- Debate ----

  async startDebate(body: {
    host_id: string
    guest_ids: string[]
    topic: string
    rounds: number
  }): Promise<{ session_id: string }> {
    const res = await http.post('/debate/start', body)
    return res.data
  },

  async listDebateSessions(): Promise<any[]> {
    const res = await http.get('/debate')
    return res.data
  },

  async getDebateSession(sessionId: string): Promise<any> {
    const res = await http.get(`/debate/${sessionId}`)
    return res.data
  },

  // ---- Unified Runs ----

  getUnifiedRuns(params?: { domain?: string; run_type?: string; status?: string; limit?: number; offset?: number }) {
    return http.get('/unified-runs', { params }).then(r => r.data)
  },

  getUnifiedRun(runId: string) {
    return http.get(`/unified-runs/${runId}`).then(r => r.data)
  },

  getRunSteps(runId: string) {
    return http.get(`/unified-runs/${runId}/steps`).then(r => r.data)
  },

  getRunEvents(runId: string) {
    return http.get(`/unified-runs/${runId}/events`).then(r => r.data)
  },

  getRunLive(runId: string, since?: string) {
    return http.get(`/unified-runs/${runId}/live`, { params: since ? { since } : {} }).then(r => r.data)
  },
}
