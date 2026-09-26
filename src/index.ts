#!/usr/bin/env bun
import { copyFileSync, existsSync } from 'node:fs'
import { loadConfig, pickTalent } from './config'
import { doctor } from './doctor'
import { render } from './render'
import { startServer } from './server'
import { convert } from './voice'

const HELP = `stage -- VTuber harness for egirl agents

  bun run src/index.ts init                                          create stage.toml from the example
  bun run src/index.ts doctor [--config stage.toml]                  check models, voice service, every talent's egirl and tools
  bun run src/index.ts serve [--talent NAME] [--port N] [--config stage.toml]   run the stage server
  bun run src/index.ts say  "text" [--url http://127.0.0.1:3100]      speak a line on a running stage
  bun run src/index.ts chat "message" [--url ...]                    send a message to the talent's egirl and perform the reply
  bun run src/index.ts cue  '{"type":"mood","mood":"happy"}' [--url ...]
  bun run src/index.ts stop [--url ...]                              cut speech, drop the queue, abort the egirl turn
  bun run src/index.ts song mix.wav [--vocal vocal.wav] [--title "..."] [--url ...]
                                                                     play a finished song; the mouth follows the vocal stem
  bun run src/index.ts convert in.wav out.wav [--rvc egirl] [--pitch 12] [--config stage.toml]
                                                                     your recording, in the RVC voice (voiceovers)
  bun run src/index.ts render script.txt out.mp4 [--talent NAME] [--width 1080] [--height 1920] [--fps 30]
                        [--bg '#hex'] [--caption-size PX] [--gap-ms 250] [--chrome PATH] [--config stage.toml]
                                                                     the talent reads a script (one line per line,
                                                                     cue tags honoured) into an mp4; needs Chrome + ffmpeg

Start the voice service first: bun run voice   (services/voice/run.sh)
Then open the stage URL in a browser, or add it to OBS as a browser source.`

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const P = '\x1b[38;5;135m' // egirl purple
const K = '\x1b[38;5;198m' // egirl pink
const R = '\x1b[0m'
const log = (msg: string) => console.log(`${K}stage${R} ${P}>${R} ${msg}`)

async function post(base: string, path: string, body: unknown): Promise<void> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  console.log(await res.text())
  if (!res.ok) process.exit(1)
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv
  const base = flag(args, '--url') ?? 'http://127.0.0.1:3100'
  switch (cmd) {
    case 'init': {
      if (existsSync('stage.toml')) throw new Error('stage.toml already exists')
      copyFileSync('stage.example.toml', 'stage.toml')
      log('wrote stage.toml; edit models_dir and egirl_url, then: bun run voice && bun run serve')
      return
    }
    case 'doctor': {
      const checks = await doctor(loadConfig(flag(args, '--config')))
      const G = '\x1b[38;5;114m'
      const E = '\x1b[38;5;204m'
      for (const c of checks)
        console.log(`${c.ok ? `${G}ok ${R}` : `${E}!! ${R}`} ${c.name.padEnd(26)} ${c.detail}`)
      const bad = checks.filter((c) => !c.ok).length
      log(bad ? `${bad} problem(s)` : 'all good')
      if (bad) process.exit(1)
      return
    }
    case 'serve': {
      const cfg = loadConfig(flag(args, '--config'))
      const talent = pickTalent(cfg, flag(args, '--talent'))
      const port = flag(args, '--port')
      if (port) cfg.server.port = Number(port) // two talents = two processes on two ports
      startServer({ cfg, talent, log })
      return
    }
    case 'say':
      return post(base, '/say', { text: args[0] ?? '' })
    case 'chat':
      return post(base, '/chat', { message: args[0] ?? '' })
    case 'cue':
      return post(base, '/cue', JSON.parse(args[0] ?? '{}'))
    case 'stop':
      return post(base, '/interrupt', {})
    case 'song': {
      const [mix] = args
      if (!mix) throw new Error('usage: song mix.wav [--vocal vocal.wav] [--title "..."]')
      const form = new FormData()
      form.append('mix', Bun.file(mix), 'mix.wav')
      const vocal = flag(args, '--vocal')
      if (vocal) form.append('vocal', Bun.file(vocal), 'vocal.wav')
      form.append('title', flag(args, '--title') ?? '')
      const res = await fetch(`${base}/song`, { method: 'POST', body: form })
      console.log(await res.text())
      if (!res.ok) process.exit(1)
      return
    }
    case 'convert': {
      const [input, output] = args
      if (!input || !output)
        throw new Error('usage: convert in.wav out.wav [--rvc NAME] [--pitch N]')
      const cfg = loadConfig(flag(args, '--config'))
      const rvc = flag(args, '--rvc') ?? pickTalent(cfg).rvc
      if (!rvc) throw new Error('no RVC model: pass --rvc or set rvc on the first talent')
      const t0 = performance.now()
      const clip = await convert(
        cfg.voice.url,
        await Bun.file(input).arrayBuffer(),
        rvc,
        Number(flag(args, '--pitch') ?? 0),
      )
      await Bun.write(output, clip.wav)
      log(
        `${output}: ${clip.seconds.toFixed(1)}s of audio in ${((performance.now() - t0) / 1000).toFixed(2)}s via ${rvc}`,
      )
      return
    }
    case 'render': {
      const [script, out] = args
      if (!script || !out || script.startsWith('--') || out.startsWith('--'))
        throw new Error('usage: render script.txt out.mp4 [--talent NAME] ...')
      const cfg = loadConfig(flag(args, '--config'))
      const lines = (await Bun.file(script).text())
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      if (!lines.length) throw new Error(`${script} has no lines`)
      const n = (name: string, d: number): number => Number(flag(args, name) ?? d)
      const r = await render({
        cfg,
        talent: pickTalent(cfg, flag(args, '--talent')),
        lines,
        out,
        width: n('--width', 1080),
        height: n('--height', 1920),
        fps: n('--fps', 30),
        bg: flag(args, '--bg'),
        gapMs: n('--gap-ms', 250),
        ...(flag(args, '--caption-size') ? { captionSize: n('--caption-size', 0) } : {}),
        chrome: flag(args, '--chrome') ?? process.env.CHROME ?? 'google-chrome',
        log,
      })
      log(`${out}: ${r.seconds.toFixed(1)}s, ${r.frames} frames`)
      return
    }
    default:
      console.log(HELP)
      if (cmd && cmd !== 'help') process.exit(1)
  }
}

main(process.argv.slice(2)).catch((e: Error) => {
  console.error(`stage: ${e.message}`)
  process.exit(1)
})
