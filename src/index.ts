#!/usr/bin/env bun
import { loadConfig, pickTalent } from './config'
import { startServer } from './server'

const HELP = `stage -- VTuber harness for egirl agents

  bun run src/index.ts serve [--talent NAME] [--config stage.toml]   run the stage server
  bun run src/index.ts say  "text" [--url http://127.0.0.1:3100]      speak a line on a running stage
  bun run src/index.ts chat "message" [--url ...]                    send a message to the talent's egirl and perform the reply
  bun run src/index.ts cue  '{"type":"mood","mood":"happy"}' [--url ...]

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
    case 'serve': {
      const cfg = loadConfig(flag(args, '--config'))
      const talent = pickTalent(cfg, flag(args, '--talent'))
      startServer({ cfg, talent, log })
      return
    }
    case 'say':
      return post(base, '/say', { text: args[0] ?? '' })
    case 'chat':
      return post(base, '/chat', { message: args[0] ?? '' })
    case 'cue':
      return post(base, '/cue', JSON.parse(args[0] ?? '{}'))
    default:
      console.log(HELP)
      if (cmd && cmd !== 'help') process.exit(1)
  }
}

main(process.argv.slice(2)).catch((e: Error) => {
  console.error(`stage: ${e.message}`)
  process.exit(1)
})
