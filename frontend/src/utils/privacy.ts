/**
 * Censors a string by showing the first half and replacing the rest with bullets.
 * Use for single values like URLs, file paths, or keys.
 */
export function censor(value: string): string {
  if (!value) return value
  if (value.length <= 6) return '•'.repeat(value.length)
  const show = Math.ceil(value.length / 2)
  return value.slice(0, show) + '•'.repeat(value.length - show)
}

/**
 * Redacts sensitive patterns inside free-text strings (e.g. log summaries).
 * - IPv4 addresses → [IP]
 * - HTTP(S) URLs   → first-half visible + bullets
 */
export function redactSensitive(text: string): string {
  if (!text) return text
  return text
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[IP]')
    .replace(/https?:\/\/[^\s,;)"']+/g, (url) => censor(url))
}
