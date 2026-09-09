import type { Director, Hotkey, Scene, Transform } from './persist'
import type { MouthTrack } from './voice'

/** Events egirl's `POST /chat` (stream: true) emits as SSE `data:` frames. */
export type EgirlEvent =
  | { t: 'queued'; position: number }
  | { t: 'reasoning'; v: string }
  | { t: 'token'; v: string }
  /** `calls` carries what each tool was asked to do, one line each; older egirls send only `v`. */
  | { t: 'tool'; v: string[]; calls?: ToolCallSummary[] }
  | { t: 'tool_done'; v: string; ok?: boolean }
  | {
      t: 'done'
      content?: string
      aborted?: boolean
      output_tokens?: number
      turns?: number
      /** The run parked on a question for a human (egirl's /asks); the reply is not final. */
      awaiting?: boolean
    }
  | { t: 'error'; message?: string }

export interface ToolCallSummary {
  name: string
  args: string
}

/** What the talent is doing, for body language between lines. */
export type StageState = 'idle' | 'thinking' | 'working'

export type Mood = 'neutral' | 'happy' | 'sad' | 'angry' | 'surprised'

/**
 * Cues the server pushes to browser stages over the WebSocket. Every cue is a small JSON
 * object; the page applies it to the Live2D model. `speak` clips are queued and played in
 * order on the page, so the server can send them as fast as it synthesizes.
 */
export type StageCue =
  | {
      type: 'load'
      model: string
      talent: string
      expressions: { name: string; url: string }[]
      transform: Transform
      scene: Scene
    }
  /** Placement on the canvas: fractions of the screen for x/y, scale multiplier. */
  | { type: 'transform'; x: number; y: number; scale: number }
  /** Idle motion, captions and background settings. */
  | { type: 'scene'; scene: Scene }
  | { type: 'speak'; id: string; url: string; text: string; mouth?: MouthTrack }
  | { type: 'mood'; mood: Mood }
  | { type: 'state'; state: StageState; detail?: string }
  | { type: 'gesture'; name: 'nod' | 'pose' }
  | { type: 'caption'; text: string }
  /** Cut the current clip and drop everything queued. */
  | { type: 'stop' }
  /** Pin a Cubism parameter (console sliders); `value: null` releases it. */
  | { type: 'param'; id: string; value: number | null }
  /** Show a picture on the scene's screen; `url: null` clears it. `seconds` auto-hides. */
  | { type: 'image'; url: string | null; caption?: string; seconds?: number }

/** Messages the page sends back. A console announces itself with role: 'console'. */
export type StageReport =
  | { type: 'playing'; id: string }
  | { type: 'spoke'; id: string }
  | { type: 'ready'; role?: 'console' }

/**
 * What the console sees that the render page does not: the turn as it happens, clips with
 * their timings, chat arriving. Cues are mirrored to consoles too, so the panels stay in sync.
 */
export type ConsoleEvent =
  | {
      type: 'turn'
      phase: 'start' | 'done' | 'error'
      message?: string
      reply?: string
      ms?: number
      tokens?: number
      turns?: number
      awaiting?: boolean
    }
  | { type: 'reasoning'; v: string }
  | { type: 'token'; v: string }
  | { type: 'tool'; v: string[]; calls?: ToolCallSummary[] }
  | { type: 'tool_done'; v: string; ok?: boolean }
  | { type: 'clip'; id: string; text: string; seconds: number; genMs: number }
  /** A page started / finished playing a clip. With several pages, the first report wins. */
  | { type: 'playing'; id: string }
  | { type: 'spoke'; id: string }
  | { type: 'chat'; author: string; text: string; mentioned: boolean; at: number }
  | {
      type: 'talent'
      name: string
      model: string
      voice: string
      rvc?: string
      speed: number
      pitch: number
      muted: boolean
      transform: Transform
      scene: Scene
      director: Director
      hotkeys: Hotkey[]
    }
  /** A script of lines being read: progress as each line is queued. */
  | { type: 'script'; phase: 'start' | 'line' | 'done' | 'stopped'; index?: number; total: number }
  /** The director fired its prompt. */
  | { type: 'director'; phase: 'fired' | 'skipped'; reason?: string }
  /** What the mic heard (console push-to-talk), whether or not it was sent as a turn. */
  | { type: 'transcript'; text: string; seconds: number; sent: boolean }
  | { type: 'log'; text: string }
  | { type: 'logs'; lines: string[] }

/** One viewer message from Twitch chat, filtered and ready for the batcher. */
export interface ChatLine {
  author: string
  text: string
  at: number
  /** Hit a wake word or an @nick; forces a turn instead of waiting for the next tick. */
  mentioned: boolean
}
