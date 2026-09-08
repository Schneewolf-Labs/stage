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
  background: { color: string }
}

/**
 * What the console changes at runtime and expects to survive a restart. Lives in
 * `stage.d/<talent>.toml` (gitignored) so stage.toml, the human-written file, is never rewritten.
 * Loaded on top of the talent's config; written whole on every change (it is tiny).
 */
export interface Overrides {
  voice?: string
  rvc?: string | null
  pitch?: number
  speed?: number
  model?: string
  transforms?: Record<string, Transform>
  scene?: Partial<Scene>
}

export const DEFAULT_SCENE: Scene = {
  motion: { sway: 1, speed: 1, blink: 3.7 },
  captions: { show: true, size: 22 },
  background: { color: '' },
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
  }
}
