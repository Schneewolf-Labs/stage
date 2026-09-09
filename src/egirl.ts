import type { TalentConfig } from './config'
import type { EgirlEvent } from './types'

/**
 * Send one message to the talent's egirl instance and yield its stream events.
 *
 * egirl streams SSE frames (`data: {...}\n\n`) with keepalive comments while the model thinks.
 * A dropped connection ends the generator without a `run_end` frame; the caller treats what it
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
      if (ev.t === 'run_end' || ev.t === 'error') return
    }
  }
}

/** Ask egirl to abort the talent's in-flight turn. Best effort: an idle session is not an error. */
export async function interrupt(talent: TalentConfig): Promise<boolean> {
  const res = await session(talent, 'interrupt', { action: 'abort' }).catch(() => undefined)
  if (!res?.ok) return false
  const r = (await res.json().catch(() => ({}))) as { delivered?: boolean }
  return r.delivered === true
}

/**
 * One request to egirl, returned as-is so the caller can pass status and body through. A
 * network failure becomes a 502 with the error as its body.
 */
export async function egirlFetch(
  talent: TalentConfig,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${talent.egirl_url}${path}`, {
    method,
    headers: {
      ...authHeaders(talent),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  }).catch((e: Error) => new Response(JSON.stringify({ error: e.message }), { status: 502 }))
}

/** POST to one of the talent session's sub-endpoints (interrupt, compact, thinking). */
function session(talent: TalentConfig, action: string, body: unknown): Promise<Response> {
  return egirlFetch(
    talent,
    'POST',
    `/sessions/${encodeURIComponent(talent.session)}/${action}`,
    body,
  )
}

/** Compact the session's history now; egirl answers with before/after message counts. */
export function compact(talent: TalentConfig): Promise<Response> {
  return session(talent, 'compact', {})
}

/** Forget the session: egirl starts the next turn with an empty history. */
export function reset(talent: TalentConfig): Promise<Response> {
  return egirlFetch(talent, 'DELETE', `/sessions/${encodeURIComponent(talent.session)}`)
}

/** Questions the instance has parked on for a human, from every session. */
export function asks(talent: TalentConfig): Promise<Response> {
  return egirlFetch(talent, 'GET', '/asks')
}

export function replyAsk(talent: TalentConfig, id: string, reply: string): Promise<Response> {
  return egirlFetch(talent, 'POST', `/asks/${encodeURIComponent(id)}/reply`, { reply })
}

export function dismissAsk(talent: TalentConfig, id: string): Promise<Response> {
  return egirlFetch(talent, 'POST', `/asks/${encodeURIComponent(id)}/dismiss`, {})
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
export function setThinking(talent: TalentConfig, level: ThinkingLevel): Promise<Response> {
  return session(talent, 'thinking', { level })
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
