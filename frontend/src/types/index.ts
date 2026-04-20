export interface Document {
  id: string
  filename: string
  file_type: string
  created_at: string
  chunk_strategy: string
  chunk_count: number
  doc_metadata: Record<string, unknown>
  graph_extracted: boolean
  embedded_count?: number   // chunks successfully upserted into ChromaDB
  embedding_errors?: number // batches that failed to embed
}

export interface Chunk {
  id: string
  doc_id: string
  content: string
  chunk_index: number
  parent_chunk_id: string | null
  start_char: number
  end_char: number
  metadata_json: Record<string, unknown>
}

export interface ContextItem {
  chunk_id: string
  doc_id: string
  content: string
  score: number
  metadata: Record<string, unknown>
}

export interface Run {
  id: string
  query: string
  retrieval_mode: string
  model_name: string
  embed_model: string
  answer: string
  context_json: ContextItem[]
  latency_ms: number
  prompt_tokens: number
  completion_tokens: number
  estimated_cost_usd: number
  stage_timings_json: Record<string, number>
  chunk_count: number
  graph_node_count: number
  created_at: string
}

export interface GraphNode {
  id: string
  label: string
  type: string
  doc_ids: string[]
  chunk_ids: string[]
}

export interface GraphEdge {
  source: string
  target: string
  predicate: string
  chunk_id: string
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface BenchmarkRun {
  id: string
  name: string
  status: string
  config_json: Record<string, unknown>
  created_at: string
  completed_at: string | null
  total_questions: number
  completed_questions: number
}

export interface BenchmarkChunk {
  chunk_id: string
  doc_id: string
  content: string
  score: number
}

export interface BenchmarkResult {
  id: string
  benchmark_run_id: string
  question: string
  reference_answer: string
  config_label: string
  retrieval_mode: string
  model_name: string
  embed_model: string
  answer: string
  context_precision: number
  answer_relevance: number
  hit_rate: number | null
  mrr: number | null
  answer_correctness: number | null
  faithfulness: number | null
  chunks_retrieved: number | null
  source_doc_id: string | null
  contexts: BenchmarkChunk[]
  latency_ms: number
  estimated_cost_usd: number
  created_at: string
}

export interface BenchmarkQuestion {
  question: string
  reference_answer: string
  doc_ids: string[]
  source_chunk_id?: string | null
}

export interface BenchmarkConfig {
  label: string
  retrieval_mode: string
  model_name: string
  embed_model: string
  top_k: number
}

export interface ModelsInfo {
  llms: string[]
  embed_models: string[]
  rerankers: string[]
}

export interface QueryRequest {
  query: string
  retrieval_mode: string
  model_name: string
  embed_model: string
  top_k: number
  alpha?: number
  graph_hops?: number
}

export interface QueryResponse {
  answer: string
  contexts: ContextItem[]
  run_id: string
  latency_ms: number
  prompt_tokens: number
  completion_tokens: number
  estimated_cost_usd: number
  stage_timings: Record<string, number>
  retrieval_mode: string
}

export interface GraphStats {
  node_count: number
  edge_count: number
  top_entities: Array<{ node: string; degree: number }>
  doc_count: number
}

export interface GraphQueryResponse {
  nodes: GraphNode[]
  edges: GraphEdge[]
  chunk_ids: string[]
}
