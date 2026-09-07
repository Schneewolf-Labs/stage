import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, normalize, relative, resolve } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { ChatBatcher, formatBatch } from './batcher'
import { SentenceChunker } from './chunker'
import type { StageConfig, TalentConfig } from './config'
import { interrupt } from './egirl'
import { perform, type Stage, speak } from './performer'
import { startTwitch, type TwitchHandle } from './twitch'
import type { StageCue, StageReport } from './types'
import { voiceHealth } from './voice'

const WEB_DIR = resolve(import.meta.dir, '../web')
const MAX_CLIPS = 64
/** Grace after a clip's own length before we stop counting it as "still speaking". */
const SPOKE_GRACE_MS = 5000

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

/**
 * Expression files next to a model. VTube Studio finds `.exp3.json` by scanning the model's
 * folder (some riggers use an `Exp/` subfolder), and most commissioned model3.json files do not
 * list them, so scan rather than trust FileReferences.Expressions.
 */
function findExpressions(modelsDir: string, model: string): { name: string; url: string }[] {
  const dir = dirname(resolve(modelsDir, model))
  const out: { name: string; url: string }[] = []
  const walk = (d: string, depth: number): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory() && depth < 2) walk(p, depth + 1)
      else if (e.name.endsWith('.exp3.json'))
        out.push({
          name: e.name.replace(/\.exp3\.json$/, ''),
          url: `/models/${relative(modelsDir, p)}`,
        })
    }
  }
  if (existsSync(dir)) walk(dir, 0)
  return out
}

export function startServer({ cfg, talent, log }: Deps) {
  const clients = new Set<ServerWebSocket<unknown>>()
  const clips = new Map<string, ArrayBuffer>()
  // Clips announced but not yet reported spoken by a page; expires on its own in case no page does.
  const pendingSpoke = new Map<string, ReturnType<typeof setTimeout>>()
  let clipSeq = 0
  let inFlight = 0
  let generation = 0
  const expressions = findExpressions(cfg.server.models_dir, talent.model)
  const loadCue: StageCue = {
    type: 'load',
    model: `/models/${talent.model}`,
    talent: talent.name,
    expressions,
  }

  const stage: Stage = {
    cue(c) {
      const msg = JSON.stringify(c)
      for (const ws of clients) ws.send(msg)
    },
    generation: () => generation,
    addClip(wav, seconds) {
      const id = `${Date.now().toString(36)}-${(clipSeq++).toString(36)}`
      clips.set(id, wav)
      pendingSpoke.set(
        id,
        setTimeout(() => pendingSpoke.delete(id), seconds * 1000 + SPOKE_GRACE_MS),
      )
      // Keep memory bounded; a clip is fetched once by each page right after it is announced.
      if (clips.size > MAX_CLIPS) clips.delete(clips.keys().next().value as string)
      return { id, url: `/audio/${id}.wav` }
    },
  }
  const opts = { voiceUrl: cfg.voice.url, talent, stage, log }
  let turn: Promise<unknown> = Promise.resolve()
  // One turn at a time: the talent has one mouth. Queue behind any turn in progress.
  const runTurn = async (message: string): Promise<string> => {
    inFlight++
    const p = turn.then(() => perform(opts, message))
    turn = p.catch(() => {})
    try {
      return await p
    } finally {
      inFlight--
    }
  }
  const isBusy = (): boolean => inFlight > 0 || pendingSpoke.size > 0

  let twitch: TwitchHandle | undefined
  let batcher: ChatBatcher | undefined
  if (talent.twitch) {
    const tw = talent.twitch
    batcher = new ChatBatcher({ maxBatch: tw.max_batch, isBusy }, (lines, skipped) => {
      runTurn(formatBatch(tw.channel, lines, skipped))
        .then((reply) => tw.reply && reply && twitch?.send(reply))
        .catch((e) => log(`twitch turn failed: ${e}`))
    })
    const b = batcher
    twitch = startTwitch({ cfg: tw, onLine: (l) => b.add(l), log })
    setInterval(() => b.tick(), tw.interval_ms)
  }

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
            ...(twitch && batcher
              ? { twitch: { ...twitch.stats(), queued: batcher.size, dropped: batcher.dropped } }
              : {}),
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
          return json({ ok: true, reply: await runTurn(body.message) })
        }
        if (path === '/interrupt') {
          // Stop talking now: the page cuts audio and drops its queue, clips still synthesizing
          // are discarded when they land, and egirl is asked to abort the turn.
          generation++
          stage.cue({ type: 'stop' })
          for (const t of pendingSpoke.values()) clearTimeout(t)
          pendingSpoke.clear()
          const aborted = inFlight > 0 ? await interrupt(talent) : false
          stage.cue({ type: 'state', state: 'idle' })
          return json({ ok: true, aborted })
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
        if (r?.type === 'spoke') {
          clips.delete(r.id)
          clearTimeout(pendingSpoke.get(r.id))
          pendingSpoke.delete(r.id)
        }
      },
    },
  })
  log(`stage for ${talent.name} on http://${cfg.server.host}:${server.port}  model=${talent.model}`)
  if (expressions.length) log(`expressions: ${expressions.map((e) => e.name).join(', ')}`)
  return server
}
