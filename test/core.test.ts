import { describe, expect, test } from 'bun:test'
import {
  clampTransform,
  clipStats,
  contextUse,
  downsample,
  encodeWav,
  fitModel,
  mouthAt,
  readiness,
  riskyTools,
  turnReducer,
} from '../web/core.js'

describe('turnReducer', () => {
  const run = (events: object[]) =>
    events.reduce((s, e) => turnReducer(s, e), turnReducer(undefined, { type: 'init' }))

  test('builds a turn from start through spoken sentences to done', () => {
    const s = run([
      { type: 'turn', phase: 'start', message: 'hi' },
      { type: 'reasoning', v: 'let me ' },
      { type: 'reasoning', v: 'think' },
      { type: 'tool', v: ['read_board'] },
      { type: 'tool_done', v: 'read_board' },
      { type: 'token', v: 'Hello. ' },
      { type: 'clip', id: 'c1', text: 'Hello.', seconds: 1.2, genMs: 300 },
      { type: 'speak', id: 'c1', url: '/audio/c1.wav', text: 'Hello.' },
      { type: 'playing', id: 'c1' },
      { type: 'turn', phase: 'done', reply: 'Hello.', ms: 1500 },
      { type: 'spoke', id: 'c1' },
    ])
    expect(s.turns).toHaveLength(1)
    const t = s.turns[0]
    expect(t.message).toBe('hi')
    expect(t.reasoning).toBe('let me think')
    expect(t.tools).toEqual([{ name: 'read_board', done: true, ok: true }])
    expect(t.sentences).toEqual([{ id: 'c1', text: 'Hello.', status: 'done' }])
    expect(t.ms).toBe(1500)
    expect(t.done).toBe(true)
    expect(s.speaking).toBe(false)
    expect(s.caption).toBe('')
  })

  test('playing marks the sentence now and sets the caption; a duplicate playing report is ignored', () => {
    const s = run([
      { type: 'turn', phase: 'start', message: 'm' },
      { type: 'clip', id: 'a', text: 'A.', seconds: 1, genMs: 10 },
      { type: 'clip', id: 'b', text: 'B.', seconds: 1, genMs: 10 },
      { type: 'speak', id: 'a', url: '', text: 'A.' },
      { type: 'speak', id: 'b', url: '', text: 'B.' },
      { type: 'playing', id: 'a' },
      { type: 'playing', id: 'a' },
    ])
    expect(s.speaking).toBe(true)
    expect(s.caption).toBe('A.')
    expect(s.turns[0].sentences.map((x) => x.status)).toEqual(['now', 'queued'])
  })

  test('tool chips match the most recent undone chip of that name', () => {
    const s = run([
      { type: 'turn', phase: 'start', message: 'm' },
      { type: 'tool', v: ['x', 'x'] },
      { type: 'tool_done', v: 'x' },
    ])
    expect(s.turns[0].tools).toEqual([
      { name: 'x', done: false },
      { name: 'x', done: true, ok: true },
    ])
  })

  test('error phase records the message and ends the turn', () => {
    const s = run([
      { type: 'turn', phase: 'start', message: 'm' },
      { type: 'turn', phase: 'error', message: 'boom', ms: 20 },
    ])
    expect(s.turns[0].error).toBe('boom')
    expect(s.turns[0].done).toBe(true)
  })

  test('stop clears speaking and caption, newest turn first, capped at 50', () => {
    let s = turnReducer(undefined, { type: 'init' })
    for (let i = 0; i < 60; i++)
      s = turnReducer(s, { type: 'turn', phase: 'start', message: `m${i}` })
    expect(s.turns).toHaveLength(50)
    expect(s.turns[0].message).toBe('m59')
    s = turnReducer(s, { type: 'clip', id: 'z', text: 'Z.', seconds: 1, genMs: 1 })
    s = turnReducer(s, { type: 'playing', id: 'z' })
    s = turnReducer(s, { type: 'stop' })
    expect(s.speaking).toBe(false)
    expect(s.caption).toBe('')
  })
})

describe('turnReducer tool detail', () => {
  const run = (events: object[]) =>
    events.reduce((s, e) => turnReducer(s, e), turnReducer(undefined, { type: 'init' }))

  test('keeps what a tool was called with, whether it failed, and the turn cost', () => {
    const s = run([
      { type: 'turn', phase: 'start', message: 'hi' },
      {
        type: 'tool',
        v: ['execute_command'],
        calls: [{ name: 'execute_command', args: '{"command":"ls"}' }],
      },
      { type: 'tool_done', v: 'execute_command', ok: false },
      { type: 'tool', v: ['read_file'] },
      { type: 'tool_done', v: 'read_file' },
      { type: 'turn', phase: 'done', reply: '', ms: 10, tokens: 42, turns: 2, awaiting: true },
    ])
    const t = s.turns[0]
    expect(t.tools).toEqual([
      { name: 'execute_command', args: '{"command":"ls"}', done: true, ok: false },
      { name: 'read_file', done: true, ok: true },
    ])
    expect(t.tokens).toBe(42)
    expect(t.turns).toBe(2)
    expect(t.awaiting).toBe(true)
  })
})

describe('contextUse', () => {
  test("reads egirl's /sessions/:id/context shape", () => {
    const u = contextUse(
      { utilization: 0.37, context_length: 32768, available: 20668, thinking: 'high' },
      { thinking: 'low', contextLength: 32768 },
    )
    expect(u).toEqual({ used: 12100, limit: 32768, pct: 37, thinking: 'high' })
  })
  test('falls back to the instance defaults when the session has no context yet', () => {
    expect(contextUse(null, { thinking: 'low', contextLength: 8192 })).toEqual({
      used: null,
      limit: 8192,
      pct: null,
      thinking: 'low',
    })
    expect(contextUse(undefined, undefined)).toEqual({
      used: null,
      limit: null,
      pct: null,
      thinking: null,
    })
  })
})

describe('clipStats', () => {
  test('summarizes recent clips', () => {
    const st = clipStats([
      { genMs: 200, seconds: 2 },
      { genMs: 400, seconds: 2 },
    ])
    expect(st.count).toBe(2)
    expect(st.lastGenMs).toBe(400)
    expect(st.lastSeconds).toBe(2)
    expect(st.avgRtf).toBeCloseTo(0.15, 5)
  })
  test('is empty-safe', () => {
    expect(clipStats([])).toEqual({ count: 0, lastGenMs: null, lastSeconds: null, avgRtf: null })
  })
})

describe('transform', () => {
  test('clamps to the canvas and sane scales', () => {
    expect(clampTransform({ x: 5, y: -5, scale: 99 })).toEqual({ x: 1, y: -1, scale: 4 })
    expect(clampTransform({ x: 0.2, y: 0.1, scale: 0.01 })).toEqual({ x: 0.2, y: 0.1, scale: 0.1 })
    expect(clampTransform({})).toEqual({ x: 0, y: 0, scale: 1 })
  })
  test('fitModel centers at identity and offsets by fractions of the screen', () => {
    const id = fitModel({ w: 1920, h: 1080 }, { w: 1000, h: 2000 }, { x: 0, y: 0, scale: 1 })
    expect(id.scale).toBeCloseTo((1080 / 2000) * 0.95, 5)
    expect(id.x).toBe(960)
    expect(id.y).toBe(540)
    const moved = fitModel(
      { w: 1920, h: 1080 },
      { w: 1000, h: 2000 },
      { x: 0.5, y: -0.5, scale: 2 },
    )
    expect(moved.x).toBe(960 + 0.5 * 960)
    expect(moved.y).toBe(540 - 0.5 * 540)
    expect(moved.scale).toBeCloseTo(id.scale * 2, 5)
  })
})

describe('readiness', () => {
  test('lists what has to be true before going live', () => {
    const items = readiness({
      health: { ok: true, pages: 1, voice: { device: 'cuda' }, twitch: { connected: false } },
      egirl: { ok: true, info: { tools: { exec: false } } },
      modelLoaded: true,
    })
    const by = Object.fromEntries(items.map((i) => [i.key, i]))
    expect(by.server.ok).toBe(true)
    expect(by.voice.ok).toBe(true)
    expect(by.egirl.ok).toBe(true)
    expect(by.page.ok).toBe(true)
    expect(by.model.ok).toBe(true)
    expect(by.twitch.ok).toBe(false)
    expect(by.tools.ok).toBe(true)
  })
  test('flags a down voice service, no page, and risky tools', () => {
    const items = readiness({
      health: { ok: true, pages: 0, voice: { error: 'ECONNREFUSED' } },
      egirl: { ok: true, info: { tools: { exec: true, git: true } } },
      modelLoaded: false,
    })
    const by = Object.fromEntries(items.map((i) => [i.key, i]))
    expect(by.voice.ok).toBe(false)
    expect(by.page.ok).toBe(false)
    expect(by.model.ok).toBe(false)
    expect(by.tools.ok).toBe(false)
    expect(by.tools.detail).toMatch(/exec/)
    expect(by.twitch).toBeUndefined() // not configured: not on the list
  })
  test('unreachable egirl', () => {
    const by = Object.fromEntries(
      readiness({
        health: { ok: true, pages: 0, voice: {} },
        egirl: { ok: false, error: 'x' },
      }).map((i) => [i.key, i]),
    )
    expect(by.egirl.ok).toBe(false)
    expect(by.tools.ok).toBe(false)
  })
})

describe('riskyTools', () => {
  test('names enabled tools that can act on the world', () => {
    expect(
      riskyTools({
        exec: true,
        git: true,
        memory: true,
        browser: false,
        codeAgent: true,
        files: true,
      }),
    ).toEqual(['codeAgent', 'exec', 'files', 'git'])
    expect(riskyTools({ memory: true })).toEqual([])
    expect(riskyTools(undefined)).toEqual([])
  })
})

describe('encodeWav / downsample', () => {
  test('writes a valid 16-bit mono PCM header and clamps samples', () => {
    const bytes = encodeWav(new Float32Array([0, 0.5, -0.5, 2, -2]), 16000)
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const str = (o, n) => String.fromCharCode(...bytes.slice(o, o + n))
    expect(str(0, 4)).toBe('RIFF')
    expect(str(8, 4)).toBe('WAVE')
    expect(str(12, 4)).toBe('fmt ')
    expect(str(36, 4)).toBe('data')
    expect(v.getUint16(22, true)).toBe(1) // mono
    expect(v.getUint32(24, true)).toBe(16000)
    expect(v.getUint16(34, true)).toBe(16)
    expect(v.getUint32(40, true)).toBe(10) // 5 samples * 2 bytes
    expect(v.getInt16(44, true)).toBe(0)
    expect(v.getInt16(46, true)).toBe(16383)
    expect(v.getInt16(50, true)).toBe(32767) // clamped
    expect(v.getInt16(52, true)).toBe(-32768)
  })
  test('downsample halves a 32 kHz signal to 16 kHz', () => {
    const src = new Float32Array(64).map((_, i) => i)
    const out = downsample(src, 32000, 16000)
    expect(out.length).toBe(32)
    expect(out[1]).toBeCloseTo(2, 5)
    expect(downsample(src, 16000, 16000)).toBe(src)
  })
})

describe('mouthAt', () => {
  const track = {
    rate: 50,
    frames: [
      [0, 0],
      [1, 0.5],
      [0.5, -0.5],
      [0, 0],
    ],
  }
  test('interpolates openness and form between frames at the playback time', () => {
    expect(mouthAt(track, 0)).toEqual({ open: 0, form: 0 })
    expect(mouthAt(track, 0.02)).toEqual({ open: 1, form: 0.5 })
    const mid = mouthAt(track, 0.03)
    expect(mid.open).toBeCloseTo(0.75, 5)
    expect(mid.form).toBeCloseTo(0, 5)
  })
  test('is closed before the start and after the end, and without a track', () => {
    expect(mouthAt(track, -1)).toEqual({ open: 0, form: 0 })
    expect(mouthAt(track, 9)).toEqual({ open: 0, form: 0 })
    expect(mouthAt(null, 1)).toBeNull()
    expect(mouthAt({ rate: 50, frames: [] }, 0)).toBeNull()
  })
})
