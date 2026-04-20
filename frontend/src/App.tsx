import { useEffect } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Layout } from './components/Layout'
import { Dashboard } from './pages/Dashboard'
import { Ingestion } from './pages/Ingestion'
import { Playground } from './pages/Playground'
import { BenchmarkLab } from './pages/BenchmarkLab'
import { GraphExplorer } from './pages/GraphExplorer'
import { Analytics } from './pages/Analytics'
import { Settings } from './pages/Settings'
import { Agent } from './pages/Agent'
import { Connections } from './pages/Connections'
import { Logs } from './pages/Logs'
import { Runs } from './pages/Runs'
import { OrchestrationSimulator } from './pages/OrchestrationSimulator'
import { AgentWidget } from './components/AgentWidget'
import { api } from './api/client'
import { useAppStore } from './store/useAppStore'

function AppRoutes() {
  const setModels = useAppStore((s) => s.setModels)

  function fetchModels() {
    api.getModels().then(setModels).catch((err) => {
      console.error('Failed to load models:', err)
      // Retry once after 3 s (handles cold-start timing)
      setTimeout(() => {
        api.getModels().then(setModels).catch(console.error)
      }, 3000)
    })
  }

  useEffect(() => {
    fetchModels()

    // Refetch whenever the tab becomes visible — this ensures models are
    // up to date after a server restart without needing a full browser refresh
    function onVisible() {
      if (document.visibilityState === 'visible') fetchModels()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/ingest" element={<Ingestion />} />
          <Route path="/playground" element={<Playground />} />
          <Route path="/benchmark" element={<BenchmarkLab />} />
          <Route path="/graph" element={<GraphExplorer />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/agent" element={<Agent />} />
          <Route path="/orchestration/simulator" element={<OrchestrationSimulator />} />
          <Route path="/connections" element={<Connections />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="/runs" element={<Runs />} />
        </Route>
      </Routes>
      <AgentWidget />
    </>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  )
}
