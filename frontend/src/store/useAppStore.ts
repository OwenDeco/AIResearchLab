import { create } from 'zustand'
import type { ModelsInfo, Document } from '../types'

type Document_ = Document

export type ExtractProgressEntry =
  | true   // just triggered, first poll hasn't returned yet
  | { total: number; done: number; triples: number; status: 'running' | 'rate_limited'; wait_remaining_secs: number }

interface AppStore {
  models: ModelsInfo | null
  documents: Document_[]
  setModels: (m: ModelsInfo) => void
  setDocuments: (d: Document_[]) => void
  addDocument: (d: Document_) => void
  removeDocument: (id: string) => void

  // Shared active agent session — keeps Agent page and widget in sync
  activeSessionId: string | null
  setActiveSessionId: (id: string | null) => void

  // Graph extraction progress — persists across page navigation
  extractProgress: Record<string, ExtractProgressEntry>
  setExtractProgress: (updater: (prev: Record<string, ExtractProgressEntry>) => Record<string, ExtractProgressEntry>) => void

  // Dark mode
  darkMode: boolean
  toggleDarkMode: () => void
}

export const useAppStore = create<AppStore>((set) => ({
  models: null,
  documents: [],
  activeSessionId: null,
  extractProgress: {},
  darkMode: localStorage.getItem('darkMode') === 'true',

  setModels: (m) => set({ models: m }),

  setDocuments: (d) => set({ documents: d }),

  addDocument: (d) =>
    set((state) => ({ documents: [d, ...state.documents] })),

  removeDocument: (id) =>
    set((state) => ({ documents: state.documents.filter((doc) => doc.id !== id) })),

  setActiveSessionId: (id) => set({ activeSessionId: id }),

  setExtractProgress: (updater) =>
    set((state) => ({ extractProgress: updater(state.extractProgress) })),

  toggleDarkMode: () =>
    set((state) => {
      const next = !state.darkMode
      localStorage.setItem('darkMode', String(next))
      document.documentElement.classList.toggle('dark', next)
      return { darkMode: next }
    }),
}))
