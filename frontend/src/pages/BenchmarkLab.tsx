import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { useAppStore } from '../store/useAppStore'
import { Spinner } from '../components/Spinner'
import { ErrorAlert } from '../components/ErrorAlert'
import { Badge } from '../components/Badge'
import { Trash2, Plus, ChevronDown, ChevronRight, HelpCircle, X } from 'lucide-react'
import type { BenchmarkQuestion, BenchmarkConfig, BenchmarkRun, BenchmarkResult } from '../types'

const RETRIEVAL_MODES = [
  'lexical',
  'vector',
  'hybrid',
  'semantic_rerank',
  'graph_rag',
  'parent_child',
]

function statusVariant(status: string): 'gray' | 'yellow' | 'green' | 'red' {
  if (status === 'pending') return 'gray'
  if (status === 'running') return 'yellow'
  if (status === 'completed') return 'green'
  return 'red'
}

export function BenchmarkLab() {
  const { models, documents, setDocuments } = useAppStore()

  // Section 1: question set
  const [questionSet, setQuestionSet] = useState<BenchmarkQuestion[]>([])
  const [loadingQuestions, setLoadingQuestions] = useState(false)
  const [generatingQuestions, setGeneratingQuestions] = useState(false)
  const [generateCount, setGenerateCount] = useState(10)
  const [generateError, setGenerateError] = useState<string | null>(null)

  // Section 2: configs
  const [configs, setConfigs] = useState<BenchmarkConfig[]>([])
  const [newConfigLabel, setNewConfigLabel] = useState('')
  const [newConfigMode, setNewConfigMode] = useState('vector')
  const [newConfigModel, setNewConfigModel] = useState('')
  const [newConfigEmbed, setNewConfigEmbed] = useState('')
  const [newConfigTopK, setNewConfigTopK] = useState(5)

  // Section 3: run
  const [benchmarkName, setBenchmarkName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // Section 4: runs list
  const [benchmarkRuns, setBenchmarkRuns] = useState<BenchmarkRun[]>([])
  const [loadingRuns, setLoadingRuns] = useState(true)
  const [runsError, setRunsError] = useState<string | null>(null)

  // Section 5: results
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [results, setResults] = useState<BenchmarkResult[]>([])
  const [loadingResults, setLoadingResults] = useState(false)
  const [expandedChunks, setExpandedChunks] = useState<Set<string>>(new Set())

  function toggleChunks(key: string) {
    setExpandedChunks((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const [showHelp, setShowHelp] = useState(false)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const llmOptions = models?.llms ?? []
  const embedOptions = models?.embed_models ?? []

  // Derive the embed model(s) used across all ingested documents
  const ingestedEmbedModels = Array.from(
    new Set(
      documents
        .map((d) => d.doc_metadata?.embed_model as string | undefined)
        .filter(Boolean)
    )
  ) as string[]

  // Check if documents in the current question set use mixed embed models
  const docIdToEmbedModel = Object.fromEntries(
    documents
      .filter((d) => d.doc_metadata?.embed_model)
      .map((d) => [d.id, d.doc_metadata.embed_model as string])
  )
  const questionDocEmbedModels = Array.from(
    new Set(
      questionSet
        .flatMap((q) => q.doc_ids)
        .map((id) => docIdToEmbedModel[id])
        .filter(Boolean)
    )
  )
  const hasMixedEmbedModels = questionDocEmbedModels.length > 1

  useEffect(() => {
    if (!newConfigModel && llmOptions.length > 0) setNewConfigModel(llmOptions[0])
    if (!newConfigEmbed && embedOptions.length > 0) setNewConfigEmbed(embedOptions[0])
  }, [llmOptions, embedOptions, newConfigModel, newConfigEmbed])

  // Load runs, documents, and saved session on mount
  useEffect(() => {
    loadRuns()
    api.getDocuments().then(setDocuments).catch(() => {})
    api.getBenchmarkSession().then(({ question_set, configs: savedConfigs }) => {
      if (question_set.length > 0) setQuestionSet(question_set)
      if (savedConfigs.length > 0) setConfigs(savedConfigs)
    }).catch(() => {})
  }, [])

  // Auto-save session whenever question set or configs change
  useEffect(() => {
    if (questionSet.length === 0 && configs.length === 0) return
    api.saveBenchmarkSession(questionSet, configs).catch(() => {})
  }, [questionSet, configs])

  // Polling for active runs
  useEffect(() => {
    const hasActive = benchmarkRuns.some(
      (r) => r.status === 'pending' || r.status === 'running'
    )
    if (hasActive && !pollingRef.current) {
      pollingRef.current = setInterval(async () => {
        const active = benchmarkRuns.filter(
          (r) => r.status === 'pending' || r.status === 'running'
        )
        const updated = await Promise.all(active.map((r) => api.getBenchmarkRun(r.id)))
        setBenchmarkRuns((prev) =>
          prev.map((r) => {
            const u = updated.find((u) => u.id === r.id)
            return u ?? r
          })
        )
      }, 3000)
    } else if (!hasActive && pollingRef.current) {
      clearInterval(pollingRef.current)
      pollingRef.current = null
    }
    return () => {}
  }, [benchmarkRuns])

  useEffect(() => {
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current)
    }
  }, [])

  async function loadRuns() {
    try {
      setLoadingRuns(true)
      const runs = await api.getBenchmarkRuns()
      setBenchmarkRuns(runs)
    } catch (err) {
      setRunsError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setLoadingRuns(false)
    }
  }

  async function handleLoadDefaultQuestions() {
    try {
      setLoadingQuestions(true)
      const qs = await api.getDefaultQuestionSet()
      setQuestionSet(qs)
    } catch (err) {
      console.error(err)
    } finally {
      setLoadingQuestions(false)
    }
  }

  async function handleGenerateQuestions() {
    try {
      setGeneratingQuestions(true)
      setGenerateError(null)
      const qs = await api.generateQuestionSet(generateCount)
      setQuestionSet(qs)
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : 'Generation failed')
    } finally {
      setGeneratingQuestions(false)
    }
  }

  function updateQuestion(index: number, field: 'question' | 'reference_answer', value: string) {
    setQuestionSet((prev) => {
      const next = [...prev]
      next[index] = { ...next[index], [field]: value }
      return next
    })
  }

  function updateQuestionDoc(index: number, docId: string) {
    setQuestionSet((prev) => {
      const next = [...prev]
      next[index] = { ...next[index], doc_ids: docId ? [docId] : [] }
      return next
    })
  }

  function removeQuestion(index: number) {
    setQuestionSet((prev) => prev.filter((_, i) => i !== index))
  }

  function addQuestion() {
    setQuestionSet((prev) => [...prev, { question: '', reference_answer: '', doc_ids: [] }])
  }

  function addConfig() {
    if (!newConfigLabel.trim()) return
    const cfg: BenchmarkConfig = {
      label: newConfigLabel.trim(),
      retrieval_mode: newConfigMode,
      model_name: newConfigModel,
      embed_model: newConfigEmbed,
      top_k: newConfigTopK,
    }
    setConfigs((prev) => [...prev, cfg])
    setNewConfigLabel('')
  }

  function removeConfig(index: number) {
    setConfigs((prev) => prev.filter((_, i) => i !== index))
  }

  async function handleStartBenchmark() {
    if (!benchmarkName.trim() || questionSet.length === 0 || configs.length === 0) return
    try {
      setCreating(true)
      setCreateError(null)
      const run = await api.createBenchmarkRun({
        name: benchmarkName.trim(),
        question_set: questionSet.filter((q) => q.question.trim()),
        configs,
      })
      setBenchmarkRuns((prev) => [run, ...prev])
      setBenchmarkName('')
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setCreating(false)
    }
  }

  async function handleSelectRun(run: BenchmarkRun) {
    if (run.status !== 'completed') return
    setSelectedRunId(run.id)
    try {
      setLoadingResults(true)
      const res = await api.getBenchmarkResults(run.id)
      setResults(res)
    } catch (err) {
      console.error(err)
    } finally {
      setLoadingResults(false)
    }
  }

  // Build result table
  const selectedRun = benchmarkRuns.find((r) => r.id === selectedRunId)
  const configLabels = Array.from(new Set(results.map((r) => r.config_label)))
  const questions = Array.from(new Set(results.map((r) => r.question)))

  function getResult(question: string, configLabel: string) {
    return results.find((r) => r.question === question && r.config_label === configLabel)
  }

  function avgFor(configLabel: string, field: keyof BenchmarkResult) {
    const rows = results.filter((r) => r.config_label === configLabel)
    if (rows.length === 0) return 0
    return rows.reduce((acc, r) => acc + Number(r[field] ?? 0), 0) / rows.length
  }

  return (
    <div className="max-w-7xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Benchmark Lab</h1>
        <button
          onClick={() => setShowHelp(true)}
          className="text-slate-400 hover:text-blue-600 transition-colors"
          title="How does the benchmark work?"
        >
          <HelpCircle size={20} />
        </button>
      </div>

      {/* Help modal */}
      {showHelp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-5 border-b border-slate-200">
              <h2 className="text-lg font-semibold text-slate-800">How the Benchmark Works</h2>
              <button onClick={() => setShowHelp(false)} className="text-slate-400 hover:text-slate-600">
                <X size={20} />
              </button>
            </div>
            <div className="p-5 space-y-4 text-sm text-slate-700">
              <p>
                The benchmark answers one core question: <strong>"Given a question I know the answer to, how well does each retrieval strategy find the right information?"</strong>
              </p>

              <div>
                <h3 className="font-semibold text-slate-800 mb-1">The Setup</h3>
                <p>You define a <strong>question set</strong> — questions generated from your ingested documents, each linked to the source document — and one or more <strong>configurations</strong> (retrieval mode + LLM + embed model) to compare against each other.</p>
              </div>

              <div>
                <h3 className="font-semibold text-slate-800 mb-2">What happens per question × config</h3>
                <ol className="space-y-2 list-decimal list-inside">
                  <li><strong>Retrieval</strong> — runs the configured strategy and fetches the top-K chunks from your documents.</li>
                  <li><strong>Generation</strong> — feeds those chunks as context to the LLM and asks it to answer the question.</li>
                  <li><strong>Retrieval metrics</strong> — compares the retrieved chunks' documents against the source document linked to the question.</li>
                  <li><strong>Answer quality metrics</strong> — evaluates whether the generated answer is correct and grounded.</li>
                </ol>
              </div>

              <div>
                <h3 className="font-semibold text-slate-800 mb-2">Metrics explained</h3>
                <div className="space-y-1.5">
                  <div className="flex gap-2"><span className="font-medium text-green-700 w-28 shrink-0">Hit@K</span><span>Did any of the top-K chunks come from the correct document? Binary: 1 (hit) or 0 (miss). Requires a linked document.</span></div>
                  <div className="flex gap-2"><span className="font-medium text-blue-700 w-28 shrink-0">MRR</span><span>Mean Reciprocal Rank — at what position did the first correct chunk appear? Rank 1 = 1.0, rank 2 = 0.5, rank 3 = 0.33. Requires a linked document.</span></div>
                  <div className="flex gap-2"><span className="font-medium text-green-700 w-28 shrink-0">Correctness</span><span>Cosine similarity between the generated answer and the reference answer. Measures whether the answer means the same thing as the expected answer.</span></div>
                  <div className="flex gap-2"><span className="font-medium text-yellow-700 w-28 shrink-0">Faithfulness</span><span>Fraction of the answer's keywords that appear in the retrieved chunks. Low score means the LLM hallucinated content not in the retrieved context.</span></div>
                  <div className="flex gap-2"><span className="font-medium text-slate-700 w-28 shrink-0">Ctx Precision</span><span>Fraction of retrieved chunks that share keywords with the reference answer. Measures whether retrieval returned relevant chunks or noise.</span></div>
                </div>
              </div>

              <div className="bg-amber-50 border border-amber-200 rounded p-3 text-xs text-amber-800">
                <strong>Important:</strong> Hit@K and MRR only work when questions are linked to a source document. Use <em>Generate from Documents</em> to create questions automatically — they will be linked to the correct document.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Section 1: Question Set */}
      <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-4 mb-6">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <h2 className="text-xl font-semibold text-slate-800">Question Set</h2>
          <div className="flex items-center gap-2 flex-wrap">
            {generateError && (
              <span className="text-xs text-red-600">{generateError}</span>
            )}
            <div className="flex items-center gap-1">
              <label className="text-xs text-slate-500">Count</label>
              <input
                type="number"
                className="border border-slate-300 rounded px-2 py-1 text-sm w-16 focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={generateCount}
                min={1}
                max={50}
                onChange={(e) => setGenerateCount(Number(e.target.value))}
              />
            </div>
            <button
              className="border border-blue-500 text-blue-600 rounded px-3 py-1.5 text-sm hover:bg-blue-50 flex items-center gap-2 disabled:opacity-50"
              onClick={handleGenerateQuestions}
              disabled={generatingQuestions || loadingQuestions}
            >
              {generatingQuestions && <Spinner size="sm" />}
              Generate from Documents
            </button>
            <button
              className="border border-slate-300 rounded px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2 disabled:opacity-50"
              onClick={handleLoadDefaultQuestions}
              disabled={loadingQuestions || generatingQuestions}
            >
              {loadingQuestions && <Spinner size="sm" />}
              Load Default Questions
            </button>
          </div>
        </div>

        {questionSet.length === 0 ? (
          <p className="text-slate-500 text-sm mb-3">
            No questions. Load defaults or add manually.
          </p>
        ) : (
          <div className="space-y-2 mb-3">
            {questionSet.map((q, i) => (
              <div key={i} className="flex gap-2 items-start">
                <span className="text-xs text-slate-400 mt-2 w-5 text-right shrink-0">{i + 1}.</span>
                <input
                  type="text"
                  className="flex-1 border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Question…"
                  value={q.question}
                  onChange={(e) => updateQuestion(i, 'question', e.target.value)}
                />
                <input
                  type="text"
                  className="flex-1 border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Reference answer…"
                  value={q.reference_answer}
                  onChange={(e) => updateQuestion(i, 'reference_answer', e.target.value)}
                />
                <select
                  className={`border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 max-w-[180px] ${
                    q.doc_ids.length === 0
                      ? 'border-amber-400 bg-amber-50 text-amber-700'
                      : 'border-slate-300'
                  }`}
                  value={q.doc_ids[0] ?? ''}
                  onChange={(e) => updateQuestionDoc(i, e.target.value)}
                  title="Link this question to a document for MRR/Hit@K evaluation"
                >
                  <option value="">— no document linked —</option>
                  {documents.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.filename}
                    </option>
                  ))}
                </select>
                <button
                  className="p-1.5 text-red-500 hover:bg-red-50 rounded shrink-0"
                  onClick={() => removeQuestion(i)}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
        )}

        <button
          className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700"
          onClick={addQuestion}
        >
          <Plus size={16} /> Add Question
        </button>
      </div>

      {/* Section 2: Configurations */}
      <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-4 mb-6">
        <h2 className="text-xl font-semibold text-slate-800 mb-4">Configurations</h2>

        {configs.length > 0 && (
          <div className="space-y-2 mb-4">
            {configs.map((cfg, i) => (
              <div
                key={i}
                className="flex items-center gap-3 border border-slate-200 rounded-lg p-3"
              >
                <Badge variant="blue">{cfg.label}</Badge>
                <span className="text-sm text-slate-600">{cfg.retrieval_mode}</span>
                <span className="text-sm text-slate-500">{cfg.model_name}</span>
                <span className="text-xs text-slate-500">{cfg.embed_model}</span>
                <span className="text-xs text-slate-400">top_k={cfg.top_k}</span>
                {ingestedEmbedModels.length > 0 && !ingestedEmbedModels.includes(cfg.embed_model) && (
                  <span className="text-xs text-amber-600 font-medium" title={`Documents ingested with: ${ingestedEmbedModels.join(', ')}`}>
                    ⚠ embed mismatch
                  </span>
                )}
                <button
                  className="ml-auto p-1 text-red-500 hover:bg-red-50 rounded"
                  onClick={() => removeConfig(i)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Add config form */}
        <div className="border border-dashed border-slate-300 rounded-lg p-3">
          <h3 className="text-sm font-medium text-slate-700 mb-2">Add Configuration</h3>
          <div className="flex flex-wrap gap-2 items-end">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-slate-500">Label</label>
              <input
                type="text"
                className="border border-slate-300 rounded px-2 py-1.5 text-sm w-28 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="e.g. Vector-GPT4"
                value={newConfigLabel}
                onChange={(e) => setNewConfigLabel(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-slate-500">Mode</label>
              <select
                className="border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={newConfigMode}
                onChange={(e) => setNewConfigMode(e.target.value)}
              >
                {RETRIEVAL_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-slate-500">Model</label>
              <select
                className="border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={newConfigModel}
                onChange={(e) => setNewConfigModel(e.target.value)}
              >
                {llmOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                {llmOptions.length === 0 && <option value="">—</option>}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-slate-500">
                Embed Model
                {ingestedEmbedModels.length > 0 && !ingestedEmbedModels.includes(newConfigEmbed) && (
                  <span className="ml-1 text-amber-600 font-normal">⚠ mismatch</span>
                )}
              </label>
              <select
                className={`border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  ingestedEmbedModels.length > 0 && !ingestedEmbedModels.includes(newConfigEmbed)
                    ? 'border-amber-400 bg-amber-50'
                    : 'border-slate-300'
                }`}
                value={newConfigEmbed}
                onChange={(e) => setNewConfigEmbed(e.target.value)}
              >
                {embedOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}{ingestedEmbedModels.includes(m) ? ' ✓ used for ingestion' : ''}
                  </option>
                ))}
                {embedOptions.length === 0 && <option value="">—</option>}
              </select>
              {ingestedEmbedModels.length > 0 && !ingestedEmbedModels.includes(newConfigEmbed) && (
                <p className="text-xs text-amber-600">
                  Documents were ingested with: <strong>{ingestedEmbedModels.join(', ')}</strong>.
                  Using a different model will produce incorrect vector search results.
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-slate-500">Top K</label>
              <input
                type="number"
                className="border border-slate-300 rounded px-2 py-1.5 text-sm w-16 focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={newConfigTopK}
                min={1}
                max={20}
                onChange={(e) => setNewConfigTopK(Number(e.target.value))}
              />
            </div>
            <button
              className="bg-blue-600 hover:bg-blue-700 text-white rounded px-3 py-1.5 text-sm font-medium flex items-center gap-1 disabled:opacity-50"
              onClick={addConfig}
              disabled={!newConfigLabel.trim()}
            >
              <Plus size={14} /> Add
            </button>
          </div>
        </div>
      </div>

      {/* Section 3: Run */}
      <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-4 mb-6">
        <h2 className="text-xl font-semibold text-slate-800 mb-4">Start Benchmark Run</h2>
        <div className="flex gap-3 items-end">
          <div className="flex flex-col gap-1 flex-1 max-w-xs">
            <label className="text-xs font-medium text-slate-600">Benchmark Name</label>
            <input
              type="text"
              className="border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g. Retrieval Comparison v1"
              value={benchmarkName}
              onChange={(e) => setBenchmarkName(e.target.value)}
            />
          </div>
          <button
            className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            onClick={handleStartBenchmark}
            disabled={
              creating ||
              hasMixedEmbedModels ||
              !benchmarkName.trim() ||
              questionSet.filter((q) => q.question.trim()).length === 0 ||
              configs.length === 0
            }
          >
            {creating && <Spinner size="sm" />}
            {creating ? 'Starting…' : 'Start Benchmark'}
          </button>
        </div>

        {hasMixedEmbedModels && (
          <div className="mt-3 p-3 bg-red-50 border border-red-300 rounded text-sm text-red-700">
            <strong>Cannot run benchmark:</strong> the questions in your set are linked to documents
            that were ingested with different embedding models ({questionDocEmbedModels.join(', ')}).
            Vector search results would be meaningless across mixed embedding spaces.
            Use questions from documents ingested with the same model, or re-ingest all documents
            with a single model.
          </div>
        )}

        {createError && (
          <div className="mt-3">
            <ErrorAlert message={createError} />
          </div>
        )}
        {(questionSet.filter((q) => q.question.trim()).length === 0 ||
          configs.length === 0) && (
          <p className="text-xs text-slate-400 mt-2">
            Add at least one question and one configuration to start.
          </p>
        )}
      </div>

      {/* Section 4: Runs List */}
      <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-4 mb-6">
        <h2 className="text-xl font-semibold text-slate-800 mb-4">Benchmark Runs</h2>
        {runsError && (
          <div className="mb-3">
            <ErrorAlert message={runsError} />
          </div>
        )}
        {loadingRuns ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : benchmarkRuns.length === 0 ? (
          <p className="text-slate-500 text-sm">No benchmark runs yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left py-2 pr-4 text-slate-600 font-medium">Name</th>
                  <th className="text-left py-2 pr-4 text-slate-600 font-medium">Status</th>
                  <th className="text-left py-2 pr-4 text-slate-600 font-medium">Progress</th>
                  <th className="text-left py-2 pr-4 text-slate-600 font-medium">Started</th>
                  <th className="text-left py-2 text-slate-600 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {benchmarkRuns.map((run) => (
                  <tr key={run.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="py-2 pr-4 text-slate-800 font-medium">{run.name}</td>
                    <td className="py-2 pr-4">
                      <Badge variant={statusVariant(run.status)}>
                        {run.status === 'running' && (
                          <span className="inline-block w-2 h-2 rounded-full bg-yellow-500 animate-pulse mr-1" />
                        )}
                        {run.status}
                      </Badge>
                    </td>
                    <td className="py-2 pr-4 text-slate-600">
                      {run.completed_questions}/{run.total_questions}
                    </td>
                    <td className="py-2 pr-4 text-slate-500">
                      {new Date(run.created_at).toLocaleDateString()}
                    </td>
                    <td className="py-2">
                      {run.status === 'completed' && (
                        <button
                          className="text-blue-600 hover:underline text-xs"
                          onClick={() => handleSelectRun(run)}
                        >
                          View Results
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Section 5: Results */}
      {selectedRunId && selectedRun?.status === 'completed' && (
        <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-4">
          <h2 className="text-xl font-semibold text-slate-800 mb-4">
            Results — {selectedRun.name}
          </h2>
          {/* Metric legend */}
          <div className="mb-4 p-3 bg-slate-50 rounded border border-slate-200 text-xs text-slate-600 grid grid-cols-2 gap-x-6 gap-y-1">
            <div><span className="font-semibold text-green-700">✓ Hit / ✗ Miss</span> — Did retrieval return at least one chunk from the linked document? Requires a document to be linked to the question.</div>
            <div><span className="font-semibold text-blue-700">MRR</span> — Mean Reciprocal Rank: 1/rank of first chunk from the linked document (1.0 = first result, 0.5 = second). N/A if no document linked.</div>
            <div><span className="font-semibold text-green-700">Correctness</span> — Semantic similarity between the generated answer and the reference answer</div>
            <div><span className="font-semibold text-yellow-700">Faithfulness</span> — Fraction of the answer grounded in retrieved context (low = likely hallucinating)</div>
            <div><span className="font-semibold text-slate-700">Ctx Precision</span> — Fraction of top-K chunks that contain keywords from the reference answer</div>
            <div><span className="font-semibold text-purple-700">Cost</span> — Estimated OpenAI API cost in USD for retrieval + generation</div>
          </div>

          {loadingResults ? (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          ) : results.length === 0 ? (
            <p className="text-slate-500 text-sm">No results found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left py-2 pr-4 text-slate-600 font-medium min-w-48">
                      Question
                    </th>
                    {configLabels.map((label) => (
                      <th
                        key={label}
                        className="text-left py-2 pr-4 text-slate-600 font-medium min-w-64"
                      >
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {questions.map((q) => {
                    // Find source doc from any result for this question (all configs share the same source doc)
                    const anyResult = results.find((r) => r.question === q)
                    const sourceDoc = anyResult?.source_doc_id
                      ? documents.find((d) => d.id === anyResult.source_doc_id)
                      : null
                    const sourceDocName = sourceDoc?.filename ?? anyResult?.source_doc_id?.slice(0, 8) ?? null

                    return (
                    <tr key={q} className="border-b border-slate-100 align-top">
                      <td className="py-2 pr-4 text-slate-700 text-xs max-w-xs">
                        <p>{q}</p>
                        {sourceDocName && (
                          <p className="mt-0.5 text-slate-400 italic truncate max-w-[180px]" title={sourceDoc?.filename}>
                            src: {sourceDocName.length > 22 ? sourceDocName.slice(0, 22) + '…' : sourceDocName}
                          </p>
                        )}
                      </td>
                      {configLabels.map((label) => {
                        const r = getResult(q, label)
                        return (
                          <td key={label} className="py-2 pr-4">
                            {r ? (
                              <div className="space-y-1">
                                <p className="text-xs text-slate-700">
                                  {r.answer.length > 120 ? r.answer.slice(0, 120) + '…' : r.answer}
                                </p>
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {r.hit_rate != null ? (
                                    <Badge
                                      variant={r.hit_rate === 1 ? 'green' : 'red'}
                                      title="Hit@K — did retrieval return a chunk from the linked document?"
                                    >
                                      {r.hit_rate === 1 ? '✓ Hit' : '✗ Miss'}
                                    </Badge>
                                  ) : (
                                    <Badge variant="gray" title="Hit@K — no document linked to this question">Hit: N/A</Badge>
                                  )}
                                  {r.mrr != null ? (
                                    <Badge variant="blue" title="Mean Reciprocal Rank — 1/rank of first relevant chunk">MRR: {r.mrr.toFixed(2)}</Badge>
                                  ) : (
                                    <Badge variant="gray" title="MRR — no document linked">MRR: N/A</Badge>
                                  )}
                                  <Badge variant="green" title="Answer Correctness — semantic similarity to reference answer">Corr: {(r.answer_correctness ?? 0).toFixed(2)}</Badge>
                                  <Badge variant="yellow" title="Faithfulness — fraction of answer grounded in retrieved context">Faith: {(r.faithfulness ?? 0).toFixed(2)}</Badge>
                                  <Badge variant="gray" title="Context Precision — fraction of retrieved chunks relevant to the answer">Ctx: {r.context_precision.toFixed(2)}</Badge>
                                  <Badge variant="gray" title="Total latency in milliseconds">Latency: {r.latency_ms.toFixed(0)}ms</Badge>
                                  <Badge variant="purple" title="Estimated LLM API cost in USD">Cost: ${r.estimated_cost_usd.toFixed(4)}</Badge>
                                </div>
                                {/* Expandable retrieved chunks */}
                                {r.contexts && r.contexts.length > 0 && (() => {
                                  const key = `${q}-${label}`
                                  const expanded = expandedChunks.has(key)
                                  return (
                                    <div className="mt-1">
                                      <button
                                        className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
                                        onClick={() => toggleChunks(key)}
                                      >
                                        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                        {r.contexts.length} retrieved chunk{r.contexts.length !== 1 ? 's' : ''}
                                      </button>
                                      {expanded && (
                                        <div className="mt-1 space-y-1 border-l-2 border-slate-200 pl-2">
                                          {r.contexts.map((c, ci) => {
                                            const doc = documents.find((d) => d.id === c.doc_id)
                                            return (
                                              <div key={ci} className="text-xs bg-slate-50 rounded p-1.5 border border-slate-100">
                                                <div className="flex items-center gap-2 mb-0.5">
                                                  <span className="font-medium text-slate-500">#{ci + 1}</span>
                                                  <span className="text-blue-600 font-medium truncate max-w-[140px]" title={doc?.filename ?? c.doc_id}>
                                                    {doc?.filename ?? c.doc_id.slice(0, 8) + '…'}
                                                  </span>
                                                  <span
                                    className="text-slate-400 ml-auto shrink-0"
                                    title={
                                      r.retrieval_mode === 'lexical'
                                        ? 'BM25 term-frequency score (unnormalized, higher = more keyword overlap)'
                                        : r.retrieval_mode === 'semantic_rerank'
                                        ? 'Cross-encoder reranker score'
                                        : 'Cosine similarity (1.0 = identical, 0.0 = unrelated)'
                                    }
                                  >
                                    {r.retrieval_mode === 'lexical' ? 'bm25' : r.retrieval_mode === 'semantic_rerank' ? 'rerank' : 'sim'}: {c.score.toFixed(3)}
                                  </span>
                                                </div>
                                                <p className="text-slate-600 line-clamp-2">{c.content}</p>
                                              </div>
                                            )
                                          })}
                                        </div>
                                      )}
                                    </div>
                                  )
                                })()}
                              </div>
                            ) : (
                              <span className="text-slate-400 text-xs">—</span>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  )
                  })}

                  {/* Summary / averages row */}
                  <tr className="border-t-2 border-slate-300 bg-slate-50">
                    <td className="py-2 pr-4 text-slate-700 font-semibold text-xs">Averages</td>
                    {configLabels.map((label) => (
                      <td key={label} className="py-2 pr-4">
                        <div className="flex flex-wrap gap-1">
                          <Badge variant="blue" title="Average MRR across all questions">MRR: {avgFor(label, 'mrr').toFixed(2)}</Badge>
                          <Badge variant="blue" title="Fraction of questions where at least one relevant chunk was retrieved">Hit@K: {avgFor(label, 'hit_rate').toFixed(2)}</Badge>
                          <Badge variant="green" title="Average answer correctness vs reference answers">Correctness: {avgFor(label, 'answer_correctness').toFixed(2)}</Badge>
                          <Badge variant="yellow" title="Average faithfulness — how grounded answers are in retrieved context">Faithfulness: {avgFor(label, 'faithfulness').toFixed(2)}</Badge>
                          <Badge variant="gray" title="Average context precision">Ctx Precision: {avgFor(label, 'context_precision').toFixed(2)}</Badge>
                          <Badge variant="gray" title="Average latency per question">Latency: {avgFor(label, 'latency_ms').toFixed(0)}ms</Badge>
                          <Badge variant="purple" title="Average cost per question">Cost: ${avgFor(label, 'estimated_cost_usd').toFixed(4)}</Badge>
                        </div>
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
