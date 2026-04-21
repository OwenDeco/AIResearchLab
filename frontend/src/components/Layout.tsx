import { NavLink, Outlet } from 'react-router-dom'
import {
  LayoutDashboard,
  Upload,
  Network,
  MessageSquare,
  Bot,
  Gamepad2,
  Plug,
  FlaskConical,
  BarChart3,
  Activity,
  ScrollText,
  Settings,
  Moon,
  Sun,
} from 'lucide-react'
import { useAppStore } from '../store/useAppStore'

const navGroups: Array<{
  label: string
  items: Array<{ to: string; icon: React.ElementType; label: string }>
}> = [
  {
    label: 'Overview',
    items: [
      { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
    ],
  },
  {
    label: 'Context Engineering',
    items: [
      { to: '/ingest', icon: Upload,  label: 'Ingest' },
      { to: '/graph',  icon: Network, label: 'Graph Explorer' },
    ],
  },
  {
    label: 'Orchestration & Runtime',
    items: [
      { to: '/playground', icon: MessageSquare, label: 'Runtime Playground' },
      { to: '/orchestration/simulator', icon: Gamepad2, label: 'Pixel Simulator' },
    ],
  },
  {
    label: 'Interoperability',
    items: [
      { to: '/connections', icon: Plug, label: 'Connections' },
    ],
  },
  {
    label: 'Evaluation & Benchmarking',
    items: [
      { to: '/benchmark', icon: FlaskConical, label: 'Benchmark Lab' },
    ],
  },
  {
    label: 'Governance & Observability',
    items: [
      { to: '/analytics', icon: BarChart3,  label: 'Analytics' },
      { to: '/runs',      icon: Activity,   label: 'Runs' },
      { to: '/logs',      icon: ScrollText, label: 'Logs' },
    ],
  },
  {
    label: 'Platform Configuration',
    items: [
      { to: '/agent',    icon: Bot,      label: 'System Agent' },
      { to: '/settings', icon: Settings, label: 'Settings' },
    ],
  },
]

function NavItem({ to, icon: Icon, label }: { to: string; icon: React.ElementType; label: string }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        `flex items-center gap-3 px-4 py-2.5 text-sm font-medium transition-colors ${
          isActive
            ? 'bg-slate-700 text-white'
            : 'text-slate-300 hover:bg-slate-800 hover:text-white'
        }`
      }
    >
      <Icon size={18} />
      {label}
    </NavLink>
  )
}

export function Layout() {
  const { darkMode, toggleDarkMode } = useAppStore()

  return (
    <div className="flex min-h-screen">
      {/* Fixed sidebar */}
      <aside className="fixed top-0 left-0 h-full w-60 bg-slate-900 text-white flex flex-col z-10">
        {/* Title */}
        <div className="text-white font-bold text-lg p-4 border-b border-slate-700">
          🔬 RAG Lab
        </div>

        {/* Nav groups */}
        <nav className="flex-1 py-2 overflow-y-auto">
          {navGroups.map((group, gi) => (
            <div key={gi} className={gi > 0 ? 'mt-3' : ''}>
              <p className="px-4 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-widest text-slate-500 select-none">
                {group.label}
              </p>
              {group.items.map(({ to, icon, label }) => (
                <NavItem key={to} to={to} icon={icon} label={label} />
              ))}
            </div>
          ))}
        </nav>

        <div className="px-4 py-3 border-t border-slate-700 flex items-center justify-between">
          <span className="text-xs text-slate-500">RAG Lab v1.0</span>
          <button
            onClick={toggleDarkMode}
            title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            className="p-1.5 rounded-md text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
          >
            {darkMode ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="ml-60 min-h-screen bg-slate-50 dark:bg-slate-900 p-6 flex-1 transition-colors">
        <Outlet />
      </main>
    </div>
  )
}
