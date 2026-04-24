/**
 * Parse a backend timestamp as UTC.
 * Python's datetime.utcnow().isoformat() omits the Z suffix, causing
 * JavaScript to interpret the string as local time instead of UTC.
 * Appending Z forces correct UTC parsing.
 */
export function parseUTC(ts: string): Date {
  if (!ts) return new Date(NaN)
  return new Date(ts.endsWith('Z') || ts.includes('+') ? ts : ts + 'Z')
}
