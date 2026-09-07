import type { ChatLine } from './types'

export interface BatcherOptions {
  /** Most lines handed to egirl in one turn. */
  maxBatch: number
  /** Lines kept while waiting; beyond this the oldest unmentioned line is dropped on add. */
  maxQueue?: number
  /** A turn is in flight or the page is still speaking; hold the queue until it is not. */
  isBusy: () => boolean
}

export type BatchHandler = (lines: ChatLine[], skipped: number) => void

const DEFAULT_MAX_QUEUE = 200

/**
 * Buffers Twitch chat and releases it one turn at a time. The caller drives `tick()` on its
 * interval; a mentioned line asks for a turn right away. Both defer, never drop, while the
 * talent is busy: the lines wait for the next tick.
 *
 * A flush takes the mentioned lines and the newest of the rest, up to `maxBatch`. On a live
 * stream what chat is saying now matters more than what it said a minute ago, so the older
 * lines are discarded and the handler is told how many.
 */
export class ChatBatcher {
  private queue: ChatLine[] = []
  private readonly maxQueue: number
  /** Lines discarded over the lifetime of the batcher, for /health. */
  dropped = 0

  constructor(
    private readonly opts: BatcherOptions,
    private readonly onBatch: BatchHandler,
  ) {
    this.maxQueue = opts.maxQueue ?? DEFAULT_MAX_QUEUE
  }

  get size(): number {
    return this.queue.length
  }

  add(line: ChatLine): void {
    this.queue.push(line)
    if (this.queue.length > this.maxQueue) {
      const i = this.queue.findIndex((l) => !l.mentioned)
      this.queue.splice(i === -1 ? 0 : i, 1)
      this.dropped++
    }
    if (line.mentioned) this.flush()
  }

  tick(): void {
    this.flush()
  }

  /** Release a batch now if there is one and the talent is free. Returns whether it did. */
  flush(): boolean {
    if (this.queue.length === 0 || this.opts.isBusy()) return false
    const { maxBatch } = this.opts
    const mentioned = this.queue.filter((l) => l.mentioned).slice(-maxBatch)
    const rest = this.queue
      .filter((l) => !l.mentioned)
      .slice(-(maxBatch - mentioned.length) || Infinity)
    const picked = new Set<ChatLine>([...mentioned, ...(mentioned.length < maxBatch ? rest : [])])
    const lines = this.queue.filter((l) => picked.has(l))
    const skipped = this.queue.length - lines.length
    this.dropped += skipped
    this.queue = []
    this.onBatch(lines, skipped)
    return true
  }
}

const BATCH_HEADER =
  'Speak your reply aloud; you need not answer every line. (@you) marks lines that addressed you.'

/** One egirl message for a batch of chat. Framing only; how the talent treats chat is persona. */
export function formatBatch(channel: string, lines: ChatLine[], skipped: number): string {
  const body = lines.map((l) => `${l.author}${l.mentioned ? ' (@you)' : ''}: ${l.text}`)
  if (skipped > 0) body.push(`(${skipped} earlier line${skipped === 1 ? '' : 's'} skipped)`)
  return `[Twitch chat in #${channel}. ${BATCH_HEADER}]\n\n${body.join('\n')}`
}
