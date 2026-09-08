import { describe, expect, test } from 'bun:test'
import {
  clampTransform,
  clipStats,
  fitModel,
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
    expect(t.tools).toEqual([{ name: 'read_board', done: true }])
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
      { name: 'x', done: true },
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
