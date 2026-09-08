import type { TalentConfig } from './config'

/** Per-clip lipsync track: `rate` frames per second of [openness 0..1, form -1..1]. */
export interface MouthTrack {
  rate: number
  frames: [number, number][]
}

export interface Clip {
  wav: ArrayBuffer
  seconds: number
  genSeconds: number
  mouth?: MouthTrack
}

function mouthFrom(res: Response): MouthTrack | undefined {
  const h = res.headers.get('x-mouth')
  if (!h) return undefined
  try {
    const m = JSON.parse(h) as MouthTrack
    return typeof m.rate === 'number' && Array.isArray(m.frames) ? m : undefined
  } catch {
    return undefined
  }
}

/** One sentence -> WAV bytes from the voice service (Kokoro, then RVC when the talent has one). */
export async function synthesize(
  voiceUrl: string,
  talent: TalentConfig,
  text: string,
): Promise<Clip> {
  const res = await fetch(`${voiceUrl}/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      voice: talent.voice,
      rvc: talent.rvc ?? null,
      speed: talent.speed,
      pitch: talent.pitch,
    }),
  })
  if (!res.ok) throw new Error(`voice service HTTP ${res.status}: ${await res.text()}`)
  const mouth = mouthFrom(res)
  return {
    wav: await res.arrayBuffer(),
    seconds: Number(res.headers.get('x-audio-seconds') ?? 0),
    genSeconds: Number(res.headers.get('x-gen-seconds') ?? 0),
    ...(mouth ? { mouth } : {}),
  }
}

export async function voiceHealth(voiceUrl: string): Promise<unknown> {
  const res = await fetch(`${voiceUrl}/health`)
  if (!res.ok) throw new Error(`voice service HTTP ${res.status}`)
  return res.json()
}

/** Recorded speech (a WAV of any rate) -> the same speech in an RVC model's voice. */
export async function convert(
  voiceUrl: string,
  wav: ArrayBuffer,
  rvc: string,
  pitch = 0,
): Promise<Clip> {
  const res = await fetch(`${voiceUrl}/convert?rvc=${encodeURIComponent(rvc)}&pitch=${pitch}`, {
    method: 'POST',
    headers: { 'content-type': 'audio/wav' },
    body: wav,
  })
  if (!res.ok) throw new Error(`voice service HTTP ${res.status}: ${await res.text()}`)
  return {
    wav: await res.arrayBuffer(),
    seconds: Number(res.headers.get('x-audio-seconds') ?? 0),
    genSeconds: Number(res.headers.get('x-gen-seconds') ?? 0),
  }
}

export interface Transcript {
  text: string
  seconds: number
  ms: number
}

/** A WAV of speech -> text, via the voice service's whisper. */
export async function transcribe(voiceUrl: string, wav: ArrayBuffer): Promise<Transcript> {
  const res = await fetch(`${voiceUrl}/transcribe`, {
    method: 'POST',
    headers: { 'content-type': 'audio/wav' },
    body: wav,
  })
  if (!res.ok) throw new Error(`voice service HTTP ${res.status}: ${await res.text()}`)
  return (await res.json()) as Transcript
}
