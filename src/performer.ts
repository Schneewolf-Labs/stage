import { type Gesture, parseLine, SentenceChunker } from './chunker'
import type { TalentConfig } from './config'
import { chat } from './egirl'
import type { StageCue } from './types'
import { synthesize } from './voice'

export interface Stage {
  /** Push a cue to every connected page. */
  cue(c: StageCue): void
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
  if (!line.text) return
  const t0 = performance.now()
  const clip = await synthesize(voiceUrl, talent, line.text)
  const { id, url } = stage.addClip(clip.wav, clip.seconds)
  stage.cue({ type: 'speak', id, url, text: line.text })
  log?.(
    `spoke ${clip.seconds.toFixed(1)}s in ${((performance.now() - t0) / 1000).toFixed(2)}s: ${line.text}`,
  )
}

/**
 * Run one egirl turn on stage. Reasoning tokens put the talent in a thinking pose, tool calls in
 * a working pose with the tool name as a caption, and answer tokens are chunked into sentences
 * and spoken as each one closes. Returns the full reply text.
 */
export async function perform(opts: PerformOptions, message: string): Promise<string> {
  const { stage, talent, log } = opts
  const chunker = new SentenceChunker()
  let reply = ''
  let thinking = false
  let speaking = Promise.resolve()
  const say = (chunk: string) => {
    // Chain rather than await inline so the stream keeps draining while a clip synthesizes.
    speaking = speaking.then(() => speak(opts, chunk)).catch((e) => log?.(`speak failed: ${e}`))
  }
  try {
    for await (const ev of chat(talent, message)) {
      if (ev.t === 'reasoning' && !thinking) {
        thinking = true
        stage.cue({ type: 'state', state: 'thinking' })
      } else if (ev.t === 'tool') {
        stage.cue({ type: 'state', state: 'working', detail: ev.v.join(', ') })
      } else if (ev.t === 'tool_done') {
        stage.cue({ type: 'state', state: 'thinking', detail: `${ev.v} done` })
      } else if (ev.t === 'token') {
        if (!reply) stage.cue({ type: 'state', state: 'idle' })
        reply += ev.v
        for (const s of chunker.push(ev.v)) say(s)
      } else if (ev.t === 'done') {
        if (ev.content && !reply) {
          reply = ev.content
          for (const s of chunker.push(ev.content)) say(s)
        }
      } else if (ev.t === 'error') {
        throw new Error(ev.message ?? 'egirl stream error')
      }
    }
  } finally {
    const rest = chunker.flush()
    if (rest) say(rest)
    await speaking
    stage.cue({ type: 'state', state: 'idle' })
  }
  return reply
}
