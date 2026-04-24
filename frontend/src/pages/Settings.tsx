import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { useAppStore } from '../store/useAppStore'
import { Spinner } from '../components/Spinner'
import { ErrorAlert } from '../components/ErrorAlert'
import { Eye, EyeOff, CheckCircle2, XCircle, Plus, Trash2, ChevronDown, ChevronRight, Lock } from 'lucide-react'

interface ProviderSettings {
  openai_api_key: string
  azure_api_key: string
  azure_endpoint: string
  azure_deployment: string
  ollama_base_url: string
}

interface ProviderNotes {
  openai: string
  azure: string
  ollama: string
}

type SuggestionsMap = Record<string, { configured: boolean; llms: string[]; embed_models: string[]; note?: string }>

function StatusBadge({ active }: { active: boolean }) {
  return active ? (
    <span className="inline-flex items-center gap-1 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">
      <CheckCircle2 size={11} />
      Configured
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-full px-2 py-0.5">
      <XCircle size={11} />
      Not configured
    </span>
  )
}

function SecretInput({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  const [visible, setVisible] = useState(false)
  return (
    <div className="relative">
      <input
        type={visible ? 'text' : 'password'}
        className="w-full border border-slate-300 dark:border-slate-600 rounded px-3 py-1.5 text-sm pr-9 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-400"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? 'Enter value…'}
        autoComplete="off"
        spellCheck={false}
      />
      <button
        type="button"
        className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
        onClick={() => setVisible((v) => !v)}
        tabIndex={-1}
        title={visible ? 'Hide' : 'Show'}
      >
        {visible ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-slate-600 dark:text-slate-300">{label}</label>
      {children}
      {hint && <p className="text-xs text-slate-400 dark:text-slate-400">{hint}</p>}
    </div>
  )
}

/** Collapsible suggestions panel used in both LLM and embedding cards */
function SuggestionsPanel({
  suggestions,
  type,
  onAdd,
}: {
  suggestions: SuggestionsMap
  type: 'llms' | 'embed_models'
  onAdd: (model: string) => void
}) {
  const [open, setOpen] = useState(false)

  // Collect providers that have at least one suggestion (or a note) for this type
  const providers = Object.entries(suggestions).filter(([, info]) => {
    if (info.note) return true
    return (info[type]?.length ?? 0) > 0
  })

  if (providers.length === 0) return null

  return (
    <div className="mt-3 border-t border-slate-100 dark:border-slate-700 pt-2">
      <button
        type="button"
        className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 font-medium"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        Suggestions
      </button>

      {open && (
        <div className="mt-2 space-y-3">
          {providers.map(([provider, info]) => (
            <div key={provider}>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                {provider.charAt(0).toUpperCase() + provider.slice(1)}
              </p>
              {info.note ? (
                <p className="text-xs text-slate-400 italic">{info.note}</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {(info[type] ?? []).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => onAdd(m)}
                      className="inline-flex items-center gap-1 text-xs font-mono text-blue-700 bg-blue-50 border border-blue-200 rounded-full px-2 py-0.5 hover:bg-blue-100 hover:border-blue-400 transition-colors"
                      title={`Add ${m}`}
                    >
                      <Plus size={10} />
                      {m}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function Settings() {
  const { models, setModels } = useAppStore()

  const [form, setForm] = useState<ProviderSettings>({
    openai_api_key: '',
    azure_api_key: '',
    azure_endpoint: '',
    azure_deployment: '',
    ollama_base_url: '',
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Provider notes
  const [notes, setNotes] = useState<ProviderNotes>({ openai: '', azure: '', ollama: '' })

  // Custom model lists
  const [customLlms, setCustomLlms] = useState<string[]>([])
  const [customEmbeds, setCustomEmbeds] = useState<string[]>([])
  const [newLlm, setNewLlm] = useState('')
  const [newEmbed, setNewEmbed] = useState('')
  const [savingModels, setSavingModels] = useState(false)
  const [savedModels, setSavedModels] = useState(false)

  // Suggestions (loaded once on mount, filtered server-side against current list)
  const [suggestions, setSuggestions] = useState<SuggestionsMap>({})

  // A2A / Agent settings
  const [a2aSynthesize, setA2aSynthesize] = useState(true)
  const [agentModel, setAgentModel] = useState('openai/gpt-4o')
  const [savingA2A, setSavingA2A] = useState(false)
  const [savedA2A, setSavedA2A] = useState(false)

  useEffect(() => {
    Promise.all([
      api.getProviderSettings(),
      api.getCustomModels(),
      api.getA2ASettings(),
      api.getModelSuggestions(),
      api.getProviderNotes(),
    ])
      .then(([providerSettings, customModels, a2aSettings, modelSuggestions, providerNotes]) => {
        setForm(providerSettings)
        const agentMdl = a2aSettings.agent_model
        const llms = customModels.llms.includes(agentMdl)
          ? customModels.llms
          : [agentMdl, ...customModels.llms]
        setCustomLlms(llms)
        setCustomEmbeds(customModels.embed_models)
        setA2aSynthesize(a2aSettings.a2a_synthesize)
        setAgentModel(agentMdl)
        setSuggestions(modelSuggestions)
        setNotes(providerNotes)
      })
      .catch((e) => setError(e.message ?? 'Failed to load settings'))
      .finally(() => setLoading(false))
  }, [])

  async function handleSaveA2A() {
    try {
      setSavingA2A(true)
      setError(null)
      await api.updateA2ASettings({ a2a_synthesize: a2aSynthesize, agent_model: agentModel })
      setSavedA2A(true)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to save A2A settings')
    } finally {
      setSavingA2A(false)
    }
  }

  function set(key: keyof ProviderSettings, value: string) {
    setSaved(false)
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSave() {
    try {
      setSaving(true)
      setError(null)
      await Promise.all([
        api.updateProviderSettings(form),
        api.updateProviderNotes(notes),
      ])
      setSaved(true)
      const updated = await api.getModels()
      setModels(updated)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to save settings')
    } finally {
      setSaving(false)
    }
  }

  function addLlm(model?: string) {
    const v = (model ?? newLlm).trim()
    if (!v || customLlms.includes(v)) return
    setCustomLlms((p) => [...p, v])
    if (!model) setNewLlm('')
    setSavedModels(false)
    // Remove from suggestions display
    setSuggestions((prev) => {
      const next = { ...prev }
      for (const key of Object.keys(next)) {
        next[key] = { ...next[key], llms: (next[key].llms ?? []).filter((m) => m !== v) }
      }
      return next
    })
  }

  function removeLlm(m: string) {
    setCustomLlms((p) => p.filter((x) => x !== m))
    setSavedModels(false)
  }

  function addEmbed(model?: string) {
    const v = (model ?? newEmbed).trim()
    if (!v || customEmbeds.includes(v)) return
    setCustomEmbeds((p) => [...p, v])
    if (!model) setNewEmbed('')
    setSavedModels(false)
    // Remove from suggestions display
    setSuggestions((prev) => {
      const next = { ...prev }
      for (const key of Object.keys(next)) {
        next[key] = { ...next[key], embed_models: (next[key].embed_models ?? []).filter((m) => m !== v) }
      }
      return next
    })
  }

  function removeEmbed(m: string) {
    setCustomEmbeds((p) => p.filter((x) => x !== m))
    setSavedModels(false)
  }

  async function handleSaveModels() {
    try {
      setSavingModels(true)
      setError(null)
      await api.updateCustomModels({ llms: customLlms, embed_models: customEmbeds })
      setSavedModels(true)
      // Refresh the global model list so all dropdowns update immediately
      const updated = await api.getModels()
      setModels(updated)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to save model list')
    } finally {
      setSavingModels(false)
    }
  }

  const openaiActive = !!form.openai_api_key
  const azureActive = !!(form.azure_api_key && form.azure_endpoint && form.azure_deployment)
  const ollamaActive = !!form.ollama_base_url

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold text-slate-800 dark:text-slate-100 mb-1">Settings</h1>
      <p className="text-sm text-slate-500 mb-6">
        Changes are written to <code className="bg-slate-100 px-1 rounded">.env</code> and applied immediately — no restart required.
      </p>

      {error && (
        <div className="mb-4">
          <ErrorAlert message={error} />
        </div>
      )}

      <p className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-3">Providers</p>

      <div className="space-y-4">
        {/* OpenAI */}
        <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 shadow-sm p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">OpenAI</h2>
            <StatusBadge active={openaiActive} />
          </div>
          <div className="space-y-3">
            <Field label="API Key" hint="Starts with sk-…">
              <SecretInput
                value={form.openai_api_key}
                onChange={(v) => set('openai_api_key', v)}
                placeholder="sk-…"
              />
            </Field>
            <Field label="Notes" hint="Optional — describe what this credential is for, e.g. supported models or project.">
              <textarea
                className="w-full border border-slate-300 dark:border-slate-600 rounded px-3 py-1.5 text-sm bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                rows={2}
                value={notes.openai}
                onChange={(e) => { setSaved(false); setNotes((p) => ({ ...p, openai: e.target.value })) }}
                placeholder="e.g. gpt-4o, gpt-4o-mini, text-embedding-3-small — company dev account"
              />
            </Field>
          </div>
        </div>

        {/* Azure OpenAI */}
        <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 shadow-sm p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">Azure OpenAI</h2>
            <StatusBadge active={azureActive} />
          </div>
          <div className="space-y-3">
            <Field label="API Key">
              <SecretInput
                value={form.azure_api_key}
                onChange={(v) => set('azure_api_key', v)}
              />
            </Field>
            <Field label="Endpoint" hint="e.g. https://my-resource.openai.azure.com">
              <input
                type="text"
                className="w-full border border-slate-300 dark:border-slate-600 rounded px-3 py-1.5 text-sm font-mono bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={form.azure_endpoint}
                onChange={(e) => set('azure_endpoint', e.target.value)}
                placeholder="https://…"
              />
            </Field>
            <Field label="Deployment name" hint="The name you gave the model deployment in Azure">
              <input
                type="text"
                className="w-full border border-slate-300 dark:border-slate-600 rounded px-3 py-1.5 text-sm font-mono bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={form.azure_deployment}
                onChange={(e) => set('azure_deployment', e.target.value)}
                placeholder="gpt-4o"
              />
            </Field>
            <Field label="Notes" hint="Optional — describe what this credential is for, e.g. supported models or project.">
              <textarea
                className="w-full border border-slate-300 dark:border-slate-600 rounded px-3 py-1.5 text-sm bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                rows={2}
                value={notes.azure}
                onChange={(e) => { setSaved(false); setNotes((p) => ({ ...p, azure: e.target.value })) }}
                placeholder="e.g. azure/gpt-4o deployment for production tenant"
              />
            </Field>
          </div>
        </div>

        {/* Ollama */}
        <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 shadow-sm p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">Ollama</h2>
            <StatusBadge active={ollamaActive} />
          </div>
          <div className="space-y-3">
            <Field label="Base URL">
              <input
                type="text"
                className="w-full border border-slate-300 dark:border-slate-600 rounded px-3 py-1.5 text-sm font-mono bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={form.ollama_base_url}
                onChange={(e) => set('ollama_base_url', e.target.value)}
                placeholder="http://localhost:11434"
              />
            </Field>
            <Field label="Notes" hint="Optional — describe what this credential is for, e.g. supported models or project.">
              <textarea
                className="w-full border border-slate-300 dark:border-slate-600 rounded px-3 py-1.5 text-sm bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                rows={2}
                value={notes.ollama}
                onChange={(e) => { setSaved(false); setNotes((p) => ({ ...p, ollama: e.target.value })) }}
                placeholder="e.g. local machine — llama3.3, mistral, nomic-embed-text"
              />
            </Field>
          </div>
        </div>
      </div>

      {/* Save */}
      <div className="flex items-center gap-3 mt-6">
        <button
          className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-5 py-2 text-sm font-medium disabled:opacity-50 flex items-center gap-2"
          onClick={handleSave}
          disabled={saving}
        >
          {saving && <Spinner size="sm" />}
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
        {saved && (
          <span className="text-sm text-emerald-600 flex items-center gap-1">
            <CheckCircle2 size={15} />
            Saved and applied
          </span>
        )}
      </div>

      <p className="text-xs text-slate-400 mt-4">
        Credentials only — models are managed in the Available Models section below.
      </p>

      {/* ------------------------------------------------------------------ */}
      {/* A2A / Agent                                                          */}
      {/* ------------------------------------------------------------------ */}
      <p className="text-xs font-semibold uppercase tracking-widest text-slate-400 mt-10 mb-3">Agent</p>

      <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 shadow-sm p-5 space-y-4">

        {/* Model selector */}
        <Field
          label="Agent LLM"
          hint="Model used for tool selection and response synthesis. Must support function/tool calling."
        >
          <select
            className="w-full border border-slate-300 dark:border-slate-600 rounded px-3 py-1.5 text-sm font-mono bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={agentModel}
            onChange={(e) => { setAgentModel(e.target.value); setSavedA2A(false) }}
          >
            {models?.llms.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
            {/* Always show current value even if not in list yet */}
            {models && !models.llms.includes(agentModel) && (
              <option value={agentModel}>{agentModel}</option>
            )}
          </select>
        </Field>

        {/* Synthesis toggle */}
        <div className="flex items-start justify-between gap-4 pt-1 border-t border-slate-100 dark:border-slate-700">
          <div>
            <p className="text-sm font-medium text-slate-700 dark:text-slate-200">Synthesize responses</p>
            <p className="text-xs text-slate-400 mt-0.5">
              When enabled, the agent runs a second LLM call to turn raw tool results into a natural-language answer.
              Disable when the caller has its own LLM — raw tool output is returned directly, skipping the synthesis round-trip.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={a2aSynthesize}
            onClick={() => { setA2aSynthesize((v) => !v); setSavedA2A(false) }}
            className={`relative shrink-0 inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 ${a2aSynthesize ? 'bg-blue-600' : 'bg-slate-300'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${a2aSynthesize ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3 mt-4">
        <button
          className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-5 py-2 text-sm font-medium disabled:opacity-50 flex items-center gap-2"
          onClick={handleSaveA2A}
          disabled={savingA2A}
        >
          {savingA2A && <Spinner size="sm" />}
          {savingA2A ? 'Saving…' : 'Save Agent Settings'}
        </button>
        {savedA2A && (
          <span className="text-sm text-emerald-600 flex items-center gap-1">
            <CheckCircle2 size={15} />
            Saved and applied
          </span>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Available Models                                                     */}
      {/* ------------------------------------------------------------------ */}
      <p className="text-xs font-semibold uppercase tracking-widest text-slate-400 mt-10 mb-3">Available Models</p>
      <p className="text-sm text-slate-500 mb-4">
        Everything listed here appears in every model selector in the app — Playground, Benchmark Lab, and the Agent LLM picker.
        This is the single source of truth. Built-in defaults were seeded when you first configured a provider; edit freely.
      </p>

      <div className="space-y-4">
        {/* LLMs */}
        <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 shadow-sm p-5">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">LLM models</h3>
          <div className="space-y-1 mb-3">
            {customLlms.length === 0 && (
              <p className="text-xs text-slate-400">No LLMs added yet.</p>
            )}
            {customLlms.map((m) => {
              const isDefault = m === agentModel
              return (
                <div key={m} className="flex items-center justify-between bg-slate-50 dark:bg-slate-700 rounded px-2 py-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-xs font-mono text-slate-700 dark:text-slate-200 truncate">{m}</span>
                    {isDefault && (
                      <span className="shrink-0 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-1.5 py-0.5 leading-none">
                        agent default
                      </span>
                    )}
                  </div>
                  {isDefault ? (
                    <span className="ml-2 shrink-0 text-slate-300" title="Change Agent LLM above to remove this model">
                      <Lock size={13} />
                    </span>
                  ) : (
                    <button
                      className="text-red-400 hover:text-red-600 ml-2 shrink-0"
                      onClick={() => removeLlm(m)}
                      title="Remove"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              className="flex-1 border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 text-sm font-mono bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g. openai/gpt-4.1 or ollama/gemma3"
              value={newLlm}
              onChange={(e) => setNewLlm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addLlm()}
            />
            <button
              className="bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 rounded px-3 py-1.5 text-sm flex items-center gap-1"
              onClick={() => addLlm()}
            >
              <Plus size={14} /> Add
            </button>
          </div>
          <SuggestionsPanel suggestions={suggestions} type="llms" onAdd={(m) => addLlm(m)} />
        </div>

        {/* Embedding models */}
        <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 shadow-sm p-5">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">Embedding models</h3>
          <div className="space-y-1 mb-3">
            {customEmbeds.length === 0 && (
              <p className="text-xs text-slate-400">No embedding models added yet.</p>
            )}
            {customEmbeds.map((m) => (
              <div key={m} className="flex items-center justify-between bg-slate-50 dark:bg-slate-700 rounded px-2 py-1">
                <span className="text-xs font-mono text-slate-700 dark:text-slate-200">{m}</span>
                <button
                  className="text-red-400 hover:text-red-600 ml-2"
                  onClick={() => removeEmbed(m)}
                  title="Remove"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              className="flex-1 border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 text-sm font-mono bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g. openai/text-embedding-3-small"
              value={newEmbed}
              onChange={(e) => setNewEmbed(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addEmbed()}
            />
            <button
              className="bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 rounded px-3 py-1.5 text-sm flex items-center gap-1"
              onClick={() => addEmbed()}
            >
              <Plus size={14} /> Add
            </button>
          </div>
          <SuggestionsPanel suggestions={suggestions} type="embed_models" onAdd={(m) => addEmbed(m)} />
        </div>
      </div>

      <div className="flex items-center gap-3 mt-4 mb-8">
        <button
          className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-5 py-2 text-sm font-medium disabled:opacity-50 flex items-center gap-2"
          onClick={handleSaveModels}
          disabled={savingModels}
        >
          {savingModels && <Spinner size="sm" />}
          {savingModels ? 'Saving…' : 'Save Model List'}
        </button>
        {savedModels && (
          <span className="text-sm text-emerald-600 flex items-center gap-1">
            <CheckCircle2 size={15} />
            Saved
          </span>
        )}
      </div>
    </div>
  )
}
