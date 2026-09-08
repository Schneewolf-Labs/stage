import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StageConfig, TalentConfig } from '../src/config'
import { readOverrides } from '../src/persist'
import { startServer } from '../src/server'

/* ---- fakes: a voice service and an egirl instance on ephemeral ports ---- */
const WAV = (() => {
  const sr = 24000,
    n = sr,
    buf = new ArrayBuffer(44 + n * 2),
    v = new DataView(buf)
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  v.setUint32(4, 36 + n * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, sr, true)
  v.setUint32(28, sr * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, n * 2, true)
  return buf
})()
const voiceCalls: unknown[] = []
const voice = Bun.serve({
  port: 0,
  async fetch(req) {
    const p = new URL(req.url).pathname
    if (p === '/health') return Response.json({ device: 'cpu', rvc: ['egirl'], loaded_rvc: [] })
    if (p === '/tts') {
      voiceCalls.push(await req.json())
      return new Response(WAV, {
        headers: {
          'content-type': 'audio/wav',
          'x-audio-seconds': '1.00',
          'x-gen-seconds': '0.010',
        },
      })
    }
    return new Response('nf', { status: 404 })
  },
})
const egirlCalls: { path: string; body: unknown }[] = []
const egirl = Bun.serve({
  port: 0,
  async fetch(req) {
    const p = new URL(req.url).pathname
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : undefined
    egirlCalls.push({ path: p, body })
    if (p === '/info')
      return Response.json({
        name: 'fake',
        model: 'tiny',
        tools: { exec: true, memory: true },
        thinking: 'low',
      })
    if (p.endsWith('/context')) return Response.json({ used: 1200, limit: 32768 })
    if (p.endsWith('/thinking'))
      return Response.json({ ok: true, thinking: (body as { level: string }).level })
    if (p === '/chat') {
      const enc = new TextEncoder()
      const frames = [
        { t: 'reasoning', v: 'hmm ' },
        { t: 'tool', v: ['read_board'] },
        { t: 'tool_done', v: 'read_board' },
        { t: 'token', v: '[happy] One. ' },
        { t: 'token', v: 'Two. ' },
        { t: 'done', content: '[happy] One. Two.' },
      ]
      return new Response(
        new ReadableStream({
          async start(c) {
            for (const f of frames) {
              c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`))
              await Bun.sleep(5)
            }
            c.close()
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }
    return new Response('nf', { status: 404 })
  },
})

/* ---- a models dir with one model that has an expression file ---- */
const modelsDir = mkdtempSync(join(tmpdir(), 'stage-models-'))
mkdirSync(join(modelsDir, 'a', 'Exp'), { recursive: true })
writeFileSync(
  join(modelsDir, 'a', 'a.model3.json'),
  JSON.stringify({ Version: 3, FileReferences: { Moc: 'a.moc3' } }),
)
writeFileSync(
  join(modelsDir, 'a', 'Exp', 'Happy.exp3.json'),
  '{"Type":"Live2D Expression","Parameters":[]}',
)
writeFileSync(join(modelsDir, 'a', 'icon.png'), '')
mkdirSync(join(modelsDir, 'b'))
writeFileSync(join(modelsDir, 'b', 'b.model3.json'), '{"Version":3}')
const overridesDir = mkdtempSync(join(tmpdir(), 'stage-d-'))

const talent: TalentConfig = {
  name: 'test',
  egirl_url: `http://127.0.0.1:${egirl.port}`,
  session: 'stage:test',
  model: 'a/a.model3.json',
  voice: 'af_heart',
  rvc: 'egirl',
  speed: 1,
  pitch: 0,
}
const cfg: StageConfig = {
  server: { host: '127.0.0.1', port: 0, models_dir: modelsDir },
  voice: { url: `http://127.0.0.1:${voice.port}` },
  talents: { test: talent },
}
const logs: string[] = []
let server: ReturnType<typeof startServer>
let base: string
beforeAll(() => {
  server = startServer({ cfg, talent, log: (m) => logs.push(m), overridesDir })
  base = `http://127.0.0.1:${server.port}`
})
afterAll(() => {
  server.stop(true)
  voice.stop(true)
  egirl.stop(true)
  rmSync(modelsDir, { recursive: true, force: true })
  rmSync(overridesDir, { recursive: true, force: true })
})

const get = (p: string) => fetch(base + p).then((r) => r.json())
const post = (p: string, b: unknown = {}) =>
  fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(b),
  })

/** A WebSocket client that collects JSON messages; `role` announces a console. */
async function client(role?: 'console') {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`)
  const got: Record<string, unknown>[] = []
  ws.onmessage = (m) => got.push(JSON.parse(String(m.data)))
  await new Promise((r) => (ws.onopen = r))
  ws.send(JSON.stringify({ type: 'ready', ...(role ? { role } : {}) }))
  await Bun.sleep(30)
  // Each waitFor consumes forward from the last match, so two identical cues (a load on
  // connect, a load after a swap) are told apart by order.
  let cursor = 0
  const waitFor = async (pred: (m: Record<string, unknown>) => boolean, ms = 2000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      const i = got.findIndex((m, idx) => idx >= cursor && pred(m))
      if (i >= 0) {
        cursor = i + 1
        return got[i] as Record<string, unknown>
      }
      await Bun.sleep(10)
    }
    throw new Error(
      `no message matching within ${ms}ms; got ${JSON.stringify(got.map((g) => g.type))}`,
    )
  }
  return {
    ws,
    got,
    waitFor,
    send: (o: unknown) => ws.send(JSON.stringify(o)),
    close: () => ws.close(),
  }
}

describe('discovery', () => {
  test('GET /models.json lists models with folder names, icons and expression counts', async () => {
    const list = await get('/models.json')
    expect(list).toEqual([
      { model: 'a/a.model3.json', name: 'a', icon: '/models/a/icon.png', expressions: 1 },
      { model: 'b/b.model3.json', name: 'b', expressions: 0 },
    ])
  })
  test('GET /talent carries settings, transform, scene and mute state', async () => {
    const t = await get('/talent')
    expect(t.name).toBe('test')
    expect(t.talents).toEqual(['test'])
    expect(t.transform).toEqual({ x: 0, y: 0, scale: 1 })
    expect(t.scene.motion).toEqual({ sway: 1, speed: 1, blink: 3.7 })
    expect(t.muted).toBe(false)
  })
  test('GET /health reports egirl reachability and mute', async () => {
    const h = await get('/health')
    expect(h.egirl).toEqual({ ok: true })
    expect(h.muted).toBe(false)
    expect(h.voice.rvc).toEqual(['egirl'])
  })
})

describe('websocket roles', () => {
  test('a page gets the load cue with transform and scene; a console also gets talent and logs', async () => {
    const page = await client()
    const load = await page.waitFor((m) => m.type === 'load')
    expect(load.model).toBe('/models/a/a.model3.json')
    expect(load.expressions).toEqual([{ name: 'Happy', url: '/models/a/Exp/Happy.exp3.json' }])
    expect(load.transform).toEqual({ x: 0, y: 0, scale: 1 })
    expect((load.scene as { captions: { show: boolean } }).captions.show).toBe(true)
    expect(page.got.find((m) => m.type === 'talent')).toBeUndefined()
    const con = await client('console')
    await con.waitFor((m) => m.type === 'talent')
    const l = await con.waitFor((m) => m.type === 'logs')
    expect(Array.isArray(l.lines)).toBe(true)
    expect((l.lines as string[]).some((x) => /stage for test/.test(x))).toBe(true)
    page.close()
    con.close()
  })
  test('server log lines stream to consoles as they happen', async () => {
    const con = await client('console')
    await post('/cue', { type: 'mood', mood: 'happy' })
    await post('/nonexistent-to-log', {})
    await post('/say', { text: 'Log me.' })
    const m = await con.waitFor((x) => x.type === 'log' && /spoke .*Log me/.test(String(x.text)))
    expect(m).toBeDefined()
    con.close()
  })
})

describe('layout and scene', () => {
  test('POST /transform clamps, broadcasts, persists per model, and loads with the model', async () => {
    const page = await client()
    const r = await post('/transform', { x: 0.3, y: 9, scale: 1.5 })
    expect(r.status).toBe(200)
    const cue = await page.waitFor((m) => m.type === 'transform')
    expect(cue).toEqual({ type: 'transform', x: 0.3, y: 1, scale: 1.5 })
    expect(readOverrides('test', overridesDir).transforms?.['a/a.model3.json']).toEqual({
      x: 0.3,
      y: 1,
      scale: 1.5,
    })
    expect((await get('/talent')).transform).toEqual({ x: 0.3, y: 1, scale: 1.5 })
    // switching model brings that model's own transform (identity when never placed)
    await post('/model', { model: 'b/b.model3.json' })
    const load = await page.waitFor(
      (m) => m.type === 'load' && m.model === '/models/b/b.model3.json',
    )
    expect(load.transform).toEqual({ x: 0, y: 0, scale: 1 })
    expect(readOverrides('test', overridesDir).model).toBe('b/b.model3.json')
    await post('/model', { model: 'a/a.model3.json' })
    const back = await page.waitFor(
      (m) => m.type === 'load' && m.model === '/models/a/a.model3.json',
    )
    expect(back.transform).toEqual({ x: 0.3, y: 1, scale: 1.5 })
    page.close()
  })
  test('POST /transform rejects non-numbers', async () => {
    expect((await post('/transform', { x: 'left' })).status).toBe(400)
  })
  test('POST /scene merges, broadcasts and persists', async () => {
    const page = await client()
    await post('/scene', { motion: { sway: 0.4 }, captions: { size: 30 } })
    const cue = await page.waitFor((m) => m.type === 'scene')
    const scene = cue.scene as {
      motion: { sway: number; speed: number }
      captions: { size: number; show: boolean }
    }
    expect(scene.motion).toEqual({ sway: 0.4, speed: 1, blink: 3.7 })
    expect(scene.captions).toEqual({ show: true, size: 30 })
    expect(readOverrides('test', overridesDir).scene?.motion?.sway).toBe(0.4)
    await post('/scene', { background: { color: '#123456' } })
    expect((await get('/talent')).scene.background.color).toBe('#123456')
    page.close()
  })
})

describe('voice', () => {
  test('POST /voice applies live, persists, and announces to consoles', async () => {
    const con = await client('console')
    await post('/voice', { voice: 'bf_emma', rvc: null, pitch: 12.4, speed: 1.1 })
    const ev = await con.waitFor((m) => m.type === 'talent' && m.voice === 'bf_emma')
    expect(ev.rvc).toBeUndefined()
    expect(ev.pitch).toBe(12)
    const o = readOverrides('test', overridesDir)
    expect(o.voice).toBe('bf_emma')
    expect(o.rvc).toBe('')
    expect(o.pitch).toBe(12)
    expect(o.speed).toBe(1.1)
    await post('/say', { text: 'Check.' })
    const last = voiceCalls.at(-1) as { voice: string; rvc: string | null; pitch: number }
    expect(last.voice).toBe('bf_emma')
    expect(last.rvc).toBeNull()
    expect(last.pitch).toBe(12)
    await post('/voice', { voice: 'af_heart', rvc: 'egirl', pitch: 0, speed: 1 })
    con.close()
  })
})

describe('mute', () => {
  test('POST /mute stops the page, skips synthesis, and reports everywhere', async () => {
    const page = await client()
    const con = await client('console')
    const before = voiceCalls.length
    await post('/mute', { on: true })
    await page.waitFor((m) => m.type === 'stop')
    await con.waitFor((m) => m.type === 'talent' && m.muted === true)
    expect((await get('/health')).muted).toBe(true)
    const r = await post('/say', { text: 'Silent.' }).then((x) => x.json())
    expect(r.muted).toBe(true)
    expect(voiceCalls.length).toBe(before)
    expect(
      page.got.find((m) => m.type === 'speak' && String(m.text).includes('Silent')),
    ).toBeUndefined()
    await con.waitFor((m) => m.type === 'log' && /muted/.test(String(m.text)))
    await post('/mute', { on: false })
    await con.waitFor((m) => m.type === 'talent' && m.muted === false)
    page.close()
    con.close()
  })
})

describe('brain', () => {
  test('GET /egirl proxies info and session context', async () => {
    const b = await get('/egirl')
    expect(b.ok).toBe(true)
    expect(b.info.tools.exec).toBe(true)
    expect(b.context).toEqual({ used: 1200, limit: 32768 })
    expect(
      egirlCalls.some(
        (c) =>
          c.path === '/sessions/stage%3Atest/context' || c.path === '/sessions/stage:test/context',
      ),
    ).toBe(true)
  })
  test('POST /egirl/thinking forwards the level to the talent session', async () => {
    const r = await post('/egirl/thinking', { level: 'high' }).then((x) => x.json())
    expect(r.thinking).toBe('high')
    const call = egirlCalls.find((c) => c.path.endsWith('/thinking'))
    expect(call?.body).toEqual({ level: 'high' })
  })
  test('POST /egirl/thinking validates the level', async () => {
    expect((await post('/egirl/thinking', { level: 'max' })).status).toBe(400)
  })
})

describe('turns', () => {
  test('a turn streams events to consoles and cues to pages, with tags applied per sentence', async () => {
    const page = await client()
    const con = await client('console')
    const r = await post('/chat', { message: 'go' }).then((x) => x.json())
    expect(r.reply).toBe('[happy] One. Two.')
    await con.waitFor((m) => m.type === 'turn' && m.phase === 'start' && m.message === 'go')
    await con.waitFor((m) => m.type === 'tool_done')
    const clips = con.got.filter((m) => m.type === 'clip')
    expect(clips.map((c) => c.text)).toEqual(['One.', 'Two.'])
    await con.waitFor((m) => m.type === 'turn' && m.phase === 'done')
    expect(page.got.find((m) => m.type === 'mood' && m.mood === 'happy')).toBeDefined()
    expect(page.got.filter((m) => m.type === 'speak')).toHaveLength(2)
    // pages report playback; consoles hear it as playing/spoke
    const id = String(clips[0]?.id)
    page.send({ type: 'playing', id })
    await con.waitFor((m) => m.type === 'playing' && m.id === id)
    page.send({ type: 'spoke', id })
    await con.waitFor((m) => m.type === 'spoke' && m.id === id)
    page.close()
    con.close()
  })
})
