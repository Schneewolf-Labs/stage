import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StageConfig } from '../src/config'
import { doctor, heardScore, ROUND_TRIP_TEXT } from '../src/doctor'

const dir = mkdtempSync(join(tmpdir(), 'stage-doctor-'))
mkdirSync(join(dir, 'ok'))
writeFileSync(join(dir, 'ok', 'ok.model3.json'), '{"Version":3}')
// Shapes mirror services/voice/server.py: /health, /tts -> WAV + x-audio-seconds, /transcribe -> {text, seconds, ms}.
// The talent's Kokoro voice picks what the fake whisper "hears", so one talent can come back garbled.
let lastVoice = ''
const voice = Bun.serve({
  port: 0,
  async fetch(req) {
    const p = new URL(req.url).pathname
    if (p === '/health')
      return Response.json({ device: 'cpu', rvc: ['egirl'], loaded_rvc: [], whisper: 'base.en' })
    if (p === '/tts') {
      lastVoice = ((await req.json()) as { voice: string }).voice
      return new Response(new Uint8Array(4844), {
        headers: {
          'content-type': 'audio/wav',
          'x-audio-seconds': '2.10',
          'x-gen-seconds': '0.300',
        },
      })
    }
    if (p === '/transcribe') {
      await req.arrayBuffer()
      const text = lastVoice === 'af_garbled' ? 'Kennedy louds, hearst them ting.' : ROUND_TRIP_TEXT
      return Response.json({ text, seconds: 2.1, ms: 400 })
    }
    return new Response('nf', { status: 404 })
  },
})
const egirl = Bun.serve({
  port: 0,
  fetch: () => Response.json({ name: 'e', tools: { exec: true }, peers: 1, mcp: ['witchgrid'] }),
})

const cfg = (model: string, rvc?: string, kokoro = 'af_heart'): StageConfig => ({
  server: { host: '127.0.0.1', port: 3100, models_dir: dir },
  voice: { url: `http://127.0.0.1:${voice.port}` },
  talents: {
    t: {
      name: 't',
      egirl_url: `http://127.0.0.1:${egirl.port}`,
      session: 's',
      model,
      voice: kokoro,
      ...(rvc ? { rvc } : {}),
      speed: 1,
      pitch: 0,
    },
  },
})

describe('doctor', () => {
  test('reports each check with ok/fail and a detail', async () => {
    const r = await doctor(cfg('ok/ok.model3.json', 'egirl'))
    const by = Object.fromEntries(r.map((c) => [c.name, c]))
    expect(by['models_dir'].ok).toBe(true)
    expect(by['talent t: model'].ok).toBe(true)
    expect(by['voice service'].ok).toBe(true)
    expect(by['talent t: rvc model'].ok).toBe(true)
    expect(by['talent t: egirl'].ok).toBe(true)
    expect(by['talent t: tools'].ok).toBe(false)
    expect(by['talent t: tools'].detail).toMatch(/exec/)
    expect(by['talent t: tools'].detail).toMatch(/peers: 1.*mcp: witchgrid/)
    expect(r.every((c) => typeof c.detail === 'string')).toBe(true)
    expect(by['talent t: voice round-trip'].ok).toBe(true)
    expect(by['talent t: voice round-trip'].detail).toMatch(/100%/)
  })
  test('a voice whisper cannot understand fails the round-trip and says what it heard', async () => {
    const by = Object.fromEntries(
      (await doctor(cfg('ok/ok.model3.json', 'egirl', 'af_garbled'))).map((x) => [x.name, x]),
    )
    expect(by['talent t: voice round-trip'].ok).toBe(false)
    expect(by['talent t: voice round-trip'].detail).toMatch(/Kennedy louds/)
  })
  test('the round-trip is not ok when the voice service is down', async () => {
    const c = cfg('ok/ok.model3.json')
    c.voice.url = 'http://127.0.0.1:9'
    const by = Object.fromEntries((await doctor(c)).map((x) => [x.name, x]))
    expect(by['talent t: voice round-trip'].ok).toBe(false)
    expect(by['talent t: voice round-trip'].detail).toBe('voice service down')
  })
  test('flags a missing model, an unknown rvc model, and a dead egirl', async () => {
    const c = cfg('missing/x.model3.json', 'nope')
    const t = c.talents.t
    if (t) t.egirl_url = 'http://127.0.0.1:9'
    const by = Object.fromEntries((await doctor(c)).map((x) => [x.name, x]))
    expect(by['talent t: model'].ok).toBe(false)
    expect(by['talent t: rvc model'].ok).toBe(false)
    expect(by['talent t: egirl'].ok).toBe(false)
  })
})

describe('heardScore', () => {
  test('fraction of expected words heard, ignoring case and punctuation', () => {
    expect(heardScore('The quick brown fox.', 'the QUICK, brown fox!')).toBe(1)
    expect(heardScore('The quick brown fox.', 'the quick')).toBe(0.5)
    expect(heardScore('The quick brown fox.', '')).toBe(0)
    expect(heardScore('', 'anything')).toBe(0)
  })
  test('a repeated word counts once per time it was heard', () => {
    expect(heardScore('la la la', 'la')).toBeCloseTo(1 / 3)
  })
})
