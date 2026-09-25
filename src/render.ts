import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clampTransform } from '../web/core.js'
import { launchChrome } from './cdp'
import { SentenceChunker } from './chunker'
import type { StageConfig, TalentConfig } from './config'
import { findExpressions } from './models'
import { type Stage, speak } from './performer'
import { readOverrides, sceneFrom } from './persist'
import { type Reel, ReelBuilder } from './reel'
import { serveUnder, WEB_DIR } from './server'

export interface RenderOptions {
  cfg: StageConfig
  talent: TalentConfig
  lines: string[]
  out: string
  width: number
  height: number
  fps: number
  /** Background colour; without one the page paints its brand background. */
  bg?: string
  gapMs: number
  chrome: string
  log: (msg: string) => void
}

/** Speak every line through the same path as /script (tags, chunking, synthesis) onto one reel. */
export async function buildReel(
  voiceUrl: string,
  talent: TalentConfig,
  lines: string[],
  gapMs: number,
  log?: (msg: string) => void,
): Promise<{ reel: Reel; wav: Uint8Array }> {
  const r = new ReelBuilder(0.4)
  let wav: ArrayBuffer | undefined
  const stage: Stage = {
    cue: (c) => {
      if (c.type !== 'speak') return r.cue(c)
      if (wav) r.clip(wav, c.text, c.mouth)
    },
    event: () => {},
    generation: () => 0,
    muted: () => false,
    addClip: (w) => {
      wav = w
      return { id: 'reel', url: '' }
    },
  }
  for (const [i, line] of lines.entries()) {
    const chunker = new SentenceChunker()
    const parts = chunker.push(`${line} `)
    const rest = chunker.flush()
    if (rest) parts.push(rest)
    for (const part of parts) await speak({ voiceUrl, talent, stage, log }, part)
    if (i < lines.length - 1) r.gap(gapMs / 1000)
  }
  return r.build(0.8)
}

/** `stage render`: a script read by the talent, recorded to an mp4 without OBS. */
export async function render(o: RenderOptions): Promise<{ seconds: number; frames: number }> {
  const { cfg, talent, log } = o
  log(`synthesizing ${o.lines.length} line(s)`)
  const { reel, wav } = await buildReel(cfg.voice.url, talent, o.lines, o.gapMs, log)
  const overrides = readOverrides(talent.name)
  const scene = sceneFrom(overrides)
  if (o.bg) scene.background = { ...scene.background, color: o.bg }
  const page = {
    ...reel,
    fps: o.fps,
    load: {
      model: `/models/${talent.model}`,
      expressions: findExpressions(cfg.server.models_dir, talent.model),
      transform: clampTransform(overrides.transforms?.[talent.model]),
      scene,
    },
  }
  const tmp = mkdtempSync(join(tmpdir(), 'stage-render-'))
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path === '/reel.json') return Response.json(page)
      if (path === '/') return serveUnder(WEB_DIR, 'index.html')
      if (path.startsWith('/models/'))
        return serveUnder(cfg.server.models_dir, path.slice('/models/'.length))
      return serveUnder(WEB_DIR, path)
    },
  })
  let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined
  try {
    const audio = join(tmp, 'reel.wav')
    await Bun.write(audio, wav)
    chrome = await launchChrome(o.chrome, o.width, o.height)
    chrome.on('Runtime.exceptionThrown', (p) =>
      log(`page error: ${JSON.stringify(p.exceptionDetails)}`),
    )
    await chrome.send('Emulation.setDeviceMetricsOverride', {
      width: o.width,
      height: o.height,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await chrome.send('Page.enable')
    await chrome.send('Runtime.enable')
    const loaded = chrome.once('Page.loadEventFired')
    const opaque = scene.background.color || scene.background.image ? '' : '&bg=1'
    await chrome.send('Page.navigate', {
      url: `http://127.0.0.1:${server.port}/?render=1&status=0${opaque}`,
    })
    await loaded
    const evaluate = async (expression: string): Promise<unknown> => {
      const r = await chrome?.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })
      const ex = r?.exceptionDetails as
        | { exception?: { description?: string }; text?: string }
        | undefined
      if (ex) throw new Error(`page: ${ex.exception?.description ?? ex.text}`)
      return (r?.result as { value?: unknown } | undefined)?.value
    }
    const info = await evaluate(
      "fetch('/reel.json').then((r) => r.json()).then((r) => window.stage.renderInit(r))",
    )
    log(`page ready: ${JSON.stringify(info)}`)

    const frames = Math.ceil(reel.duration * o.fps)
    const ff = Bun.spawn(
      [
        'ffmpeg',
        '-y',
        '-loglevel',
        'error',
        '-f',
        'image2pipe',
        '-framerate',
        String(o.fps),
        '-i',
        '-',
        '-i',
        audio,
        '-t',
        reel.duration.toFixed(3),
        '-c:v',
        'libx264',
        '-preset',
        'medium',
        '-crf',
        '18',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-movflags',
        '+faststart',
        o.out,
      ],
      { stdin: 'pipe', stderr: 'inherit' },
    )
    const t0 = performance.now()
    for (let f = 0; f < frames; f++) {
      await evaluate(`window.stage.renderFrame(${f / o.fps})`)
      const shot = await chrome.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 })
      ff.stdin.write(Buffer.from(shot.data as string, 'base64'))
      if (f % (o.fps * 5) === 0)
        log(`frame ${f}/${frames}  ${((performance.now() - t0) / 1000).toFixed(0)}s`)
    }
    ff.stdin.end()
    if ((await ff.exited) !== 0) throw new Error('ffmpeg failed')
    return { seconds: reel.duration, frames }
  } finally {
    await chrome?.close()
    server.stop(true)
    rmSync(tmp, { recursive: true, force: true })
  }
}
