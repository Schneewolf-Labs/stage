import type { TalentConfig } from './config'
import type { EgirlEvent } from './types'

/**
 * Send one message to the talent's egirl instance and yield its stream events.
 *
 * egirl streams SSE frames (`data: {...}\n\n`) with keepalive comments while the model thinks.
 * A dropped connection ends the generator without a `done` frame; the caller treats what it
 * has as the reply, the same way egirl's own web console does.
 */
export async function* chat(talent: TalentConfig, message: string): AsyncGenerator<EgirlEvent> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (talent.egirl_token) headers.authorization = `Bearer ${talent.egirl_token}`
  const res = await fetch(`${talent.egirl_url}/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message, session_id: talent.session, stream: true }),
  })
  if (!res.ok || !res.body) throw new Error(`egirl ${talent.egirl_url}/chat -> HTTP ${res.status}`)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i: number
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i).trim()
      buf = buf.slice(i + 2)
      if (!frame.startsWith('data:')) continue
      let ev: EgirlEvent
      try {
        ev = JSON.parse(frame.slice(5).trim()) as EgirlEvent
      } catch {
        continue
      }
      yield ev
      if (ev.t === 'done' || ev.t === 'error') return
    }
  }
}

/** Ask egirl to abort the talent's in-flight turn. Best effort: an idle session is not an error. */
export async function interrupt(talent: TalentConfig): Promise<boolean> {
  const headers: Record<string, string> = {}
  if (talent.egirl_token) headers.authorization = `Bearer ${talent.egirl_token}`
  const res = await fetch(
    `${talent.egirl_url}/sessions/${encodeURIComponent(talent.session)}/interrupt`,
    {
      method: 'POST',
      headers,
    },
  ).catch(() => undefined)
  return res?.ok ?? false
}

const THINKING = ['off', 'low', 'medium', 'high'] as const
export type ThinkingLevel = (typeof THINKING)[number]
export const isThinkingLevel = (v: unknown): v is ThinkingLevel =>
  typeof v === 'string' && (THINKING as readonly string[]).includes(v)

function authHeaders(talent: TalentConfig): Record<string, string> {
  return talent.egirl_token ? { authorization: `Bearer ${talent.egirl_token}` } : {}
}

/** What the console's Brain panel shows: the instance's /info and this session's context use. */
export async function brain(
  talent: TalentConfig,
): Promise<{ ok: true; info: unknown; context: unknown } | { ok: false; error: string }> {
  try {
    const h = authHeaders(talent)
    const info = await fetch(`${talent.egirl_url}/info`, {
      headers: h,
      signal: AbortSignal.timeout(4000),
    })
    if (!info.ok) return { ok: false, error: `HTTP ${info.status}` }
    const ctx = await fetch(
      `${talent.egirl_url}/sessions/${encodeURIComponent(talent.session)}/context`,
      {
        headers: h,
        signal: AbortSignal.timeout(4000),
      },
    ).catch(() => undefined)
    return { ok: true, info: await info.json(), context: ctx?.ok ? await ctx.json() : null }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/** Set the session's thinking level through egirl; returns egirl's own reply. */
export async function setThinking(talent: TalentConfig, level: ThinkingLevel): Promise<Response> {
  return fetch(`${talent.egirl_url}/sessions/${encodeURIComponent(talent.session)}/thinking`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(talent) },
    body: JSON.stringify({ level }),
  })
}

/** Reachability for /health: cheap and bounded. */
export async function egirlUp(talent: TalentConfig): Promise<boolean> {
  return fetch(`${talent.egirl_url}/info`, {
    headers: authHeaders(talent),
    signal: AbortSignal.timeout(2000),
  })
    .then((r) => r.ok)
    .catch(() => false)
}
