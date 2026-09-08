import { SentenceChunker } from './chunker'
import type { ConsoleEvent } from './types'

export interface ScriptDeps {
  /** Speak one chunk (cue tags honoured). Resolves when the clip is queued. */
  speak(chunk: string): Promise<void>
  event(e: ConsoleEvent): void
  log(msg: string): void
}

/**
 * Reads a list of lines in order, a gap between them, for narration that is written ahead of
 * time (tutorials, intros). One script at a time: starting another replaces the running one.
 * Lines are split into sentences so inline cue tags land where they were written.
 */
export class ScriptRunner {
  private run = 0

  constructor(private readonly deps: ScriptDeps) {}

  get running(): boolean {
    return this.active
  }
  private active = false

  start(lines: string[], gapMs: number): void {
    const id = ++this.run
    this.active = true
    const total = lines.length
    this.deps.event({ type: 'script', phase: 'start', total })
    void (async () => {
      for (let i = 0; i < lines.length; i++) {
        if (this.run !== id) return
        this.deps.event({ type: 'script', phase: 'line', index: i, total })
        const chunker = new SentenceChunker()
        const parts = chunker.push(`${lines[i]} `)
        const rest = chunker.flush()
        if (rest) parts.push(rest)
        for (const part of parts) {
          if (this.run !== id) return
          await this.deps.speak(part).catch((e) => this.deps.log(`script line ${i} failed: ${e}`))
        }
        if (gapMs > 0 && i < lines.length - 1) await Bun.sleep(gapMs)
      }
      if (this.run === id) {
        this.active = false
        this.deps.event({ type: 'script', phase: 'done', total })
      }
    })()
  }

  stop(): boolean {
    if (!this.active) return false
    this.run++
    this.active = false
    this.deps.event({ type: 'script', phase: 'stopped', total: 0 })
    return true
  }
}
