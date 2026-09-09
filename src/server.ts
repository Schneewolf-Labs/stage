import { existsSync } from 'node:fs'
import { join, normalize, resolve } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { clampTransform } from '../web/core.js'
import { ChatBatcher, formatBatch } from './batcher'
import { SentenceChunker } from './chunker'
import type { StageConfig, TalentConfig } from './config'
import { startDirector } from './director'
import {
  asks,
  brain,
  compact,
  dismissAsk,
  egirlUp,
  interrupt,
  isThinkingLevel,
  replyAsk,
  reset,
  setThinking,
} from './egirl'
import { findExpressions, findModels } from './models'
import { perform, type Stage, speak } from './performer'
import {
  DIR,
  directorFrom,
  HOTKEY_ACTIONS,
  type Hotkey,
  type Overrides,
  readOverrides,
  type Scene,
  sceneFrom,
  writeOverrides,
} from './persist'
import { ScriptRunner } from './script'
import { startTwitch, type TwitchHandle } from './twitch'
import type { ConsoleEvent, StageCue, StageReport } from './types'
import { transcribe, voiceHealth } from './voice'

const WEB_DIR = resolve(import.meta.dir, '../web')
const MAX_CLIPS = 64
/** Grace after a clip's own length before we stop counting it as "still speaking". */
const SPOKE_GRACE_MS = 5000

interface Deps {
  cfg: StageConfig
  talent: TalentConfig
  log: (msg: string) => void
  /** Where per-talent overrides are written; tests point it at a temp dir. */
  overridesDir?: string
}

const LOG_BACKLOG = 200

type Role = 'page' | 'console'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Hand egirl's own answer (status and JSON body) to the console unchanged. */
async function passThrough(r: Response): Promise<Response> {
  return new Response(await r.text(), {
    status: r.status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Serve a file below `root`, refusing anything that escapes it. */
function serveUnder(root: string, rel: string): Response {
  const path = normalize(join(root, decodeURIComponent(rel)))
  if (!path.startsWith(root) || !existsSync(path)) return new Response('not found', { status: 404 })
  return new Response(Bun.file(path))
}

export function startServer({ cfg, talent, log: baseLog, overridesDir = DIR }: Deps) {
  const clients = new Map<ServerWebSocket<unknown>, Role>()
  // Log lines go to the terminal and to every console, with a backlog for late consoles.
  const backlog: string[] = []
  const log = (msg: string): void => {
    baseLog(msg)
    backlog.push(msg)
    if (backlog.length > LOG_BACKLOG) backlog.shift()
    send('console', { type: 'log', text: msg })
  }
  // Runtime state the console edits; saved whole to stage.d/<talent>.toml on every change.
  const overrides: Overrides = readOverrides(talent.name, overridesDir)
  const save = (): void => writeOverrides(talent.name, overrides, overridesDir)
  const transformFor = (model: string) => clampTransform(overrides.transforms?.[model])
  let muted = false
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
    transform: transformFor(talent.model),
    scene: sceneFrom(overrides),
  })
  const talentEvent = (): ConsoleEvent => ({
    type: 'talent',
    name: talent.name,
    model: talent.model,
    voice: talent.voice,
    ...(talent.rvc ? { rvc: talent.rvc } : {}),
    speed: talent.speed,
    pitch: talent.pitch,
    muted,
    transform: transformFor(talent.model),
    scene: sceneFrom(overrides),
    director: directorFrom(overrides),
    hotkeys: overrides.hotkeys ?? [],
  })
  const send = (role: Role | undefined, o: unknown): void => {
    const msg = JSON.stringify(o)
    for (const [ws, r] of clients) if (!role || r === role) ws.send(msg)
  }

  const stage: Stage = {
    cue: (c) => send(undefined, c),
    event: (e) => send('console', e),
    generation: () => generation,
    muted: () => muted,
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
  const script = new ScriptRunner({ speak: (chunk) => speak(opts, chunk), event: stage.event, log })
  const director = startDirector({
    get: () => directorFrom(overrides),
    isBusy: () => isBusy() || script.running,
    turn: runTurn,
    event: stage.event,
    log,
  })

  let twitch: TwitchHandle | undefined
  let batcher: ChatBatcher | undefined
  let twitchPaused = false
  let twitchReply = talent.twitch?.reply ?? false
  if (talent.twitch) {
    const tw = talent.twitch
    batcher = new ChatBatcher(
      { maxBatch: tw.max_batch, isBusy: () => isBusy() || twitchPaused },
      (lines, skipped) => {
        runTurn(formatBatch(tw.channel, lines, skipped))
          .then((reply) => twitchReply && reply && twitch?.send(reply))
          .catch((e) => log(`twitch turn failed: ${e}`))
      },
    )
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

  const presetName = (v: unknown): string | undefined =>
    typeof v === 'string' && /^[\w][\w -]{0,39}$/.test(v.trim()) ? v.trim() : undefined
  const fireHotkey = async (h: Hotkey): Promise<void> => {
    switch (h.action) {
      case 'mood':
        stage.cue({ type: 'mood', mood: h.value as 'happy' })
        return
      case 'gesture':
        stage.cue({ type: 'gesture', name: h.value as 'nod' })
        return
      case 'say':
        if (!muted) await speak(opts, h.value)
        return
      case 'preset': {
        const p = overrides.presets?.[h.value]
        if (!p) return
        overrides.transforms = { ...overrides.transforms, [talent.model]: p.transform }
        overrides.scene = p.scene
        save()
        stage.cue({ type: 'transform', ...p.transform })
        stage.cue({ type: 'scene', scene: sceneFrom(overrides) })
        stage.event(talentEvent())
        return
      }
      case 'stop':
        generation++
        script.stop()
        stage.cue({ type: 'stop' })
        return
      case 'mute':
        muted = !muted
        if (muted) stage.cue({ type: 'stop' })
        stage.event(talentEvent())
        return
    }
  }

  const health = async () => ({
    ok: true,
    talent: talent.name,
    model: talent.model,
    pages: [...clients.values()].filter((r) => r === 'page').length,
    consoles: [...clients.values()].filter((r) => r === 'console').length,
    busy: isBusy(),
    muted,
    voice: await voiceHealth(cfg.voice.url).catch((e) => ({ error: String(e) })),
    egirl: { ok: await egirlUp(talent) },
    ...(twitch && batcher
      ? {
          twitch: {
            ...twitch.stats(),
            queued: batcher.size,
            dropped: batcher.dropped,
            paused: twitchPaused,
            reply: twitchReply,
          },
        }
      : {}),
  })

  const server = Bun.serve<unknown>({
    hostname: cfg.server.host,
    port: cfg.server.port,
    // An egirl turn can think for minutes; Bun's default idle timeout is 10 s.
    idleTimeout: 255,
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
        if (path === '/presets')
          return json(Object.entries(overrides.presets ?? {}).map(([name, p]) => ({ name, ...p })))
        if (path === '/talent')
          return json({
            ...talentEvent(),
            talents: Object.keys(cfg.talents),
            twitch: !!talent.twitch,
          })
        if (path === '/egirl') return json(await brain(talent))
        if (path === '/egirl/asks') return passThrough(await asks(talent))
        return serveUnder(WEB_DIR, path)
      }
      if (req.method === 'POST' && path === '/transcribe') {
        // Raw WAV body from the console's push-to-talk. ?send=1 runs the text as a turn.
        const wav = await req.arrayBuffer()
        if (wav.byteLength <= 44) return json({ error: 'a WAV body is required' }, 400)
        const t = await transcribe(cfg.voice.url, wav).catch((e: Error) => ({ error: e.message }))
        if ('error' in t) return json(t, 502)
        const send = url.searchParams.get('send') === '1' && !!t.text.trim()
        stage.event({ type: 'transcript', text: t.text, seconds: t.seconds, sent: send })
        log(`heard (${t.seconds.toFixed(1)}s): ${t.text || '(nothing)'}`)
        if (send) runTurn(t.text).catch((e) => log(`mic turn failed: ${e}`))
        return json({ ...t, sent: send })
      }
      if (req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        if (path === '/say') {
          if (typeof body.text !== 'string' || !body.text.trim())
            return json({ error: 'text required' }, 400)
          if (muted) {
            log(`muted, skipped: ${body.text}`)
            return json({ ok: true, muted: true, sentences: 0 })
          }
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
          script.stop()
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
          overrides.model = body.model
          save()
          stage.cue(loadCue())
          stage.event(talentEvent())
          return json({ ok: true })
        }
        if (path === '/transform') {
          for (const k of ['x', 'y', 'scale'])
            if (k in body && typeof body[k] !== 'number')
              return json({ error: `${k} must be a number` }, 400)
          const t = clampTransform({ ...transformFor(talent.model), ...body })
          overrides.transforms = { ...overrides.transforms, [talent.model]: t }
          save()
          stage.cue({ type: 'transform', ...t })
          stage.event(talentEvent())
          return json({ ok: true, ...t })
        }
        if (path === '/scene') {
          const cur = sceneFrom(overrides)
          const pick = <K extends keyof Scene>(k: K): Scene[K] =>
            typeof body[k] === 'object' && body[k]
              ? { ...cur[k], ...(body[k] as Partial<Scene[K]>) }
              : cur[k]
          overrides.scene = {
            motion: pick('motion'),
            captions: pick('captions'),
            background: pick('background'),
            screen: pick('screen'),
          }
          save()
          stage.cue({ type: 'scene', scene: sceneFrom(overrides) })
          stage.event(talentEvent())
          return json({ ok: true, scene: sceneFrom(overrides) })
        }
        if (path === '/mute') {
          muted = body.on === true
          log(muted ? 'muted: the talent is silenced' : 'unmuted')
          if (muted) {
            generation++
            stage.cue({ type: 'stop' })
            for (const t of pendingSpoke.values()) clearTimeout(t)
            pendingSpoke.clear()
          }
          stage.event(talentEvent())
          return json({ ok: true, muted })
        }
        if (path === '/script') {
          const lines = Array.isArray(body.lines)
            ? body.lines.filter((l): l is string => typeof l === 'string' && !!l.trim())
            : []
          if (!lines.length)
            return json({ error: 'lines must be a non-empty list of strings' }, 400)
          if (muted) return json({ ok: true, muted: true })
          script.start(lines, typeof body.gap_ms === 'number' ? body.gap_ms : 250)
          return json({ ok: true, total: lines.length })
        }
        if (path === '/script/stop') return json({ ok: true, stopped: script.stop() })
        if (path === '/director') {
          if ('interval_s' in body && (typeof body.interval_s !== 'number' || body.interval_s <= 0))
            return json({ error: 'interval_s must be a positive number of seconds' }, 400)
          const d = directorFrom(overrides)
          overrides.director = {
            enabled: typeof body.enabled === 'boolean' ? body.enabled : d.enabled,
            interval_s: typeof body.interval_s === 'number' ? body.interval_s : d.interval_s,
            prompt: typeof body.prompt === 'string' ? body.prompt : d.prompt,
          }
          save()
          director.rearm()
          stage.event(talentEvent())
          return json({ ok: true, director: directorFrom(overrides) })
        }
        if (path === '/director/run') {
          director.fire()
          return json({ ok: true })
        }
        if (path === '/image') {
          if (!('url' in body) || (body.url !== null && typeof body.url !== 'string'))
            return json({ error: 'url required (a string, or null to clear)' }, 400)
          const cue: StageCue = {
            type: 'image',
            url: body.url as string | null,
            ...(typeof body.caption === 'string' ? { caption: body.caption } : {}),
            ...(typeof body.seconds === 'number' ? { seconds: body.seconds } : {}),
          }
          stage.cue(cue)
          return json({ ok: true })
        }
        if (path === '/twitch') {
          if (!twitch || !batcher) return json({ error: 'this talent has no [twitch] table' }, 400)
          if (typeof body.paused === 'boolean') twitchPaused = body.paused
          if (typeof body.reply === 'boolean') twitchReply = body.reply
          log(
            `twitch: ${twitchPaused ? 'paused' : 'listening'}, replies ${twitchReply ? 'on' : 'off'}`,
          )
          return json({ ok: true, paused: twitchPaused, reply: twitchReply })
        }
        if (path === '/presets') {
          const name = presetName(body.name)
          if (!name) return json({ error: 'name required: letters, digits, space, - _' }, 400)
          overrides.presets = {
            ...overrides.presets,
            [name]: { transform: transformFor(talent.model), scene: sceneFrom(overrides) },
          }
          save()
          log(`preset saved: ${name}`)
          return json({ ok: true, name })
        }
        if (path === '/presets/apply') {
          const name = presetName(body.name)
          const p = name ? overrides.presets?.[name] : undefined
          if (!p) return json({ error: 'no such preset' }, 404)
          overrides.transforms = { ...overrides.transforms, [talent.model]: p.transform }
          overrides.scene = p.scene
          save()
          stage.cue({ type: 'transform', ...p.transform })
          stage.cue({ type: 'scene', scene: sceneFrom(overrides) })
          stage.event(talentEvent())
          return json({ ok: true, name })
        }
        if (path === '/presets/delete') {
          const name = presetName(body.name)
          if (name && overrides.presets?.[name]) {
            delete overrides.presets[name]
            save()
          }
          return json({ ok: true })
        }
        if (path === '/hotkeys') {
          if (!Array.isArray(body.hotkeys)) return json({ error: 'hotkeys must be a list' }, 400)
          const list: Hotkey[] = []
          for (const h of body.hotkeys as unknown[]) {
            const k = h as Partial<Hotkey>
            if (typeof k.key !== 'string' || !k.key || !HOTKEY_ACTIONS.includes(k.action as never))
              return json(
                { error: `bad hotkey; action must be one of ${HOTKEY_ACTIONS.join(', ')}` },
                400,
              )
            list.push({
              key: k.key,
              action: k.action as Hotkey['action'],
              value: typeof k.value === 'string' ? k.value : '',
            })
          }
          overrides.hotkeys = list
          save()
          stage.event(talentEvent())
          return json({ ok: true, hotkeys: list })
        }
        if (path === '/hotkeys/fire') {
          const h = (overrides.hotkeys ?? []).find((x) => x.key === body.key)
          if (!h) return json({ error: 'no such hotkey' }, 404)
          await fireHotkey(h)
          return json({ ok: true, action: h.action })
        }
        if (path === '/egirl/thinking') {
          if (!isThinkingLevel(body.level))
            return json({ error: 'level must be off, low, medium or high' }, 400)
          return passThrough(await setThinking(talent, body.level))
        }
        if (path === '/egirl/compact') return passThrough(await compact(talent))
        if (path === '/egirl/reset') return passThrough(await reset(talent))
        if (path === '/egirl/asks/reply') {
          if (typeof body.id !== 'string' || !body.id) return json({ error: 'id required' }, 400)
          if (typeof body.reply !== 'string' || !body.reply.trim())
            return json({ error: 'reply required' }, 400)
          return passThrough(await replyAsk(talent, body.id, body.reply))
        }
        if (path === '/egirl/asks/dismiss') {
          if (typeof body.id !== 'string' || !body.id) return json({ error: 'id required' }, 400)
          return passThrough(await dismissAsk(talent, body.id))
        }
        if (path === '/voice') {
          // Live voice settings; the next sentence uses them. Not persisted to stage.toml.
          if (typeof body.voice === 'string' && body.voice) talent.voice = body.voice
          if (typeof body.speed === 'number') talent.speed = body.speed
          if (typeof body.pitch === 'number') talent.pitch = Math.round(body.pitch)
          if (body.rvc === null || body.rvc === '') delete talent.rvc
          else if (typeof body.rvc === 'string') talent.rvc = body.rvc
          Object.assign(overrides, {
            voice: talent.voice,
            rvc: talent.rvc ?? '',
            pitch: talent.pitch,
            speed: talent.speed,
          })
          save()
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
          if (role === 'console') {
            ws.send(JSON.stringify(talentEvent()))
            ws.send(JSON.stringify({ type: 'logs', lines: [...backlog] }))
          }
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
