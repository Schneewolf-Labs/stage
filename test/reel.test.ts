import { describe, expect, test } from 'bun:test'
import { pcm16, ReelBuilder, wavBytes } from '../src/reel'
import { buildReel } from '../src/render'

/** A mono PCM16 WAV of `n` samples, each sample = `v`. */
function wav(n: number, v = 1000, rate = 24000): ArrayBuffer {
  const data = new Uint8Array(n * 2)
  const dv = new DataView(data.buffer)
  for (let i = 0; i < n; i++) dv.setInt16(i * 2, v, true)
  return wavBytes(rate, data).buffer as ArrayBuffer
}

describe('pcm16', () => {
  test('reads rate and sample bytes back out of a WAV', () => {
    const p = pcm16(wav(240, 7))
    expect(p.rate).toBe(24000)
    expect(p.samples.byteLength).toBe(480)
    expect(new DataView(p.samples.buffer, p.samples.byteOffset).getInt16(0, true)).toBe(7)
  })
  test('rejects what is not mono 16-bit PCM', () => {
    const b = new Uint8Array(wav(10))
    new DataView(b.buffer).setUint16(22, 2, true) // stereo
    expect(() => pcm16(b.buffer as ArrayBuffer)).toThrow(/mono/)
    expect(() => pcm16(new ArrayBuffer(8))).toThrow()
  })
})

describe('ReelBuilder', () => {
  test('lays clips on one timeline with gaps, and cues at the time they were given', () => {
    const r = new ReelBuilder(0.5)
    r.cue({ type: 'mood', mood: 'happy' })
    r.clip(wav(24000), 'one', { rate: 50, frames: [[1, 0]] })
    r.gap(0.25)
    r.cue({ type: 'gesture', name: 'nod' })
    r.clip(wav(12000), 'two')
    const { reel, wav: out } = r.build(0.5)
    expect(reel.clips).toEqual([
      { t0: 0.5, t1: 1.5, text: 'one', mouth: { rate: 50, frames: [[1, 0]] } },
      { t0: 1.75, t1: 2.25, text: 'two' },
    ])
    expect(reel.cues).toEqual([
      { t: 0.5, cue: { type: 'mood', mood: 'happy' } },
      { t: 1.75, cue: { type: 'gesture', name: 'nod' } },
    ])
    expect(reel.duration).toBe(2.75)
    const p = pcm16(out.buffer as ArrayBuffer)
    expect(p.rate).toBe(24000)
    expect(p.samples.byteLength / 2).toBe(2.75 * 24000)
    const dv = new DataView(p.samples.buffer, p.samples.byteOffset)
    expect(dv.getInt16(0, true)).toBe(0) // lead-in is silence
    expect(dv.getInt16(0.5 * 24000 * 2, true)).toBe(1000) // first clip starts at 0.5 s
    expect(dv.getInt16(1.6 * 24000 * 2, true)).toBe(0) // the gap
  })
  test('buildReel speaks each line like /script: tags become cues, sentences become clips', async () => {
    const texts: string[] = []
    const voice = Bun.serve({
      port: 0,
      async fetch(req) {
        texts.push(((await req.json()) as { text: string }).text)
        return new Response(wav(12000), {
          headers: { 'x-mouth': JSON.stringify({ rate: 50, frames: [[0.5, 0]] }) },
        })
      },
    })
    const talent = {
      name: 't',
      egirl_url: '',
      session: 's',
      model: 'm',
      voice: 'af_heart',
      speed: 1,
      pitch: 0,
    }
    const { reel } = await buildReel(
      `http://127.0.0.1:${voice.port}`,
      talent,
      ['[happy] Hi there. Bye!', '[nod] Again.'],
      500,
    )
    voice.stop(true)
    expect(texts).toEqual(['Hi there.', 'Bye!', 'Again.'])
    expect(reel.clips.map((c) => [c.t0, c.t1, c.text])).toEqual([
      [0.4, 0.9, 'Hi there.'],
      [0.9, 1.4, 'Bye!'],
      [1.9, 2.4, 'Again.'],
    ])
    expect(reel.clips[0]?.mouth).toEqual({ rate: 50, frames: [[0.5, 0]] })
    expect(reel.cues).toEqual([
      { t: 0.4, cue: { type: 'mood', mood: 'happy' } },
      { t: 1.9, cue: { type: 'gesture', name: 'nod' } },
    ])
  })
  test('refuses clips of different sample rates', () => {
    const r = new ReelBuilder()
    r.clip(wav(10), 'a')
    expect(() => r.clip(wav(10, 1, 16000), 'b')).toThrow(/rate/)
  })
})
