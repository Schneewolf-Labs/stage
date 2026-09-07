import { existsSync } from 'node:fs'
import { join, normalize, resolve } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { SentenceChunker } from './chunker'
import type { StageConfig, TalentConfig } from './config'
import { perform, type Stage, speak } from './performer'
import type { StageCue, StageReport } from './types'
import { voiceHealth } from './voice'

const WEB_DIR = resolve(import.meta.dir, '../web')
const MAX_CLIPS = 64

interface Deps {
  cfg: StageConfig
  talent: TalentConfig
  log: (msg: string) => void
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Serve a file below `root`, refusing anything that escapes it. */
function serveUnder(root: string, rel: string): Response {
  const path = normalize(join(root, decodeURIComponent(rel)))
  if (!path.startsWith(root) || !existsSync(path)) return new Response('not found', { status: 404 })
  return new Response(Bun.file(path))
}

export function startServer({ cfg, talent, log }: Deps) {
  const clients = new Set<ServerWebSocket<unknown>>()
  const clips = new Map<string, ArrayBuffer>()
  let clipSeq = 0
  const loadCue: StageCue = { type: 'load', model: `/models/${talent.model}`, talent: talent.name }

  const stage: Stage = {
    cue(c) {
      const msg = JSON.stringify(c)
      for (const ws of clients) ws.send(msg)
    },
    addClip(wav) {
      const id = `${Date.now().toString(36)}-${(clipSeq++).toString(36)}`
      clips.set(id, wav)
      // Keep memory bounded; a clip is fetched once by each page right after it is announced.
      if (clips.size > MAX_CLIPS) clips.delete(clips.keys().next().value as string)
      return { id, url: `/audio/${id}.wav` }
    },
  }
  const opts = { voiceUrl: cfg.voice.url, talent, stage, log }
  let turn: Promise<unknown> = Promise.resolve()

  const server = Bun.serve<unknown>({
    hostname: cfg.server.host,
    port: cfg.server.port,
    async fetch(req, srv) {
      const url = new URL(req.url)
      const path = url.pathname
      if (path === '/ws') {
        return srv.upgrade(req, { data: undefined })
          ? undefined
          : new Response('upgrade failed', { status: 400 })
      }
      if (req.method === 'GET') {
        if (path === '/' || path === '/index.html') return serveUnder(WEB_DIR, 'index.html')
        if (path.startsWith('/models/'))
          return serveUnder(cfg.server.models_dir, path.slice('/models/'.length))
        if (path.startsWith('/audio/')) {
          const wav = clips.get(path.slice('/audio/'.length).replace(/\.wav$/, ''))
          if (!wav) return json({ error: 'no such clip' }, 404)
          return new Response(wav, { headers: { 'content-type': 'audio/wav' } })
        }
        if (path === '/health') {
          const voice = await voiceHealth(cfg.voice.url).catch((e) => ({ error: String(e) }))
          return json({
            ok: true,
            talent: talent.name,
            model: talent.model,
            pages: clients.size,
            voice,
          })
        }
        return serveUnder(WEB_DIR, path)
      }
      if (req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        if (path === '/say') {
          if (typeof body.text !== 'string' || !body.text.trim())
            return json({ error: 'text required' }, 400)
          // Sentence by sentence, so inline cue tags land where they were written.
          const chunker = new SentenceChunker()
          const parts = chunker.push(`${body.text} `)
          const rest = chunker.flush()
          if (rest) parts.push(rest)
          for (const part of parts) await speak(opts, part)
          return json({ ok: true, sentences: parts.length })
        }
        if (path === '/chat') {
          if (typeof body.message !== 'string' || !body.message.trim())
            return json({ error: 'message required' }, 400)
          // One turn at a time: the talent has one mouth. Queue behind any turn in progress.
          const p = turn.then(() => perform(opts, body.message as string))
          turn = p.catch(() => {})
          const reply = await p
          return json({ ok: true, reply })
        }
        if (path === '/cue') {
          if (typeof body.type !== 'string') return json({ error: 'cue type required' }, 400)
          stage.cue(body as StageCue)
          return json({ ok: true })
        }
      }
      return json({ error: 'not found' }, 404)
    },
    websocket: {
      open(ws) {
        clients.add(ws)
        ws.send(JSON.stringify(loadCue))
        log(`page connected (${clients.size})`)
      },
      close(ws) {
        clients.delete(ws)
      },
      message(_ws, raw) {
        let r: StageReport | undefined
        try {
          r = JSON.parse(String(raw)) as StageReport
        } catch {}
        if (r?.type === 'spoke') clips.delete(r.id)
      },
    },
  })
  log(`stage for ${talent.name} on http://${cfg.server.host}:${server.port}  model=${talent.model}`)
  return server
}
