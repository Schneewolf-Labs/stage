import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { riskyTools } from '../web/core.js'
import type { StageConfig } from './config'
import { brain, egirlUp } from './egirl'
import { voiceHealth } from './voice'

export interface Check {
  name: string
  ok: boolean
  detail: string
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
