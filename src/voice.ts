import type { TalentConfig } from './config'

export interface Clip {
  wav: ArrayBuffer
  seconds: number
  genSeconds: number
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
  return {
    wav: await res.arrayBuffer(),
    seconds: Number(res.headers.get('x-audio-seconds') ?? 0),
    genSeconds: Number(res.headers.get('x-gen-seconds') ?? 0),
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
