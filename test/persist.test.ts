import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TalentConfig } from '../src/config'
import {
  applyOverrides,
  DEFAULT_DIRECTOR,
  DEFAULT_SCENE,
  directorFrom,
  readOverrides,
  sceneFrom,
  writeOverrides,
} from '../src/persist'

const talent = (): TalentConfig => ({
  name: 't',
  egirl_url: 'http://x',
  session: 'stage:t',
  model: 'a/a.model3.json',
  voice: 'af_heart',
  rvc: 'egirl',
  speed: 1,
  pitch: 0,
})

describe('persist', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stage-persist-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('missing file reads as empty overrides', () => {
    expect(readOverrides('nobody', dir)).toEqual({})
  })

  test('round-trips voice, model, transforms and scene through TOML', () => {
    writeOverrides(
      't',
      {
        voice: 'bf_emma',
        rvc: null,
        pitch: 12,
        speed: 1.1,
        model: 'b/b.model3.json',
        transforms: { 'b/b.model3.json': { x: 0.25, y: -0.1, scale: 1.4 } },
        scene: { motion: { sway: 0.5 }, captions: { show: false } },
      },
      dir,
    )
    expect(existsSync(join(dir, 't.toml'))).toBe(true)
    const o = readOverrides('t', dir)
    expect(o.voice).toBe('bf_emma')
    expect(o.rvc).toBe('') // TOML has no null; "off" is the empty string
    expect(o.pitch).toBe(12)
    expect(o.transforms?.['b/b.model3.json']).toEqual({ x: 0.25, y: -0.1, scale: 1.4 })
    expect(o.scene?.motion?.sway).toBe(0.5)
    expect(o.scene?.captions?.show).toBe(false)
  })

  test('applyOverrides changes only what was saved and can switch rvc off', () => {
    const t = talent()
    applyOverrides(t, { voice: 'am_adam', rvc: '' })
    expect(t.voice).toBe('am_adam')
    expect(t.rvc).toBeUndefined()
    expect(t.speed).toBe(1)
    applyOverrides(t, { rvc: 'other', model: 'c/c.model3.json' })
    expect(t.rvc).toBe('other')
    expect(t.model).toBe('c/c.model3.json')
  })

  test('sceneFrom fills defaults under partial overrides', () => {
    expect(sceneFrom({})).toEqual(DEFAULT_SCENE)
    const s = sceneFrom({ scene: { captions: { size: 30 } } })
    expect(s.captions).toEqual({ ...DEFAULT_SCENE.captions, size: 30 })
    expect(s.motion).toEqual(DEFAULT_SCENE.motion)
  })

  test('an unreadable file is ignored rather than crashing startup', () => {
    Bun.write(join(dir, 'bad.toml'), 'this = = not toml')
    expect(readOverrides('bad', dir)).toEqual({})
  })
})

describe('persist: director and screen', () => {
  test('sceneFrom gives the screen and captions boxes, no frames, and the background', () => {
    const s = sceneFrom({})
    expect(s.screen).toEqual(DEFAULT_SCENE.screen)
    expect(Object.keys(s.screen).sort()).toEqual(['h', 'show', 'w', 'x', 'y'])
    expect(s.captions).toMatchObject({ show: true, size: 22 })
    expect(typeof s.captions.h).toBe('number')
    expect(s.frames).toEqual([])
    expect(s.background).toEqual({ color: '', image: '' })
    const box = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }
    expect(sceneFrom({ scene: { screen: box } }).screen).toMatchObject(box)
  })
  test('a screen saved before widgets (centre in -1..1, width only) keeps its centre and width', () => {
    const s = sceneFrom({ scene: { screen: { x: 0.665, y: 0.108, w: 0.165 } } }).screen
    expect(s.w).toBeCloseTo(0.165)
    expect(s.x + s.w / 2).toBeCloseTo(0.8325)
    expect(s.y + s.h / 2).toBeCloseTo(0.554)
    expect(s.show).toBe(true)
  })
  test('directorFrom fills defaults and is off unless saved on', () => {
    expect(directorFrom({})).toEqual({
      enabled: false,
      interval_s: 45,
      prompt: DEFAULT_DIRECTOR.prompt,
    })
    expect(directorFrom({ director: { enabled: true, interval_s: 10 } }).enabled).toBe(true)
  })
})
