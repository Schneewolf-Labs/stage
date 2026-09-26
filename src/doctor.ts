import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { riskyTools } from '../web/core.js'
import type { StageConfig, TalentConfig } from './config'
import { brain, egirlUp } from './egirl'
import { synthesize, transcribe, voiceHealth } from './voice'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

/** What the round-trip check says and expects to hear back: plain words, no digits to spell out. */
export const ROUND_TRIP_TEXT = 'The quick brown fox jumps over the lazy dog.'
/**
 * Whisper base.en hears clean Kokoro speech word for word; RVC can cost a word or two. Below
 * 60% the voice is not something a viewer would understand (wrong pitch, broken RVC model).
 */
const ROUND_TRIP_MIN = 0.6

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

/** Fraction of the expected words that were heard; each heard word is matched at most once. */
export function heardScore(expected: string, heard: string): number {
  const want = words(expected)
  if (!want.length) return 0
  const got = words(heard)
  let hit = 0
  for (const w of want) {
    const i = got.indexOf(w)
    if (i >= 0) {
      hit++
      got.splice(i, 1)
    }
  }
  return hit / want.length
}

/** Speak a known sentence in the talent's voice and see whether whisper hears it. */
async function roundTrip(voiceUrl: string, t: TalentConfig): Promise<Check> {
  const name = `talent ${t.name}: voice round-trip`
  try {
    const t0 = performance.now()
    const clip = await synthesize(voiceUrl, t, ROUND_TRIP_TEXT)
    const t1 = performance.now()
    const heard = await transcribe(voiceUrl, clip.wav)
    const ms = (x: number): string => `${Math.round(x)} ms`
    const score = heardScore(ROUND_TRIP_TEXT, heard.text)
    return {
      name,
      ok: score >= ROUND_TRIP_MIN,
      detail: `${Math.round(score * 100)}% heard: "${heard.text}" (tts ${ms(t1 - t0)}, whisper ${ms(performance.now() - t1)})`,
    }
  } catch (e) {
    return { name, ok: false, detail: (e as Error).message }
  }
}

/**
 * `stage doctor`: everything that has to be true before `serve` is useful, in one pass.
 * Read-only, bounded (every network call times out), and honest about what it could not
 * check: a check is only ok when the thing was actually seen working.
 */
export async function doctor(cfg: StageConfig): Promise<Check[]> {
  const out: Check[] = []
  const modelsOk = existsSync(cfg.server.models_dir)
  out.push({ name: 'models_dir', ok: modelsOk, detail: cfg.server.models_dir })

  const voice = await voiceHealth(cfg.voice.url).catch((e: Error) => ({ error: e.message }))
  const v = voice as { error?: string; device?: string; rvc?: string[]; whisper?: string }
  out.push({
    name: 'voice service',
    ok: !v.error,
    detail: v.error
      ? `${cfg.voice.url}: ${v.error}`
      : `${cfg.voice.url} on ${v.device ?? '?'}, rvc: ${v.rvc?.join(', ') || 'none'}, whisper: ${v.whisper ?? 'n/a'}`,
  })

  for (const t of Object.values(cfg.talents)) {
    const model = resolve(cfg.server.models_dir, t.model)
    out.push({
      name: `talent ${t.name}: model`,
      ok: modelsOk && existsSync(model),
      detail: t.model,
    })
    if (t.rvc)
      out.push({
        name: `talent ${t.name}: rvc model`,
        ok: !v.error && (v.rvc ?? []).includes(t.rvc),
        detail: v.error
          ? 'voice service down'
          : (v.rvc ?? []).includes(t.rvc)
            ? t.rvc
            : `${t.rvc} not in services/voice/models`,
      })
    out.push(
      v.error
        ? { name: `talent ${t.name}: voice round-trip`, ok: false, detail: 'voice service down' }
        : !v.whisper
          ? {
              name: `talent ${t.name}: voice round-trip`,
              ok: false,
              detail: 'voice service has no whisper',
            }
          : await roundTrip(cfg.voice.url, t),
    )
    const up = await egirlUp(t)
    out.push({
      name: `talent ${t.name}: egirl`,
      ok: up,
      detail: up ? t.egirl_url : `${t.egirl_url} unreachable`,
    })
    const b = up ? await brain(t) : undefined
    const info = b?.ok ? (b.info as { tools?: Record<string, unknown> }) : undefined
    const risky = riskyTools(info?.tools)
    out.push({
      name: `talent ${t.name}: tools`,
      ok: !!info && risky.length === 0,
      detail: !info
        ? 'unknown (egirl not reachable)'
        : risky.length
          ? `world-acting tools enabled: ${risky.join(', ')}`
          : 'locked down',
    })
  }
  return out
}
