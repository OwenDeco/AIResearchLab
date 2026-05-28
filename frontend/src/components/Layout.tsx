import { NavLink, Outlet } from 'react-router-dom'
import {
  LayoutDashboard,
  Upload,
  Network,
  Bot,
  Gamepad2,
  GitBranch,
  Plug,
  FlaskConical,
  BarChart3,
  Activity,
  ScrollText,
  Settings,
  Moon,
  Sun,
  ChevronLeft,
  ChevronRight,
  EyeOff,
  Eye,
} from 'lucide-react'
import { useState } from 'react'
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
      { to: '/agents', icon: Bot, label: 'Agents' },
      { to: '/flow', icon: GitBranch, label: 'Agent Flow' },
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

function NavItem({ to, icon: Icon, label, collapsed }: { to: string; icon: React.ElementType; label: string; collapsed: boolean }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        `flex items-center py-2.5 text-sm font-medium transition-colors ${
          collapsed ? 'justify-center px-0' : 'gap-3 px-4'
        } ${
          isActive
            ? 'bg-slate-700 text-white'
            : 'text-slate-300 hover:bg-slate-800 hover:text-white'
        }`
      }
    >
      <Icon size={18} />
      {!collapsed && label}
    </NavLink>
  )
}

export function Layout() {
  const { darkMode, toggleDarkMode, privacyMode, togglePrivacyMode } = useAppStore()
  const [collapsed, setCollapsed] = useState(false)

  const sidebarW = collapsed ? 'w-16' : 'w-60'
  const mainML = collapsed ? 'ml-16' : 'ml-60'

  return (
    <div className="flex min-h-screen">
      {/* Fixed sidebar */}
      <aside className={`fixed top-0 left-0 h-full ${sidebarW} bg-slate-900 text-white flex flex-col z-10 transition-all duration-200`}>
        {/* Title + collapse toggle */}
        <div className="border-b border-slate-700 flex items-center justify-between px-3 py-3 min-h-[56px]">
          {!collapsed && (
            <span className="text-white font-bold text-lg truncate">🔬 AI Systems Lab</span>
          )}
          <button
            onClick={() => setCollapsed(c => !c)}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={`p-1.5 rounded-md text-slate-400 hover:text-white hover:bg-slate-700 transition-colors flex-shrink-0 ${collapsed ? 'mx-auto' : ''}`}
          >
            {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
          </button>
        </div>

        {/* Nav groups */}
        <nav className="flex-1 py-2 overflow-y-auto overflow-x-hidden sidebar-scroll">
          {navGroups.map((group, gi) => (
            <div key={gi} className={gi > 0 ? 'mt-3' : ''}>
              {!collapsed && (
                <p className="px-4 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-widest text-slate-500 select-none">
                  {group.label}
                </p>
              )}
              {collapsed && gi > 0 && (
                <div className="mx-3 my-1.5 border-t border-slate-700" />
              )}
              {group.items.map(({ to, icon, label }) => (
                <NavItem key={to} to={to} icon={icon} label={label} collapsed={collapsed} />
              ))}
            </div>
          ))}
        </nav>

        <div className={`px-3 py-3 border-t border-slate-700 flex items-center ${collapsed ? 'flex-col gap-2 justify-center' : 'justify-between'}`}>
          {!collapsed && <span className="text-xs text-slate-500">AI Systems Lab v2.0</span>}
          <div className={`flex items-center gap-1 ${collapsed ? 'flex-col' : ''}`}>
            <button
              onClick={togglePrivacyMode}
              title={privacyMode ? 'Privacy mode ON — click to disable' : 'Enable privacy mode (screen sharing)'}
              className={`p-1.5 rounded-md transition-colors ${
                privacyMode
                  ? 'text-red-400 bg-red-900/40 hover:bg-red-900/60'
                  : 'text-slate-400 hover:text-white hover:bg-slate-700'
              }`}
            >
              {privacyMode ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
            <button
              onClick={toggleDarkMode}
              title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              className="p-1.5 rounded-md text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
            >
              {darkMode ? <Sun size={15} /> : <Moon size={15} />}
            </button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className={`${mainML} min-h-screen bg-slate-50 dark:bg-slate-900 flex-1 transition-all duration-200`}>
        {privacyMode && (
          <div className="sticky top-0 z-50 flex items-center justify-center gap-2 bg-red-600 text-white text-xs font-semibold py-1.5 px-4 shadow-md">
            <EyeOff size={13} />
            Privacy mode — sensitive values are masked
          </div>
        )}
        <div className="p-6">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
