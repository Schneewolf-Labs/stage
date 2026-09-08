import { existsSync } from 'node:fs'
import { join, normalize, resolve } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { ChatBatcher, formatBatch } from './batcher'
import { SentenceChunker } from './chunker'
import type { StageConfig, TalentConfig } from './config'
import { interrupt } from './egirl'
import { findExpressions, findModels } from './models'
import { perform, type Stage, speak } from './performer'
import { startTwitch, type TwitchHandle } from './twitch'
import type { ConsoleEvent, StageCue, StageReport } from './types'
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

type Role = 'page' | 'console'

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
  const clients = new Map<ServerWebSocket<unknown>, Role>()
  const clips = new Map<string, ArrayBuffer>()
  // Clips announced but not yet reported spoken by a page; expires on its own in case no page does.
  const pendingSpoke = new Map<string, ReturnType<typeof setTimeout>>()
  let clipSeq = 0
  let inFlight = 0
  let generation = 0
  const loadCue = (): StageCue => ({
    type: 'load',
    model: `/models/${talent.model}`,
    talent: talent.name,
    expressions: findExpressions(cfg.server.models_dir, talent.model),
  })
  const talentEvent = (): ConsoleEvent => ({
    type: 'talent',
    name: talent.name,
    model: talent.model,
    voice: talent.voice,
    ...(talent.rvc ? { rvc: talent.rvc } : {}),
    speed: talent.speed,
    pitch: talent.pitch,
  })
  const send = (role: Role | undefined, o: unknown): void => {
    const msg = JSON.stringify(o)
    for (const [ws, r] of clients) if (!role || r === role) ws.send(msg)
  }

  const stage: Stage = {
    cue: (c) => send(undefined, c),
    event: (e) => send('console', e),
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
    twitch = startTwitch({
      cfg: tw,
      onLine: (l) => {
        b.add(l)
        stage.event({ type: 'chat', ...l })
      },
      log,
    })
    setInterval(() => b.tick(), tw.interval_ms)
  }

  const health = async () => ({
    ok: true,
    talent: talent.name,
    model: talent.model,
    pages: [...clients.values()].filter((r) => r === 'page').length,
    consoles: [...clients.values()].filter((r) => r === 'console').length,
    busy: isBusy(),
    voice: await voiceHealth(cfg.voice.url).catch((e) => ({ error: String(e) })),
    ...(twitch && batcher
      ? { twitch: { ...twitch.stats(), queued: batcher.size, dropped: batcher.dropped } }
      : {}),
  })

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
        if (path === '/console' || path === '/console/') return serveUnder(WEB_DIR, 'console.html')
        if (path.startsWith('/models/'))
          return serveUnder(cfg.server.models_dir, path.slice('/models/'.length))
        if (path.startsWith('/audio/')) {
          const wav = clips.get(path.slice('/audio/'.length).replace(/\.wav$/, ''))
          if (!wav) return json({ error: 'no such clip' }, 404)
          return new Response(wav, { headers: { 'content-type': 'audio/wav' } })
        }
        if (path === '/health') return json(await health())
        if (path === '/models.json') return json(findModels(cfg.server.models_dir))
        if (path === '/talent')
          return json({
            ...talentEvent(),
            talents: Object.keys(cfg.talents),
            twitch: !!talent.twitch,
          })
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
        if (path === '/model') {
          // Hot-swap the Live2D model on every page; the talent (egirl, voice) stays the same.
          if (
            typeof body.model !== 'string' ||
            !existsSync(resolve(cfg.server.models_dir, body.model))
          )
            return json({ error: 'model must be a path under models_dir' }, 400)
          talent.model = body.model
          stage.cue(loadCue())
          stage.event(talentEvent())
          return json({ ok: true })
        }
        if (path === '/voice') {
          // Live voice settings; the next sentence uses them. Not persisted to stage.toml.
          if (typeof body.voice === 'string' && body.voice) talent.voice = body.voice
          if (typeof body.speed === 'number') talent.speed = body.speed
          if (typeof body.pitch === 'number') talent.pitch = Math.round(body.pitch)
          if (body.rvc === null || body.rvc === '') delete talent.rvc
          else if (typeof body.rvc === 'string') talent.rvc = body.rvc
          stage.event(talentEvent())
          return json({ ok: true, ...talentEvent() })
        }
      }
      return json({ error: 'not found' }, 404)
    },
    websocket: {
      open(ws) {
        clients.set(ws, 'page')
        ws.send(JSON.stringify(loadCue()))
      },
      close(ws) {
        clients.delete(ws)
      },
      message(ws, raw) {
        let r: StageReport | undefined
        try {
          r = JSON.parse(String(raw)) as StageReport
        } catch {}
        if (r?.type === 'ready') {
          const role: Role = r.role === 'console' ? 'console' : 'page'
          clients.set(ws, role)
          if (role === 'console') ws.send(JSON.stringify(talentEvent()))
          log(`${role} connected (${clients.size})`)
        } else if (r?.type === 'playing') {
          stage.event({ type: 'playing', id: r.id })
        } else if (r?.type === 'spoke') {
          clips.delete(r.id)
          clearTimeout(pendingSpoke.get(r.id))
          pendingSpoke.delete(r.id)
          stage.event({ type: 'spoke', id: r.id })
        }
      },
    },
  })
  log(`stage for ${talent.name} on http://${cfg.server.host}:${server.port}  model=${talent.model}`)
  log(`console: http://${cfg.server.host}:${server.port}/console`)
  return server
}
