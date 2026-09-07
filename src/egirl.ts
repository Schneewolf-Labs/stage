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
