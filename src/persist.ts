import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'smol-toml'
import type { TalentConfig } from './config'

/** Per-model placement on the 1920x1080 canvas: offsets as a fraction of the canvas, scale x. */
export interface Transform {
  x: number
  y: number
  scale: number
}

export interface Scene {
  /** Idle motion: sway amplitude and speed multipliers, blink interval seconds. */
  motion: { sway: number; speed: number; blink: number }
  captions: { show: boolean; size: number }
  /** Colour, and/or an image path under models_dir (served at /models/) or a URL. */
  background: { color: string; image: string }
  /** Where pictures the talent shows go: centre as screen fractions, width as a fraction. */
  screen: { x: number; y: number; w: number }
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
  scene?: { [K in keyof Scene]?: Partial<Scene[K]> }
  director?: Partial<Director>
  presets?: Record<string, Preset>
  hotkeys?: Hotkey[]
}

export const DEFAULT_SCENE: Scene = {
  motion: { sway: 1, speed: 1, blink: 3.7 },
  captions: { show: true, size: 22 },
  background: { color: '', image: '' },
  screen: { x: -0.55, y: -0.15, w: 0.4 },
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

export function sceneFrom(o: Overrides): Scene {
  return {
    motion: { ...DEFAULT_SCENE.motion, ...o.scene?.motion },
    captions: { ...DEFAULT_SCENE.captions, ...o.scene?.captions },
    background: { ...DEFAULT_SCENE.background, ...o.scene?.background },
    screen: { ...DEFAULT_SCENE.screen, ...o.scene?.screen },
  }
}

export function directorFrom(o: Overrides): Director {
  return { ...DEFAULT_DIRECTOR, ...o.director }
}
