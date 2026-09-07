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
