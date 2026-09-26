import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Json = Record<string, unknown>

/** One page of a headless Chrome, driven over the DevTools protocol. */
export interface ChromePage {
  send(method: string, params?: Json): Promise<Json>
  /** Resolves on the next event of this name. */
  once(event: string): Promise<Json>
  on(event: string, fn: (params: Json) => void): void
  close(): Promise<void>
}

// What worked for WebGL on the dev box (RTX A6000); without them Chrome falls back to SwiftShader.
const GPU = [
  '--enable-gpu',
  '--use-angle=vulkan',
  '--enable-features=Vulkan',
  '--ignore-gpu-blocklist',
]

async function devtoolsUrl(stderr: ReadableStream<Uint8Array>, ms = 20000): Promise<string> {
  const reader = stderr.getReader()
  const dec = new TextDecoder()
  let text = ''
  const timer = setTimeout(() => reader.cancel(), ms)
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      text += dec.decode(value)
      const m = text.match(/DevTools listening on (ws:\/\/\S+)/)
      if (m?.[1]) return m[1]
    }
  } finally {
    clearTimeout(timer)
    reader.releaseLock()
  }
  throw new Error(`chrome did not start: ${text.trim().split('\n').slice(-3).join(' | ')}`)
}

/**
 * Start headless Chrome with a throwaway profile and attach to one blank page. `close()` kills
 * Chrome and removes the profile; call it on every path (the caller's `finally`).
 */
export async function launchChrome(
  exe: string,
  width: number,
  height: number,
): Promise<ChromePage> {
  const profile = mkdtempSync(join(tmpdir(), 'stage-chrome-'))
  const proc = Bun.spawn(
    [
      exe,
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      '--hide-scrollbars',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      ...GPU,
      'about:blank',
    ],
    { stdout: 'ignore', stderr: 'pipe' },
  )
  const close = async (): Promise<void> => {
    proc.kill()
    await proc.exited
    rmSync(profile, { recursive: true, force: true })
  }
  try {
    const ws = new WebSocket(await devtoolsUrl(proc.stderr))
    await new Promise((res, rej) => {
      ws.onopen = res
      ws.onerror = () => rej(new Error('could not connect to chrome devtools'))
    })
    let seq = 0
    const pending = new Map<number, { res: (v: Json) => void; rej: (e: Error) => void }>()
    const listeners = new Map<string, ((p: Json) => void)[]>()
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as {
        id?: number
        result?: Json
        error?: { message: string }
        method?: string
        params?: Json
      }
      if (m.id !== undefined) {
        const p = pending.get(m.id)
        pending.delete(m.id)
        if (m.error) p?.rej(new Error(m.error.message))
        else p?.res(m.result ?? {})
      } else if (m.method) for (const fn of listeners.get(m.method) ?? []) fn(m.params ?? {})
    }
    const raw = (method: string, params: Json = {}, sessionId?: string): Promise<Json> =>
      new Promise((res, rej) => {
        const id = ++seq
        pending.set(id, { res, rej })
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      })
    const { targetId } = await raw('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await raw('Target.attachToTarget', { targetId, flatten: true })
    const on = (event: string, fn: (p: Json) => void): void => {
      listeners.set(event, [...(listeners.get(event) ?? []), fn])
    }
    return {
      send: (method, params) => raw(method, params, sessionId as string),
      on,
      once: (event) =>
        new Promise((res) => {
          const fn = (p: Json): void => {
            listeners.set(
              event,
              (listeners.get(event) ?? []).filter((f) => f !== fn),
            )
            res(p)
          }
          on(event, fn)
        }),
      close: async () => {
        ws.close()
        await close()
      },
    }
  } catch (e) {
    await close()
    throw e
  }
}
