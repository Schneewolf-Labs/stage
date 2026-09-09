import { type Gesture, parseLine, SentenceChunker } from './chunker'
import type { TalentConfig } from './config'
import { chat } from './egirl'
import type { ConsoleEvent, StageCue } from './types'
import { synthesize } from './voice'

export interface Stage {
  /** Push a cue to every connected page. */
  cue(c: StageCue): void
  /** Bumped by an interrupt; a clip whose turn is older than this is dropped instead of spoken. */
  generation(): number
  /** Tell consoles what is happening. Pages never see these. */
  event(e: ConsoleEvent): void
  /** Kill switch: while muted nothing is synthesized or announced. */
  muted(): boolean
  /** Store a clip and return the URL the page fetches it from. `seconds` bounds how long it counts as speaking. */
  addClip(wav: ArrayBuffer, seconds: number): { id: string; url: string }
}

export interface PerformOptions {
  voiceUrl: string
  talent: TalentConfig
  stage: Stage
  log?: (msg: string) => void
}

/**
 * Speak one chunk of text: strip cue tags, apply moods and gestures, synthesize, enqueue.
 * Clips are synthesized in order and pushed in order; the page plays them in order.
 */
export async function speak(opts: PerformOptions, chunk: string): Promise<void> {
  const { stage, talent, voiceUrl, log } = opts
  const line = parseLine(chunk)
  for (const m of line.moods) stage.cue({ type: 'mood', mood: m })
  for (const g of line.gestures) stage.cue({ type: 'gesture', name: g satisfies Gesture })
  for (const img of line.images) stage.cue({ type: 'image', url: img.url, caption: img.caption })
  if (!line.text) return
  if (stage.muted()) {
    log?.(`muted, skipped: ${line.text}`)
    return
  }
  const t0 = performance.now()
  const gen = stage.generation()
  const clip = await synthesize(voiceUrl, talent, line.text)
  if (stage.generation() !== gen) return // interrupted while synthesizing
  const { id, url } = stage.addClip(clip.wav, clip.seconds)
  stage.cue({
    type: 'speak',
    id,
    url,
    text: line.text,
    ...(clip.mouth ? { mouth: clip.mouth } : {}),
  })
  stage.event({
    type: 'clip',
    id,
    text: line.text,
    seconds: clip.seconds,
    genMs: Math.round(performance.now() - t0),
  })
  log?.(
    `spoke ${clip.seconds.toFixed(1)}s in ${((performance.now() - t0) / 1000).toFixed(2)}s: ${line.text}`,
  )
}

/** egirl sends a tool's full arguments; the console shows them in a chip tooltip. */
const ARGS_MAX = 240
function trimArgs(args: string): string {
  return args.length > ARGS_MAX ? `${args.slice(0, ARGS_MAX - 1)}…` : args
}

/**
 * Run one egirl turn on stage. Reasoning tokens put the talent in a thinking pose, tool calls in
 * a working pose with the tool name as a caption, and answer tokens are chunked into sentences
 * and spoken as each one closes. Returns the full reply text.
 */
export async function perform(opts: PerformOptions, message: string): Promise<string> {
  const { stage, talent, log } = opts
  const chunker = new SentenceChunker()
  const t0 = performance.now()
  stage.event({ type: 'turn', phase: 'start', message })
  let reply = ''
  let thinking = false
  let cost: { tokens?: number; turns?: number; awaiting?: boolean } = {}
  let speaking = Promise.resolve()
  const say = (chunk: string) => {
    // Chain rather than await inline so the stream keeps draining while a clip synthesizes.
    speaking = speaking.then(() => speak(opts, chunk)).catch((e) => log?.(`speak failed: ${e}`))
  }
  try {
    for await (const ev of chat(talent, message)) {
      if (ev.t === 'reasoning') {
        stage.event({ type: 'reasoning', v: ev.v })
        if (!thinking) {
          thinking = true
          stage.cue({ type: 'state', state: 'thinking' })
        }
      } else if (ev.t === 'tool') {
        const names = ev.v.map((c) => c.name)
        stage.event({
          type: 'tool',
          v: names,
          calls: ev.v.map((c) => ({ name: c.name, args: trimArgs(c.args) })),
        })
        stage.cue({ type: 'state', state: 'working', detail: names.join(', ') })
      } else if (ev.t === 'tool_done') {
        stage.event({ type: 'tool_done', v: ev.v.name, ok: ev.v.success })
        stage.cue({ type: 'state', state: 'thinking', detail: `${ev.v.name} done` })
      } else if (ev.t === 'token') {
        stage.event({ type: 'token', v: ev.v })
        if (!reply) stage.cue({ type: 'state', state: 'idle' })
        reply += ev.v
        for (const s of chunker.push(ev.v)) say(s)
      } else if (ev.t === 'run_end') {
        cost = { tokens: ev.v.output_tokens, turns: ev.v.turns, awaiting: ev.v.awaiting }
        if (ev.v.content && !reply) {
          reply = ev.v.content
          for (const s of chunker.push(ev.v.content)) say(s)
        }
      } else if (ev.t === 'error') {
        throw new Error(ev.v || 'egirl stream error')
      }
    }
  } catch (e) {
    stage.event({
      type: 'turn',
      phase: 'error',
      message: String(e),
      ms: Math.round(performance.now() - t0),
    })
    throw e
  } finally {
    const rest = chunker.flush()
    if (rest) say(rest)
    await speaking
    stage.cue({ type: 'state', state: 'idle' })
  }
  const text = reply.trim()
  stage.event({
    type: 'turn',
    phase: 'done',
    reply: text,
    ms: Math.round(performance.now() - t0),
    ...cost,
  })
  return text
}
