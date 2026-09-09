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
    if (p === '/transcribe') {
      const n = (await req.arrayBuffer()).byteLength
      return Response.json({ text: n > 44 ? 'hello from the mic' : '', seconds: 1.0, ms: 12 })
    }
    if (p === '/tts') {
      voiceCalls.push(await req.json())
      return new Response(WAV, {
        headers: {
          'content-type': 'audio/wav',
          'x-audio-seconds': '1.00',
          'x-gen-seconds': '0.010',
          // the per-clip mouth track the real service computes: 50 Hz frames of [open, form]
          'x-mouth': JSON.stringify({
            rate: 50,
            frames: [
              [0, 0],
              [0.8, 0.2],
              [0.3, -0.4],
            ],
          }),
        },
      })
    }
    return new Response('nf', { status: 404 })
  },
})
const egirlCalls: { method: string; path: string; body: unknown }[] = []
/** Set by an interrupt; a 'slow' stream in flight ends with an aborted done frame. */
let egirlAborted = false
const egirl = Bun.serve({
  port: 0,
  async fetch(req) {
    const p = new URL(req.url).pathname
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : undefined
    egirlCalls.push({ method: req.method, path: p, body })
    if (p === '/info')
      return Response.json({
        name: 'fake',
        model: 'tiny',
        tools: { exec: true, memory: true },
        thinking: 'low',
      })
    // The shapes below are egirl's own (src/api.ts), so a passing test means the console
    // reads what a real instance sends.
    if (p.endsWith('/context'))
      return Response.json({
        session_id: 'stage:test',
        utilization: 0.37,
        context_length: 32768,
        system_prompt_tokens: 1800,
        message_count: 12,
        message_tokens: 10300,
        has_summary: false,
        summary_tokens: 0,
        available: 20668,
        thinking: 'high',
      })
    if (p.endsWith('/thinking'))
      return Response.json({ ok: true, thinking: (body as { level: string }).level })
    if (p.endsWith('/interrupt')) {
      if ((body as { action?: string }).action !== 'abort')
        return Response.json({ error: "action must be 'abort' or 'inject'" }, { status: 400 })
      egirlAborted = true
      return Response.json({ ok: true, delivered: true })
    }
    if (p.endsWith('/compact'))
      return Response.json({ ok: true, messages_before: 12, messages_after: 4, dropped: 8 })
    if (req.method === 'DELETE' && p.startsWith('/sessions/')) return Response.json({ ok: true })
    if (p === '/asks')
      return Response.json({
        asks: [{ id: 'ask1', from: 'stage:test', question: 'Ship it?', asked_at: 1, kind: 'ask' }],
      })
    if (p === '/asks/ask1/reply') return Response.json({ ok: true, delivered: true })
    if (p === '/asks/ask1/dismiss') return Response.json({ ok: true })
    if (p.startsWith('/asks/')) return Response.json({ error: 'ask not found' }, { status: 404 })
    if (p === '/chat') {
      const enc = new TextEncoder()
      const msg = String((body as { message?: string })?.message ?? '')
      // Frames are egirl main's session-bus shapes (src/agent/session-events.ts in egirl).
      const end = (content: string, aborted = false) => ({
        t: 'run_end',
        v: {
          content,
          input_tokens: 10,
          output_tokens: 42,
          turns: 2,
          duration_ms: 5,
          aborted,
          awaiting: msg.includes('ask'),
        },
      })
      const frames = msg.includes('picture')
        ? [
            { t: 'token', v: 'Here. ![a cat](http://img/cat.png) ' },
            { t: 'token', v: 'Like it? ' },
            end('Here. ![a cat](http://img/cat.png) Like it?'),
          ]
        : [
            { t: 'queued', v: 1 },
            { t: 'run_start', v: { message: msg } },
            { t: 'reasoning', v: 'hmm ' },
            {
              t: 'tool',
              v: [
                { name: 'read_board', args: '{"id":1}' },
                { name: 'write_file', args: `{"content":"${'x'.repeat(500)}"}` },
              ],
            },
            {
              t: 'tool_done',
              v: { name: 'read_board', success: true, args: '{"id":1}', output: 'ok' },
            },
            {
              t: 'tool_done',
              v: { name: 'write_file', success: false, args: '{}', output: 'EACCES' },
            },
            { t: 'turn', v: { model: 'tiny', content: '', thinking: '', tool_calls: '' } },
            { t: 'token', v: '[happy] One. ' },
            { t: 'token', v: 'Two. ' },
            end('[happy] One. Two.'),
          ]
      const slow = msg.includes('slow')
      if (slow) egirlAborted = false
      return new Response(
        new ReadableStream({
          async start(c) {
            c.enqueue(enc.encode(': open\n\n'))
            for (const f of frames) {
              if (slow && egirlAborted) {
                c.enqueue(enc.encode(`data: ${JSON.stringify(end('', true))}\n\n`))
                break
              }
              c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`))
              await Bun.sleep(slow ? 150 : 5)
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
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data)) as Record<string, unknown>
    got.push(msg)
    // A page plays each clip and reports it, instantly here; without this the server keeps
    // counting unacknowledged clips as "still speaking" for a grace period.
    if (!role && msg.type === 'speak') {
      ws.send(JSON.stringify({ type: 'playing', id: msg.id }))
      ws.send(JSON.stringify({ type: 'spoke', id: msg.id }))
    }
  }
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
    expect(b.context.utilization).toBe(0.37)
    expect(b.context.thinking).toBe('high')
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
  test('POST /egirl/compact asks egirl to compact the talent session', async () => {
    const r = await post('/egirl/compact').then((x) => x.json())
    expect(r).toEqual({ ok: true, messages_before: 12, messages_after: 4, dropped: 8 })
    expect(egirlCalls.some((c) => c.path === '/sessions/stage%3Atest/compact')).toBe(true)
  })
  test('POST /egirl/reset deletes the talent session on egirl', async () => {
    const r = await post('/egirl/reset').then((x) => x.json())
    expect(r.ok).toBe(true)
    expect(
      egirlCalls.some((c) => c.method === 'DELETE' && c.path === '/sessions/stage%3Atest'),
    ).toBe(true)
  })
  test('GET /egirl/asks lists what the talent is waiting on a human for', async () => {
    const r = await get('/egirl/asks')
    expect(r.asks).toEqual([
      { id: 'ask1', from: 'stage:test', question: 'Ship it?', asked_at: 1, kind: 'ask' },
    ])
  })
  test('POST /egirl/asks/reply and /dismiss forward to egirl by id', async () => {
    const r = await post('/egirl/asks/reply', { id: 'ask1', reply: 'yes' }).then((x) => x.json())
    expect(r).toEqual({ ok: true, delivered: true })
    const call = egirlCalls.find((c) => c.path === '/asks/ask1/reply')
    expect(call?.body).toEqual({ reply: 'yes' })
    expect((await post('/egirl/asks/dismiss', { id: 'ask1' })).status).toBe(200)
    expect(egirlCalls.some((c) => c.path === '/asks/ask1/dismiss')).toBe(true)
    expect((await post('/egirl/asks/reply', { id: 'ask1' })).status).toBe(400)
    expect((await post('/egirl/asks/reply', { reply: 'yes' })).status).toBe(400)
    expect((await post('/egirl/asks/dismiss', {})).status).toBe(400)
    expect((await post('/egirl/asks/reply', { id: 'nope', reply: 'x' })).status).toBe(404)
  })
})

describe('turns', () => {
  test('a turn streams events to consoles and cues to pages, with tags applied per sentence', async () => {
    const page = await client()
    const con = await client('console')
    const r = await post('/chat', { message: 'go' }).then((x) => x.json())
    expect(r.reply).toBe('[happy] One. Two.')
    await con.waitFor((m) => m.type === 'turn' && m.phase === 'start' && m.message === 'go')
    const tool = await con.waitFor((m) => m.type === 'tool')
    expect(tool.v).toEqual(['read_board', 'write_file'])
    const calls = tool.calls as { name: string; args: string }[]
    expect(calls[0]).toEqual({ name: 'read_board', args: '{"id":1}' })
    // Arguments are for a chip tooltip, not a payload: long ones are cut.
    expect(calls[1]?.args.length).toBeLessThanOrEqual(240)
    expect(calls[1]?.args.endsWith('…')).toBe(true)
    const toolDone = await con.waitFor((m) => m.type === 'tool_done')
    expect(toolDone).toMatchObject({ v: 'read_board', ok: true })
    const failed = await con.waitFor((m) => m.type === 'tool_done')
    expect(failed).toMatchObject({ v: 'write_file', ok: false })
    const clips = con.got.filter((m) => m.type === 'clip')
    expect(clips.map((c) => c.text)).toEqual(['One.', 'Two.'])
    const done = await con.waitFor((m) => m.type === 'turn' && m.phase === 'done')
    expect(done.tokens).toBe(42)
    expect(done.turns).toBe(2)
    expect(done.awaiting).toBe(false)
    expect(page.got.find((m) => m.type === 'mood' && m.mood === 'happy')).toBeDefined()
    expect(page.got.filter((m) => m.type === 'speak')).toHaveLength(2)
    // pages report playback; consoles hear it as playing/spoke
    const id = String(clips[0]?.id)
    expect(con.got.find((m) => m.type === 'playing' && m.id === id)).toBeDefined()
    expect(con.got.find((m) => m.type === 'spoke' && m.id === id)).toBeDefined()
    page.close()
    con.close()
  })
  test('a turn that parks on a question for a human says so', async () => {
    const con = await client('console')
    await post('/chat', { message: 'ask nick' })
    const done = await con.waitFor((m) => m.type === 'turn' && m.phase === 'done')
    expect(done.awaiting).toBe(true)
    con.close()
  })
  test('POST /interrupt mid-turn aborts the egirl run the way egirl expects', async () => {
    const page = await client()
    const con = await client('console')
    const turn = post('/chat', { message: 'slow one' })
    await con.waitFor((m) => m.type === 'reasoning')
    const r = await post('/interrupt').then((x) => x.json())
    expect(r.aborted).toBe(true)
    const call = egirlCalls.filter((c) => c.path.endsWith('/interrupt')).at(-1)
    expect(call?.body).toEqual({ action: 'abort' })
    expect((await turn.then((x) => x.json())).reply).toBe('')
    expect(page.got.filter((m) => m.type === 'speak')).toHaveLength(0)
    page.close()
    con.close()
  })
})

describe('script', () => {
  test('POST /script plays lines in order with progress events, and can be stopped', async () => {
    const page = await client()
    const con = await client('console')
    const r = await post('/script', {
      lines: ['[happy] Step one.', 'Step two.', 'Step three.'],
      gap_ms: 10,
    }).then((x) => x.json())
    expect(r.ok).toBe(true)
    await con.waitFor((m) => m.type === 'script' && m.phase === 'start' && m.total === 3)
    await con.waitFor((m) => m.type === 'script' && m.phase === 'line' && m.index === 0)
    await con.waitFor((m) => m.type === 'script' && m.phase === 'done')
    expect(page.got.filter((m) => m.type === 'speak').map((m) => m.text)).toEqual([
      'Step one.',
      'Step two.',
      'Step three.',
    ])
    expect(page.got.find((m) => m.type === 'mood' && m.mood === 'happy')).toBeDefined()
    // a second script while one runs replaces it; stop ends it
    await post('/script', {
      lines: Array.from({ length: 20 }, (_, i) => `Line ${i}.`),
      gap_ms: 300,
    })
    await con.waitFor((m) => m.type === 'script' && m.phase === 'line' && m.index === 0)
    await post('/script/stop')
    await con.waitFor((m) => m.type === 'script' && m.phase === 'stopped')
    const spoken = page.got.filter((m) => m.type === 'speak' && /^Line/.test(String(m.text))).length
    await Bun.sleep(400)
    expect(page.got.filter((m) => m.type === 'speak' && /^Line/.test(String(m.text))).length).toBe(
      spoken,
    )
    expect(spoken).toBeLessThan(20)
    page.close()
    con.close()
  })
  test('POST /script validates', async () => {
    expect((await post('/script', { lines: 'nope' })).status).toBe(400)
    expect((await post('/script', { lines: [] })).status).toBe(400)
  })
})

describe('director', () => {
  test('POST /director persists and fires turns on its interval while idle', async () => {
    await post('/interrupt') // known-idle: clears anything earlier tests left queued
    const page = await client()
    const con = await client('console')
    const r = await post('/director', {
      enabled: true,
      interval_s: 0.2,
      prompt: 'director tick',
    }).then((x) => x.json())
    expect(r.director).toEqual({ enabled: true, interval_s: 0.2, prompt: 'director tick' })
    expect((await get('/talent')).director.enabled).toBe(true)
    expect(readOverrides('test', overridesDir).director?.prompt).toBe('director tick')
    await con.waitFor(
      (m) => m.type === 'turn' && m.phase === 'start' && m.message === 'director tick',
      3000,
    )
    await con.waitFor((m) => m.type === 'director' && m.phase === 'fired')
    await post('/director', { enabled: false })
    await con.waitFor(
      (m) => m.type === 'talent' && (m.director as { enabled: boolean }).enabled === false,
    )
    await Bun.sleep(500)
    const n = con.got.filter((m) => m.type === 'director' && m.phase === 'fired').length
    await Bun.sleep(500)
    expect(con.got.filter((m) => m.type === 'director' && m.phase === 'fired').length).toBe(n)
    page.close()
    con.close()
  })
  test('POST /director/run fires once regardless of the toggle', async () => {
    const con = await client('console')
    await post('/director', { prompt: 'once' })
    await post('/director/run')
    await con.waitFor((m) => m.type === 'turn' && m.phase === 'start' && m.message === 'once')
    con.close()
  })
  test('POST /director validates the interval', async () => {
    expect((await post('/director', { interval_s: 0 })).status).toBe(400)
    expect((await post('/director', { interval_s: 'fast' })).status).toBe(400)
  })
})

describe('images', () => {
  test('POST /image shows a picture on every page', async () => {
    const page = await client()
    await post('/image', { url: 'http://img/x.png', caption: 'x', seconds: 5 })
    const cue = await page.waitFor((m) => m.type === 'image')
    expect(cue).toEqual({ type: 'image', url: 'http://img/x.png', caption: 'x', seconds: 5 })
    expect((await post('/image', {})).status).toBe(400)
    await post('/image', { url: null })
    await page.waitFor((m) => m.type === 'image' && m.url === null) // clears the screen
    page.close()
  })
  test('a reply with a markdown image shows it and does not read the markup aloud', async () => {
    const page = await client()
    await post('/chat', { message: 'draw me a picture' })
    const cue = await page.waitFor((m) => m.type === 'image')
    expect(cue.url).toBe('http://img/cat.png')
    expect(cue.caption).toBe('a cat')
    const spoken = page.got.filter((m) => m.type === 'speak').map((m) => m.text)
    expect(spoken).toEqual(['Here.', 'Like it?'])
    page.close()
  })
  test('scene carries screen placement and a background image', async () => {
    const page = await client()
    await post('/scene', {
      screen: { x: 0.2, w: 0.5 },
      background: { image: 'backgrounds/room.png' },
    })
    const cue = await page.waitFor((m) => m.type === 'scene')
    const sc = cue.scene as {
      screen: { x: number; y: number; w: number }
      background: { image: string }
    }
    expect(sc.screen).toEqual({ x: 0.2, y: -0.15, w: 0.5 })
    expect(sc.background.image).toBe('backgrounds/room.png')
    await post('/scene', { screen: { x: 0, w: 0.4 }, background: { image: '' } })
    page.close()
  })
})

describe('twitch runtime', () => {
  test('POST /twitch is a 400 when the talent has no twitch table', async () => {
    const r = await post('/twitch', { paused: true })
    expect(r.status).toBe(400)
    expect((await get('/health')).twitch).toBeUndefined()
  })
})

describe('transcribe', () => {
  test('POST /transcribe proxies a WAV to the voice service and tells consoles', async () => {
    const con = await client('console')
    const r = await fetch(`${base}/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: WAV,
    })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.text).toBe('hello from the mic')
    expect(j.seconds).toBe(1)
    await con.waitFor((m) => m.type === 'transcript' && m.text === 'hello from the mic')
    con.close()
  })
  test('POST /transcribe with send=1 also runs the text as a turn', async () => {
    const con = await client('console')
    const r = await fetch(`${base}/transcribe?send=1`, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: WAV,
    })
    expect((await r.json()).sent).toBe(true)
    await con.waitFor(
      (m) => m.type === 'turn' && m.phase === 'start' && m.message === 'hello from the mic',
    )
    con.close()
  })
  test('POST /transcribe rejects an empty body', async () => {
    const r = await fetch(`${base}/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
    })
    expect(r.status).toBe(400)
  })
})

describe('lipsync track', () => {
  test('the speak cue carries the mouth track the voice service returned', async () => {
    const page = await client()
    await post('/say', { text: 'Track me.' })
    const cue = await page.waitFor((m) => m.type === 'speak' && m.text === 'Track me.')
    expect(cue.mouth).toEqual({
      rate: 50,
      frames: [
        [0, 0],
        [0.8, 0.2],
        [0.3, -0.4],
      ],
    })
    page.close()
  })
})

describe('presets', () => {
  test('save a preset from the current scene, list, apply, delete', async () => {
    const page = await client()
    await post('/transform', { x: 0.4, y: 0, scale: 1.2 })
    await post('/scene', { background: { color: '#112233' } })
    const r = await post('/presets', { name: 'game' }).then((x) => x.json())
    expect(r.ok).toBe(true)
    const list = await get('/presets')
    expect(list.map((p: { name: string }) => p.name)).toContain('game')
    const game = list.find((p: { name: string }) => p.name === 'game')
    expect(game.transform).toEqual({ x: 0.4, y: 0, scale: 1.2 })
    expect(game.scene.background.color).toBe('#112233')
    expect(readOverrides('test', overridesDir).presets?.game?.transform?.x).toBe(0.4)
    // change things, then apply the preset: transform and scene cues go out, talent reflects it
    await post('/transform', { x: 0, y: 0, scale: 1 })
    await post('/scene', { background: { color: '' } })
    await post('/presets/apply', { name: 'game' })
    await page.waitFor((m) => m.type === 'transform' && m.x === 0.4 && m.scale === 1.2)
    await page.waitFor(
      (m) =>
        m.type === 'scene' &&
        (m.scene as { background: { color: string } }).background.color === '#112233',
    )
    expect((await get('/talent')).transform).toEqual({ x: 0.4, y: 0, scale: 1.2 })
    expect((await post('/presets/apply', { name: 'nope' })).status).toBe(404)
    await post('/presets/delete', { name: 'game' })
    expect((await get('/presets')).map((p: { name: string }) => p.name)).not.toContain('game')
    await post('/transform', { x: 0, y: 0, scale: 1 })
    await post('/scene', { background: { color: '' } })
    page.close()
  })
  test('preset names are validated', async () => {
    expect((await post('/presets', { name: '' })).status).toBe(400)
    expect((await post('/presets', { name: 'a/b' })).status).toBe(400)
  })
})

describe('hotkeys', () => {
  test('hotkeys persist and describe an action; a canned line can be fired by name', async () => {
    const page = await client()
    const r = await post('/hotkeys', {
      hotkeys: [
        { key: 'F1', action: 'mood', value: 'happy' },
        { key: 'F2', action: 'say', value: '[nod] Be right back, chat.' },
        { key: 'F3', action: 'preset', value: 'game' },
      ],
    }).then((x) => x.json())
    expect(r.ok).toBe(true)
    expect((await get('/talent')).hotkeys).toHaveLength(3)
    expect(readOverrides('test', overridesDir).hotkeys?.[1]?.value).toBe(
      '[nod] Be right back, chat.',
    )
    await post('/hotkeys/fire', { key: 'F2' })
    await page.waitFor((m) => m.type === 'speak' && m.text === 'Be right back, chat.')
    await post('/hotkeys/fire', { key: 'F1' })
    await page.waitFor((m) => m.type === 'mood' && m.mood === 'happy')
    expect((await post('/hotkeys/fire', { key: 'F9' })).status).toBe(404)
    expect(
      (await post('/hotkeys', { hotkeys: [{ key: 'F1', action: 'launch', value: 'x' }] })).status,
    ).toBe(400)
    page.close()
  })
})
