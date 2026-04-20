import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { useAppStore, type ExtractProgressEntry } from '../store/useAppStore'
import { Spinner } from '../components/Spinner'
import { ErrorAlert } from '../components/ErrorAlert'
import { Badge } from '../components/Badge'
import { Trash2, FileText, GitFork, CheckCircle2, XCircle, Loader2, X, FlaskConical } from 'lucide-react'
import type { Chunk, Document } from '../types'

type Document_ = Document

const CHUNK_STRATEGIES = [
  { value: 'fixed', label: 'Fixed Size' },
  { value: 'sliding', label: 'Sliding Window' },
  { value: 'sentence', label: 'Sentence-aware' },
  { value: 'semantic', label: 'Semantic' },
  { value: 'parent_child', label: 'Parent-Child' },
]

const CHUNKS_PER_PAGE = 10

export function Ingestion() {
  const { documents, setDocuments, addDocument, removeDocument, models, extractProgress, setExtractProgress } = useAppStore()

  // Upload form state
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [chunkStrategy, setChunkStrategy] = useState('fixed')
  const [chunkSize, setChunkSize] = useState(512)
  const [chunkOverlap, setChunkOverlap] = useState(50)
  const [embedModel, setEmbedModel] = useState('')
  const [extractGraph, setExtractGraph] = useState(false)
  const [percentileThreshold, setPercentileThreshold] = useState(95)
  const [maxChunkTokens, setMaxChunkTokens] = useState(512)
  const [uploading, setUploading] = useState(false)

  type FileStatus = { file: File; status: 'pending' | 'uploading' | 'done' | 'error'; message?: string }
  const [fileStatuses, setFileStatuses] = useState<FileStatus[]>([])

  // Document list state
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // extractProgress lives in the global store so it survives page navigation.
  // Stable ref always mirrors latest value — lets poll() read it without re-creating the callback.
  const extractProgressRef = useRef(extractProgress)
  extractProgressRef.current = extractProgress

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Clean up timer on unmount
  useEffect(() => {
    return () => { if (pollTimerRef.current) clearTimeout(pollTimerRef.current) }
  }, [])

  // Start or re-arm the polling loop. Safe to call multiple times — no-op if already scheduled.
  const schedulePoll = useCallback(() => {
    if (pollTimerRef.current) return

    const poll = async () => {
      pollTimerRef.current = null
      const ids = Object.keys(extractProgressRef.current)
      if (ids.length === 0) return

      const updates: Record<string, ExtractProgressEntry> = {}
      let anyStillRunning = false

      await Promise.all(ids.map(async (docId) => {
        const progress = await api.getExtractProgress(docId)
        if (progress !== null) {
          updates[docId] = progress
          anyStillRunning = true
        }
      }))

      const finished = ids.filter(id => !(id in updates))
      if (finished.length > 0) {
        const docs = await api.getDocuments()
        setDocuments(docs)
        setExtractProgress(prev => {
          const next = { ...prev }
          finished.forEach(id => delete next[id])
          Object.assign(next, updates)
          return next
        })
      } else if (Object.keys(updates).length > 0) {
        setExtractProgress(prev => ({ ...prev, ...updates }))
      }

      if (anyStillRunning) {
        // Poll less often when rate-limited — no point checking every 2 s during a 60 s wait
        const anyRateLimited = Object.values(extractProgressRef.current).some(
          v => v !== true && (v as any).status === 'rate_limited'
        )
        pollTimerRef.current = setTimeout(poll, anyRateLimited ? 8_000 : 2_000)
      }
    }

    pollTimerRef.current = setTimeout(poll, 500)
  }, [setDocuments, setExtractProgress])

  // On mount: if the store already has active extractions (from a previous visit), resume polling
  useEffect(() => {
    if (Object.keys(extractProgressRef.current).length > 0) schedulePoll()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Chunk inspector state
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null)
  const [chunks, setChunks] = useState<Chunk[]>([])
  const [loadingChunks, setLoadingChunks] = useState(false)
  const [chunkPage, setChunkPage] = useState(0)
  const [totalChunks, setTotalChunks] = useState(0)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragOver = useRef(false)
  const [isDragging, setIsDragging] = useState(false)

  // Sample set state
  type SampleFile = { filename: string; size_bytes: number; ext: string }
  type SampleStatus = { filename: string; status: 'pending' | 'done' | 'error'; message?: string }
  const [samples, setSamples] = useState<SampleFile[]>([])
  const [selectedSamples, setSelectedSamples] = useState<Set<string>>(new Set())
  const [sampleStatuses, setSampleStatuses] = useState<SampleStatus[]>([])
  const [ingestingSamples, setIngestingSamples] = useState(false)
  const [samplesOpen, setSamplesOpen] = useState(false)

  // Load sample list when panel is opened
  useEffect(() => {
    if (!samplesOpen || samples.length > 0) return
    api.getSamples().then(setSamples).catch(console.error)
  }, [samplesOpen, samples.length])

  // Set default embed model when models load
  useEffect(() => {
    if (models && models.embed_models.length > 0 && !embedModel) {
      setEmbedModel(models.embed_models[0])
    } else if (!embedModel) {
      setEmbedModel('openai/text-embedding-3-large')
    }
  }, [models, embedModel])

  // Load documents on mount
  useEffect(() => {
    async function load() {
      try {
        setLoading(true)
        const docs = await api.getDocuments()
        setDocuments(docs)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [setDocuments])


  // Load chunks when selected doc or page changes
  useEffect(() => {
    if (!selectedDocId) return
    async function loadChunks() {
      try {
        setLoadingChunks(true)
        const data = await api.getChunks(selectedDocId!, chunkPage + 1, CHUNKS_PER_PAGE)
        setChunks(data)
        // Try to get total from selected doc
        const doc = documents.find((d) => d.id === selectedDocId)
        if (doc) setTotalChunks(doc.chunk_count)
      } catch (err) {
        console.error(err)
      } finally {
        setLoadingChunks(false)
      }
    }
    loadChunks()
  }, [selectedDocId, chunkPage, documents])

  const SUPPORTED = ['pdf', 'txt', 'md', 'docx', 'xlsx', 'pptx', 'html', 'htm', 'csv']

  function addFiles(incoming: FileList | File[]) {
    const valid = Array.from(incoming).filter((f) =>
      SUPPORTED.includes(f.name.split('.').pop()?.toLowerCase() ?? '')
    )
    if (valid.length === 0) return
    setSelectedFiles((prev) => {
      const names = new Set(prev.map((f) => f.name))
      return [...prev, ...valid.filter((f) => !names.has(f.name))]
    })
    setFileStatuses([])
  }

  function removeFile(name: string) {
    setSelectedFiles((prev) => prev.filter((f) => f.name !== name))
    setFileStatuses((prev) => prev.filter((s) => s.file.name !== name))
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
    addFiles(e.dataTransfer.files)
  }

  async function handleUpload() {
    if (selectedFiles.length === 0) return
    setUploading(true)
    const statuses: FileStatus[] = selectedFiles.map((f) => ({ file: f, status: 'pending' }))
    setFileStatuses([...statuses])

    const opts = {
      chunk_strategy: chunkStrategy,
      chunk_size: chunkSize,
      chunk_overlap: chunkOverlap,
      embed_model: embedModel || 'openai/text-embedding-3-large',
      extract_graph: extractGraph,
      percentile_threshold: percentileThreshold,
      max_chunk_tokens: maxChunkTokens,
    }

    for (let i = 0; i < selectedFiles.length; i++) {
      const file = selectedFiles[i]
      statuses[i] = { file, status: 'uploading' }
      setFileStatuses([...statuses])
      try {
        const doc = await api.ingestDocument(file, opts)
        addDocument(doc)
        const parts = [`${doc.chunk_count} chunks`, `${doc.embedded_count ?? doc.chunk_count} embedded`]
        if (doc.embedding_errors) parts.push(`⚠ ${doc.embedding_errors} embed batch(es) failed`)
        statuses[i] = { file, status: doc.embedding_errors ? 'error' : 'done', message: parts.join(' · ') }
        if (extractGraph) { setExtractProgress(prev => ({ ...prev, [doc.id]: true })); schedulePoll() }
      } catch (err: any) {
        const msg = err?.response?.data?.detail ?? err?.message ?? 'Error'
        statuses[i] = { file, status: 'error', message: msg }
      }
      setFileStatuses([...statuses])
    }

    setUploading(false)
    // Clear files that succeeded
    const failed = statuses.filter((s) => s.status === 'error').map((s) => s.file)
    setSelectedFiles(failed)
  }

  async function handleIngestSamples() {
    if (selectedSamples.size === 0 || ingestingSamples) return
    setIngestingSamples(true)
    const filenames = [...selectedSamples]
    setSampleStatuses(filenames.map((f) => ({ filename: f, status: 'pending' })))

    const opts = {
      chunk_strategy: chunkStrategy,
      chunk_size: chunkSize,
      chunk_overlap: chunkOverlap,
      embed_model: embedModel || 'openai/text-embedding-3-large',
      extract_graph: extractGraph,
      percentile_threshold: percentileThreshold,
      max_chunk_tokens: maxChunkTokens,
    }

    // Ingest one-by-one for per-file progress feedback
    const statuses: SampleStatus[] = filenames.map((f) => ({ filename: f, status: 'pending' }))
    for (let i = 0; i < filenames.length; i++) {
      statuses[i] = { ...statuses[i], status: 'pending' }
      setSampleStatuses([...statuses])
      try {
        const docs = await api.ingestSamples([filenames[i]], opts)
        if (docs.length > 0) {
          addDocument(docs[0])
          const d = docs[0]
          const parts = [`${d.chunk_count} chunks`, `${d.embedded_count ?? d.chunk_count} embedded`]
          if (d.embedding_errors) parts.push(`⚠ ${d.embedding_errors} embed batch(es) failed`)
          statuses[i] = { filename: filenames[i], status: d.embedding_errors ? 'error' : 'done', message: parts.join(' · ') }
          if (extractGraph) { setExtractProgress(prev => ({ ...prev, [d.id]: true })); schedulePoll() }
        } else {
          statuses[i] = { filename: filenames[i], status: 'error', message: 'Not ingested' }
        }
      } catch (err: any) {
        const msg = err?.response?.data?.detail ?? err?.message ?? 'Error'
        statuses[i] = { filename: filenames[i], status: 'error', message: msg }
      }
      setSampleStatuses([...statuses])
    }

    setIngestingSamples(false)
    // Deselect successfully ingested files
    const failed = new Set(statuses.filter((s) => s.status === 'error').map((s) => s.filename))
    setSelectedSamples(failed)
  }

  async function handleDelete(docId: string) {
    try {
      await api.deleteDocument(docId)
      removeDocument(docId)
      if (selectedDocId === docId) {
        setSelectedDocId(null)
        setChunks([])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    }
  }

  function selectDoc(doc: Document_) {
    setSelectedDocId(doc.id)
    setChunkPage(0)
    setChunks([])
  }

  const selectedDoc = documents.find((d) => d.id === selectedDocId)
  const totalPages = Math.ceil(totalChunks / CHUNKS_PER_PAGE)

  function fmtBytes(n: number): string {
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
    if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
    return `${n} B`
  }

  const embedOptions = models?.embed_models ?? ['openai/text-embedding-3-small']

  return (
    <div className="max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold text-slate-800 mb-6">Document Ingestion</h1>

      {error && (
        <div className="mb-4">
          <ErrorAlert message={error} />
        </div>
      )}

      {/* Upload card */}
      <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-4 mb-6">
        <h2 className="text-xl font-semibold text-slate-800 mb-4">Upload Document</h2>

        {/* Drop zone */}
        <div
          className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer mb-4 transition-colors ${
            isDragging
              ? 'border-blue-400 bg-blue-50'
              : 'border-slate-300 hover:border-blue-400 hover:bg-slate-50'
          }`}
          onDragOver={(e) => {
            e.preventDefault()
            if (!dragOver.current) {
              dragOver.current = true
              setIsDragging(true)
            }
          }}
          onDragLeave={() => {
            dragOver.current = false
            setIsDragging(false)
          }}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <FileText className="mx-auto mb-2 text-slate-400" size={32} />
          <p className="text-slate-500">Drop files here, or click to browse</p>
          <p className="text-xs text-slate-400 mt-1">PDF · DOCX · XLSX · PPTX · TXT · MD · HTML · CSV · multiple files supported</p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.txt,.md,.docx,.xlsx,.pptx,.html,.htm,.csv"
            multiple
            className="hidden"
            onChange={(e) => e.target.files && addFiles(e.target.files)}
          />
        </div>

        {/* Config row */}
        <div className="flex flex-wrap gap-4 mb-4 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-600">Chunking Strategy</label>
            <select
              className="border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={chunkStrategy}
              onChange={(e) => setChunkStrategy(e.target.value)}
            >
              {CHUNK_STRATEGIES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          {chunkStrategy !== 'semantic' && (
            <>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-600">Chunk Size</label>
                <input
                  type="number"
                  className="border border-slate-300 rounded px-2 py-1.5 text-sm w-24 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  value={chunkSize}
                  min={64}
                  max={4096}
                  onChange={(e) => setChunkSize(Number(e.target.value))}
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-600">Chunk Overlap</label>
                <input
                  type="number"
                  className="border border-slate-300 rounded px-2 py-1.5 text-sm w-24 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  value={chunkOverlap}
                  min={0}
                  max={512}
                  onChange={(e) => setChunkOverlap(Number(e.target.value))}
                />
              </div>
            </>
          )}

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-600">Embedding Model</label>
            <select
              className="border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={embedModel}
              onChange={(e) => setEmbedModel(e.target.value)}
            >
              {embedOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-600">Extract Graph</label>
            <div className="flex items-center h-8">
              <input
                type="checkbox"
                className="w-4 h-4 accent-blue-600"
                checked={extractGraph}
                onChange={(e) => setExtractGraph(e.target.checked)}
              />
            </div>
          </div>

          {chunkStrategy === 'semantic' && (
            <>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-600">
                  Split Percentile
                  <span className="ml-1 text-slate-400 font-normal">(1–99)</span>
                </label>
                <input
                  type="number"
                  className="border border-slate-300 rounded px-2 py-1.5 text-sm w-24 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  value={percentileThreshold}
                  min={50}
                  max={99}
                  onChange={(e) => setPercentileThreshold(Number(e.target.value))}
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-600">
                  Max Chunk Tokens
                </label>
                <input
                  type="number"
                  className="border border-slate-300 rounded px-2 py-1.5 text-sm w-28 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  value={maxChunkTokens}
                  min={64}
                  max={4096}
                  onChange={(e) => setMaxChunkTokens(Number(e.target.value))}
                />
              </div>
            </>
          )}
        </div>

        {/* Selected files list */}
        {selectedFiles.length > 0 && (
          <div className="mb-4 space-y-1">
            {selectedFiles.map((f) => {
              const status = fileStatuses.find((s) => s.file.name === f.name)
              return (
                <div key={f.name} className="flex items-center gap-2 text-sm bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5">
                  {!status || status.status === 'pending' ? (
                    <FileText size={14} className="text-slate-400 flex-shrink-0" />
                  ) : status.status === 'uploading' ? (
                    <Loader2 size={14} className="text-blue-500 animate-spin flex-shrink-0" />
                  ) : status.status === 'done' ? (
                    <CheckCircle2 size={14} className="text-green-500 flex-shrink-0" />
                  ) : (
                    <XCircle size={14} className="text-red-500 flex-shrink-0" />
                  )}
                  <span className="flex-1 truncate text-slate-700">{f.name}</span>
                  {status?.message && (
                    <span className={`text-xs flex-shrink-0 ${status.status === 'error' ? 'text-red-500' : 'text-green-600'}`}>
                      {status.message}
                    </span>
                  )}
                  {(!status || status.status === 'pending' || status.status === 'error') && !uploading && (
                    <button onClick={() => removeFile(f.name)} className="text-slate-400 hover:text-slate-600 flex-shrink-0">
                      <X size={13} />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Upload button */}
        <button
          className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          onClick={handleUpload}
          disabled={selectedFiles.length === 0 || uploading}
        >
          {uploading && <Spinner size="sm" />}
          {uploading
            ? `Uploading ${fileStatuses.filter(s => s.status === 'done' || s.status === 'error').length}/${selectedFiles.length}…`
            : selectedFiles.length > 1
              ? `Upload ${selectedFiles.length} Files`
              : 'Upload Document'}
        </button>
      </div>

      {/* Sample Set */}
      <div className="bg-white rounded-lg border border-slate-200 shadow-sm mb-6">
        <button
          className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-slate-50 transition-colors rounded-lg"
          onClick={() => setSamplesOpen((v) => !v)}
        >
          <div className="flex items-center gap-2">
            <FlaskConical size={18} className="text-violet-600" />
            <span className="text-base font-semibold text-slate-800">Sample Dataset</span>
            <span className="text-xs text-slate-400 font-normal">
              {samples.length > 0 ? `${samples.length} files available` : 'Load research papers & reference docs'}
            </span>
          </div>
          <span className="text-slate-400 text-xs">{samplesOpen ? '▲' : '▼'}</span>
        </button>

        {samplesOpen && (
          <div className="px-4 pb-4 border-t border-slate-100">
            <p className="text-xs text-slate-500 mt-3 mb-3">
              These files are from the <code className="bg-slate-100 px-1 rounded">raw/</code> folder. Select the ones you want to ingest using the settings from the upload form above.
            </p>

            {samples.length === 0 ? (
              <p className="text-sm text-slate-400 py-2">No sample files found in the raw/ directory.</p>
            ) : (
              <>
                {/* Select all / none */}
                <div className="flex items-center gap-3 mb-3">
                  <button
                    className="text-xs text-blue-600 hover:underline"
                    onClick={() => setSelectedSamples(new Set(samples.map((s) => s.filename)))}
                  >
                    Select all
                  </button>
                  <span className="text-slate-300">|</span>
                  <button
                    className="text-xs text-slate-500 hover:underline"
                    onClick={() => setSelectedSamples(new Set())}
                  >
                    Deselect all
                  </button>
                  {selectedSamples.size > 0 && (
                    <span className="text-xs text-slate-500">{selectedSamples.size} selected</span>
                  )}
                </div>

                {/* File list */}
                <div className="space-y-1 max-h-72 overflow-y-auto mb-4 pr-1">
                  {samples.map((s) => {
                    const st = sampleStatuses.find((x) => x.filename === s.filename)
                    const alreadyIngested = documents.some((d) => d.filename === s.filename)
                    return (
                      <label
                        key={s.filename}
                        className={`flex items-center gap-3 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                          selectedSamples.has(s.filename)
                            ? 'border-blue-300 bg-blue-50'
                            : 'border-slate-200 hover:bg-slate-50'
                        } ${alreadyIngested ? 'opacity-60' : ''}`}
                      >
                        <input
                          type="checkbox"
                          className="accent-blue-600 flex-shrink-0"
                          checked={selectedSamples.has(s.filename)}
                          disabled={ingestingSamples}
                          onChange={(e) => {
                            setSelectedSamples((prev) => {
                              const next = new Set(prev)
                              e.target.checked ? next.add(s.filename) : next.delete(s.filename)
                              return next
                            })
                          }}
                        />
                        <FileText size={13} className="text-slate-400 flex-shrink-0" />
                        <span className="flex-1 text-sm text-slate-700 truncate" title={s.filename}>
                          {s.filename}
                        </span>
                        <span className="text-xs text-slate-400 flex-shrink-0">{fmtBytes(s.size_bytes)}</span>

                        {/* Status */}
                        {st?.status === 'pending' && (
                          <Loader2 size={13} className="text-blue-500 animate-spin flex-shrink-0" />
                        )}
                        {st?.status === 'done' && (
                          <span className="flex items-center gap-1 text-xs text-green-600 flex-shrink-0">
                            <CheckCircle2 size={13} />
                            {st.message}
                          </span>
                        )}
                        {st?.status === 'error' && (
                          <span className="flex items-center gap-1 text-xs text-red-500 flex-shrink-0" title={st.message}>
                            <XCircle size={13} />
                            error
                          </span>
                        )}
                        {!st && alreadyIngested && (
                          <span className="text-xs text-emerald-600 flex-shrink-0">ingested</span>
                        )}
                      </label>
                    )
                  })}
                </div>

                {/* Ingest button */}
                <button
                  className="flex items-center gap-2 bg-violet-600 hover:bg-violet-700 text-white rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={handleIngestSamples}
                  disabled={selectedSamples.size === 0 || ingestingSamples}
                >
                  {ingestingSamples && <Loader2 size={14} className="animate-spin" />}
                  {ingestingSamples
                    ? `Ingesting ${sampleStatuses.filter((s) => s.status === 'done' || s.status === 'error').length}/${selectedSamples.size}…`
                    : `Ingest ${selectedSamples.size > 0 ? `${selectedSamples.size} ` : ''}Selected`}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Documents table */}
      <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-4 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-slate-800">Documents</h2>
          {documents.some(d => !d.graph_extracted && !(d.id in extractProgress)) && (
            <button
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
              onClick={() => {
                const pending = documents.filter(d => !d.graph_extracted && !(d.id in extractProgress))
                pending.forEach(d => {
                  api.triggerGraphExtraction(d.id).catch(console.error)
                  setExtractProgress(prev => ({ ...prev, [d.id]: true }))
                })
                schedulePoll()
              }}
              title="Run graph extraction on all documents that haven't been extracted yet"
            >
              <GitFork size={14} />
              Extract Graph for All
            </button>
          )}
        </div>
        {loading ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : documents.length === 0 ? (
          <p className="text-slate-500 text-sm">No documents yet. Upload one above.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left py-2 pr-4 text-slate-600 font-medium">Filename</th>
                  <th className="text-left py-2 pr-4 text-slate-600 font-medium">Type</th>
                  <th className="text-left py-2 pr-4 text-slate-600 font-medium">Strategy</th>
                  <th className="text-left py-2 pr-4 text-slate-600 font-medium">Chunks</th>
                  <th className="text-left py-2 pr-4 text-slate-600 font-medium">Graph</th>
                  <th className="text-left py-2 pr-4 text-slate-600 font-medium">Uploaded</th>
                  <th className="text-left py-2 text-slate-600 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((doc) => (
                  <tr
                    key={doc.id}
                    className={`border-b border-slate-100 cursor-pointer transition-colors ${
                      selectedDocId === doc.id ? 'bg-blue-50' : 'hover:bg-slate-50'
                    }`}
                    onClick={() => selectDoc(doc)}
                  >
                    <td className="py-2 pr-4 text-slate-800 font-medium">{doc.filename}</td>
                    <td className="py-2 pr-4 text-slate-600">
                      <Badge variant="gray">{doc.file_type}</Badge>
                    </td>
                    <td className="py-2 pr-4 text-slate-600">{doc.chunk_strategy}</td>
                    <td className="py-2 pr-4 text-slate-600">{doc.chunk_count}</td>
                    <td className="py-2 pr-4">
                      {doc.id in extractProgress ? (() => {
                        const ep = extractProgress[doc.id]
                        const rateLimited = ep !== true && ep.status === 'rate_limited'
                        const label = ep === true
                          ? 'starting…'
                          : rateLimited
                            ? `rate limited — ${Math.ceil(ep.wait_remaining_secs)}s`
                            : `${ep.done}/${ep.total} chunks`
                        return (
                        <span className="inline-flex items-center gap-1.5">
                          <Loader2
                            size={11}
                            className={`animate-spin ${rateLimited ? 'text-amber-500' : 'text-blue-500'}`}
                          />
                          <span className={`text-xs ${rateLimited ? 'text-amber-600' : 'text-blue-600'}`}>
                            {label}
                          </span>
                          <button
                            className="text-slate-400 hover:text-red-500 transition-colors"
                            title="Cancel extraction"
                            onClick={(e) => {
                              e.stopPropagation()
                              api.cancelGraphExtraction(doc.id).catch(console.error)
                              setExtractProgress(prev => {
                                const next = { ...prev }
                                delete next[doc.id]
                                return next
                              })
                            }}
                          >
                            <X size={10} />
                          </button>
                        </span>
                        )
                      })() : doc.graph_extracted ? (
                        <span
                          className="inline-flex items-center gap-1 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5"
                          title="Knowledge graph extracted"
                        >
                          <GitFork size={11} />
                          yes
                        </span>
                      ) : (
                        <button
                          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 hover:underline"
                          onClick={(e) => {
                            e.stopPropagation()
                            api.triggerGraphExtraction(doc.id).catch(console.error)
                            setExtractProgress(prev => ({ ...prev, [doc.id]: true }))
                            schedulePoll()
                          }}
                          title="Run graph extraction for this document"
                        >
                          <GitFork size={11} />
                          extract
                        </button>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-slate-500">
                      {new Date(doc.created_at).toLocaleDateString()}
                    </td>
                    <td className="py-2">
                      <button
                        className="p-1 text-red-500 hover:bg-red-50 rounded"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDelete(doc.id)
                        }}
                        title="Delete document"
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Chunk Inspector */}
      {selectedDoc && (
        <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-4">
          <h2 className="text-xl font-semibold text-slate-800 mb-4">
            Chunks — {selectedDoc.filename}
          </h2>

          {loadingChunks ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : chunks.length === 0 ? (
            <p className="text-slate-500 text-sm">No chunks found.</p>
          ) : (
            <>
              <div className="space-y-3 mb-4">
                {chunks.map((chunk, idx) => (
                  <div key={chunk.id} className="border border-slate-200 rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant="blue">#{chunkPage * CHUNKS_PER_PAGE + idx + 1}</Badge>
                      <span className="text-xs text-slate-500">
                        chars {chunk.start_char}–{chunk.end_char}
                      </span>
                    </div>
                    <p className="text-sm text-slate-700 mb-2">
                      {chunk.content.length > 200
                        ? chunk.content.slice(0, 200) + '…'
                        : chunk.content}
                    </p>
                    {Object.keys(chunk.metadata_json ?? {}).length > 0 && (
                      <pre className="text-xs text-slate-500 bg-slate-50 rounded p-2 overflow-x-auto">
                        {JSON.stringify(chunk.metadata_json, null, 2)}
                      </pre>
                    )}
                  </div>
                ))}
              </div>

              {/* Pagination */}
              <div className="flex items-center gap-3">
                <button
                  className="border border-slate-300 rounded px-3 py-1 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                  disabled={chunkPage === 0}
                  onClick={() => setChunkPage((p) => p - 1)}
                >
                  Prev
                </button>
                <span className="text-sm text-slate-600">
                  Page {chunkPage + 1} of {Math.max(1, totalPages)}
                </span>
                <button
                  className="border border-slate-300 rounded px-3 py-1 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                  disabled={chunkPage >= totalPages - 1}
                  onClick={() => setChunkPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
