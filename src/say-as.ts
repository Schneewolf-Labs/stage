/** Spoken respellings: what the voice should hear for a word it mispronounces. */
export type SayAs = Record<string, string>

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Respell whole-word matches of each key, ignoring case; the longest key wins, and a straight
 * apostrophe in a key also matches a curly one. Only the text sent to TTS goes through this:
 * captions keep what the talent wrote.
 */
export function sayAs(text: string, map: SayAs | undefined): string {
  const keys = Object.keys(map ?? {}).sort((a, b) => b.length - a.length)
  if (!map || keys.length === 0) return text
  const lookup = new Map(keys.map((k) => [k.toLowerCase().replace(/’/g, "'"), map[k] ?? k]))
  const alts = keys.map((k) => escapeRe(k).replace(/'/g, "['’]"))
  const re = new RegExp(`(?<![\\w'’])(?:${alts.join('|')})(?![\\w'’])`, 'giu')
  return text.replace(re, (m) => lookup.get(m.toLowerCase().replace(/’/g, "'")) ?? m)
}
