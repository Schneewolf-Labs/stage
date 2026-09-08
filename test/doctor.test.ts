import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StageConfig } from '../src/config'
import { doctor } from '../src/doctor'

const dir = mkdtempSync(join(tmpdir(), 'stage-doctor-'))
mkdirSync(join(dir, 'ok'))
writeFileSync(join(dir, 'ok', 'ok.model3.json'), '{"Version":3}')
const voice = Bun.serve({ port: 0, fetch: () => Response.json({ device: 'cpu', rvc: ['egirl'] }) })
const egirl = Bun.serve({
  port: 0,
  fetch: () => Response.json({ name: 'e', tools: { exec: true } }),
})

const cfg = (model: string, rvc?: string): StageConfig => ({
  server: { host: '127.0.0.1', port: 3100, models_dir: dir },
  voice: { url: `http://127.0.0.1:${voice.port}` },
  talents: {
    t: {
      name: 't',
      egirl_url: `http://127.0.0.1:${egirl.port}`,
      session: 's',
      model,
      voice: 'af_heart',
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
    expect(r.every((c) => typeof c.detail === 'string')).toBe(true)
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
