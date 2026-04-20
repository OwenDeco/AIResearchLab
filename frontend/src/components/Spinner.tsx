export function Spinner({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const s = { sm: 'w-4 h-4', md: 'w-6 h-6', lg: 'w-10 h-10' }[size]
  return (
    <div
      className={`${s} border-2 border-blue-600 border-t-transparent rounded-full animate-spin`}
    />
  )
}
