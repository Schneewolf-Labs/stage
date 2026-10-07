import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'smol-toml'
import { clampBox, cleanFrames, legacyScreenBox } from '../web/core.js'
import type { TalentConfig } from './config'

/** Per-model placement on the 1920x1080 canvas: offsets as a fraction of the canvas, scale x. */
export interface Transform {
  x: number
  y: number
  scale: number
}

/** A widget's place: top-left corner and size, as fractions of the canvas (0..1). */
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** A web page in a box on the scene: a gallery, a chat embed, a now-playing panel. */
export interface Frame extends Box {
  id: string
  url: string
  show: boolean
}

export interface Scene {
  /**
   * Idle motion: sway amplitude and speed multipliers, blink interval seconds, and a dance
   * tempo (beats per minute, 0 = off) that bobs the head on the beat while music plays.
   */
  motion: { sway: number; speed: number; blink: number; bpm: number }
  /** The spoken line, at the bottom of its box. */
  captions: Box & { show: boolean; size: number }
  /** Colour, and/or an image path under models_dir (served at /models/) or a URL. */
  background: { color: string; image: string }
  /** Where pictures the talent shows go; a picture fits inside the box. */
  screen: Box & { show: boolean }
  frames: Frame[]
}

/** The director prompts the talent on a cadence while it is idle: game commentary, check-ins. */
export interface Director {
  enabled: boolean
  interval_s: number
  prompt: string
}

/**
 * What the console changes at runtime and expects to survive a restart. Lives in
 * `stage.d/<talent>.toml` (gitignored) so stage.toml, the human-written file, is never rewritten.
 * Loaded on top of the talent's config; written whole on every change (it is tiny).
 */
/** A named snapshot of how the stage looks: placement of the current model and the scene. */
export interface Preset {
  transform: Transform
  scene: Scene
}

export type HotkeyAction = 'mood' | 'gesture' | 'say' | 'preset' | 'stop' | 'mute'
export const HOTKEY_ACTIONS: readonly HotkeyAction[] = [
  'mood',
  'gesture',
  'say',
  'preset',
  'stop',
  'mute',
]

/** A console key bound to an action; `value` is the mood, gesture, line or preset name. */
export interface Hotkey {
  key: string
  action: HotkeyAction
  value: string
}

export interface Overrides {
  voice?: string
  rvc?: string | null
  pitch?: number
  speed?: number
  model?: string
  transforms?: Record<string, Transform>
  scene?: {
    motion?: Partial<Scene['motion']>
    captions?: Partial<Scene['captions']>
    background?: Partial<Scene['background']>
    /** A box, or { x, y, w } (centre in -1..1) as saved before widgets. */
    screen?: Partial<Scene['screen']>
    frames?: Frame[]
  }
  director?: Partial<Director>
  presets?: Record<string, Preset>
  hotkeys?: Hotkey[]
}

export const DEFAULT_SCENE: Scene = {
  motion: { sway: 1, speed: 1, blink: 3.7, bpm: 0 },
  captions: { show: true, size: 22, x: 0.15, y: 0.78, w: 0.7, h: 0.16 },
  background: { color: '', image: '' },
  screen: { ...legacyScreenBox({ x: -0.55, y: -0.15, w: 0.4 }), show: true },
  frames: [],
}

export const DEFAULT_DIRECTOR: Director = {
  enabled: false,
  interval_s: 45,
  prompt:
    'You are live. Take a screenshot if you can see the screen, and say one short line about what is happening now. If nothing changed, say nothing.',
}

export const DIR = 'stage.d'

const fileFor = (name: string, dir: string): string => join(dir, `${name}.toml`)

export function readOverrides(name: string, dir = DIR): Overrides {
  const f = fileFor(name, dir)
  if (!existsSync(f)) return {}
  try {
    return parse(readFileSync(f, 'utf8')) as Overrides
  } catch (e) {
    console.error(`stage: ignoring unreadable ${f}: ${e}`)
    return {}
  }
}

export function writeOverrides(name: string, o: Overrides, dir = DIR): void {
  mkdirSync(dir, { recursive: true })
  // TOML cannot hold null; "rvc off" is stored as the empty string.
  const clean = JSON.parse(JSON.stringify({ ...o, rvc: o.rvc === null ? '' : o.rvc }))
  writeFileSync(
    fileFor(name, dir),
    `# Written by the Stage console. Overrides [talents.${name}] in stage.toml; delete to reset.\n${stringify(clean)}`,
  )
}

/** Apply saved overrides to a freshly loaded talent. */
export function applyOverrides(t: TalentConfig, o: Overrides): void {
  if (o.voice) t.voice = o.voice
  if (o.rvc === '' || o.rvc === null) delete t.rvc
  else if (o.rvc) t.rvc = o.rvc
  if (typeof o.pitch === 'number') t.pitch = o.pitch
  if (typeof o.speed === 'number') t.speed = o.speed
  if (o.model) t.model = o.model
}

/** A dance tempo: 0 (or anything not positive) is off; otherwise held to 40..220 bpm. */
export function clampBpm(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return 0
  return Math.min(220, Math.max(40, v))
}

function screenFrom(s: Partial<Scene['screen']> | undefined): Scene['screen'] {
  const show = s?.show ?? true
  if (s && s.h === undefined && (s.x !== undefined || s.y !== undefined || s.w !== undefined))
    return { ...legacyScreenBox({ x: -0.55, y: -0.15, w: 0.4, ...s }), show }
  return { ...clampBox({ ...DEFAULT_SCENE.screen, ...s }, DEFAULT_SCENE.screen), show }
}

export function sceneFrom(o: Overrides): Scene {
  const motion = { ...DEFAULT_SCENE.motion, ...o.scene?.motion }
  return {
    motion: { ...motion, bpm: clampBpm(motion.bpm) },
    captions: {
      show: o.scene?.captions?.show ?? DEFAULT_SCENE.captions.show,
      size: o.scene?.captions?.size ?? DEFAULT_SCENE.captions.size,
      ...clampBox({ ...DEFAULT_SCENE.captions, ...o.scene?.captions }, DEFAULT_SCENE.captions),
    },
    background: { ...DEFAULT_SCENE.background, ...o.scene?.background },
    screen: screenFrom(o.scene?.screen),
    frames: cleanFrames(o.scene?.frames ?? []),
  }
}

export function directorFrom(o: Overrides): Director {
  return { ...DEFAULT_DIRECTOR, ...o.director }
}
