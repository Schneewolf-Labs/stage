/** Events egirl's `POST /chat` (stream: true) emits as SSE `data:` frames. */
export type EgirlEvent =
  | { t: 'queued'; position: number }
  | { t: 'reasoning'; v: string }
  | { t: 'token'; v: string }
  | { t: 'tool'; v: string[] }
  | { t: 'tool_done'; v: string }
  | { t: 'done'; content?: string; aborted?: boolean }
  | { t: 'error'; message?: string }

/** What the talent is doing, for body language between lines. */
export type StageState = 'idle' | 'thinking' | 'working'

export type Mood = 'neutral' | 'happy' | 'sad' | 'angry' | 'surprised'

/**
 * Cues the server pushes to browser stages over the WebSocket. Every cue is a small JSON
 * object; the page applies it to the Live2D model. `speak` clips are queued and played in
 * order on the page, so the server can send them as fast as it synthesizes.
 */
export type StageCue =
  | { type: 'load'; model: string; talent: string; expressions: { name: string; url: string }[] }
  | { type: 'speak'; id: string; url: string; text: string }
  | { type: 'mood'; mood: Mood }
  | { type: 'state'; state: StageState; detail?: string }
  | { type: 'gesture'; name: 'nod' | 'pose' }
  | { type: 'caption'; text: string }

/** Messages the page sends back. */
export type StageReport = { type: 'spoke'; id: string } | { type: 'ready' }

/** One viewer message from Twitch chat, filtered and ready for the batcher. */
export interface ChatLine {
  author: string
  text: string
  at: number
  /** Hit a wake word or an @nick; forces a turn instead of waiting for the next tick. */
  mentioned: boolean
}
