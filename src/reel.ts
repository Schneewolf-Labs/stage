import type { StageCue } from './types'
import type { MouthTrack } from './voice'

/** A clip placed on the reel's timeline, in seconds from the start. */
export interface ReelClip {
  t0: number
  t1: number
  text: string
  mouth?: MouthTrack
}

/** A cue (mood, gesture, image) applied when the render clock passes `t`. */
export interface ReelCue {
  t: number
  cue: StageCue
}

/** Everything the page needs to draw a render, minus the audio. */
export interface Reel {
  duration: number
  clips: ReelClip[]
  cues: ReelCue[]
}

/** Mono PCM16 WAV -> sample rate and the raw little-endian sample bytes. */
export function pcm16(wav: ArrayBuffer): { rate: number; samples: Uint8Array } {
  const v = new DataView(wav)
  const tag = (o: number): string =>
    String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3))
  if (wav.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV')
  let rate = 0
  for (let o = 12; o + 8 <= wav.byteLength; ) {
    const id = tag(o)
    const size = v.getUint32(o + 4, true)
    if (id === 'fmt ') {
      const pcm = v.getUint16(o + 8, true) === 1
      if (!pcm || v.getUint16(o + 10, true) !== 1 || v.getUint16(o + 22, true) !== 16)
        throw new Error('clips must be mono 16-bit PCM')
      rate = v.getUint32(o + 12, true)
    } else if (id === 'data') {
      if (!rate) throw new Error('WAV data before fmt')
      return { rate, samples: new Uint8Array(wav, o + 8, Math.min(size, wav.byteLength - o - 8)) }
    }
    o += 8 + size + (size % 2)
  }
  throw new Error('WAV has no data chunk')
}

/** Raw PCM16 mono sample bytes -> a WAV file. */
export function wavBytes(rate: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(44 + data.byteLength)
  const v = new DataView(out.buffer)
  const str = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  v.setUint32(4, 36 + data.byteLength, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, data.byteLength, true)
  out.set(data, 44)
  return out
}

/**
 * Builds a render's timeline: clips back to back (with gaps), cues stamped at the current time,
 * and one WAV of the whole thing. Clips advance time by their real sample count, so the video
 * and the audio stay together.
 */
export class ReelBuilder {
  private rate = 0
  private t: number
  /** Audio in order: sample bytes, or seconds of silence (sized once the rate is known). */
  private parts: (Uint8Array | number)[] = []
  private clips: ReelClip[] = []
  private cues: ReelCue[] = []

  constructor(lead = 0) {
    this.t = 0
    this.gap(lead)
  }

  cue(cue: StageCue): void {
    this.cues.push({ t: this.t, cue })
  }

  gap(seconds: number): void {
    if (seconds <= 0) return
    this.parts.push(seconds)
    this.t += seconds
  }

  clip(wav: ArrayBuffer, text: string, mouth?: MouthTrack): void {
    const p = pcm16(wav)
    if (this.rate && p.rate !== this.rate)
      throw new Error(`clip sample rate ${p.rate} differs from ${this.rate}`)
    this.rate = p.rate
    const t0 = this.t
    this.parts.push(p.samples)
    this.t += p.samples.byteLength / 2 / p.rate
    this.clips.push({ t0, t1: this.t, text, ...(mouth ? { mouth } : {}) })
  }

  build(tail = 0): { reel: Reel; wav: Uint8Array } {
    if (!this.rate) throw new Error('nothing to render: no clips')
    this.gap(tail)
    const bytes = this.parts.map((p) =>
      typeof p === 'number' ? new Uint8Array(Math.round(p * this.rate) * 2) : p,
    )
    const data = new Uint8Array(bytes.reduce((n, b) => n + b.byteLength, 0))
    let o = 0
    for (const b of bytes) {
      data.set(b, o)
      o += b.byteLength
    }
    return {
      reel: { duration: this.t, clips: this.clips, cues: this.cues },
      wav: wavBytes(this.rate, data),
    }
  }
}
