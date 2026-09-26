import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StageConfig, TalentConfig } from '../src/config'
import { startServer } from '../src/server'
import { lookupEgirl, resolveTalent } from '../src/wald'

/* ---- fakes: an egirl that answers every turn with an empty reply, and a Wald registry ---- */
const egirl = Bun.serve({
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname
    if (p === '/info') return Response.json({ name: 'kira', tools: {} })
    if (p === '/chat') {
      const end = { t: 'run_end', v: { content: '', output_tokens: 1, turns: 1 } }
      return new Response(`data: ${JSON.stringify(end)}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    return new Response('nf', { status: 404 })
  },
})
const egirlUrl = `http://127.0.0.1:${egirl.port}`
/** Only push-to-talk is needed: it runs a turn and logs, rather than throws, when it fails. */
const voice = Bun.serve({
  port: 0,
  fetch: () => Response.json({ text: 'are you there', seconds: 1, ms: 1 }),
})

/** Rows shaped like Wald's AgentOut (src/wald/schemas.py); `kira` moves when a test says so. */
let kiraUrl: string | null = egirlUrl
const lookups: string[] = []
const agent = (slug: string, over: Record<string, unknown>) => ({
  id: '00000000-0000-0000-0000-000000000000',
  slug,
  name: slug,
  description: '',
  capabilities: [],
  endpoint_url: `${egirlUrl}/`,
  protocol: 'egirl-peer/1',
  auth: {},
  owner: null,
  status: 'active',
  agent_card: {},
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...over,
})
const wald = Bun.serve({
  port: 0,
  fetch(req) {
    const slug = decodeURIComponent(new URL(req.url).pathname.replace(/^\/agents\//, ''))
    lookups.push(slug)
    if (slug === 'kira') return Response.json(agent('kira', { endpoint_url: kiraUrl }))
    if (slug === 'a2a') return Response.json(agent('a2a', { protocol: 'a2a' }))
    if (slug === 'asleep') return Response.json(agent('asleep', { status: 'offline' }))
    if (slug === 'nowhere') return Response.json(agent('nowhere', { endpoint_url: null }))
    return Response.json({ detail: `agent '${slug}' not found` }, { status: 404 })
  },
})
const waldUrl = `http://127.0.0.1:${wald.port}`

const modelsDir = mkdtempSync(join(tmpdir(), 'stage-wald-models-'))
mkdirSync(join(modelsDir, 'a'))
writeFileSync(join(modelsDir, 'a', 'a.model3.json'), '{"Version":3}')
const overridesDir = mkdtempSync(join(tmpdir(), 'stage-wald-d-'))

const talentNamed = (slug: string, url = ''): TalentConfig => ({
  name: 'kira',
  egirl_url: url,
  egirl: slug,
  session: 'stage:kira',
  model: 'a/a.model3.json',
  voice: 'af_heart',
  speed: 1,
  pitch: 0,
})
const cfgFor = (t: TalentConfig): StageConfig => ({
  server: { host: '127.0.0.1', port: 0, models_dir: modelsDir },
  voice: { url: `http://127.0.0.1:${voice.port}` },
  wald: { url: waldUrl },
  talents: { [t.name]: t },
})

afterAll(() => {
  egirl.stop(true)
  voice.stop(true)
  wald.stop(true)
  rmSync(modelsDir, { recursive: true, force: true })
  rmSync(overridesDir, { recursive: true, force: true })
})

describe('lookupEgirl', () => {
  test('returns an active egirl-peer/1 agent’s endpoint without a trailing slash', async () => {
    expect(await lookupEgirl(waldUrl, 'kira')).toBe(egirlUrl)
  })

  test('fails legibly, naming the slug and the reason', async () => {
    await expect(lookupEgirl(waldUrl, 'ghost')).rejects.toThrow(/"ghost" is not registered/)
    await expect(lookupEgirl(waldUrl, 'a2a')).rejects.toThrow(
      /"a2a" speaks "a2a", not egirl-peer\/1/,
    )
    await expect(lookupEgirl(waldUrl, 'asleep')).rejects.toThrow(/"asleep" is offline, not active/)
    await expect(lookupEgirl(waldUrl, 'nowhere')).rejects.toThrow(/"nowhere" has no endpoint_url/)
    await expect(lookupEgirl('http://127.0.0.1:9', 'kira')).rejects.toThrow(
      /wald http:\/\/127\.0\.0\.1:9 unreachable.*"kira"/,
    )
  })
})

describe('resolveTalent', () => {
  test('fills in a wald-named talent’s egirl_url', async () => {
    const t = talentNamed('kira')
    expect(await resolveTalent(cfgFor(t), t)).toBe(true)
    expect(t.egirl_url).toBe(egirlUrl)
    expect(await resolveTalent(cfgFor(t), t)).toBe(false)
  })

  test('leaves a pinned talent alone', async () => {
    const t: TalentConfig = { ...talentNamed('kira', 'http://pinned:3000') }
    delete t.egirl
    const before = lookups.length
    expect(await resolveTalent(cfgFor(t), t)).toBe(false)
    expect(t.egirl_url).toBe('http://pinned:3000')
    expect(lookups.length).toBe(before)
  })
})

describe('serve with a wald-named talent', () => {
  test('asks wald again after a turn fails on an unreachable egirl', async () => {
    // Resolved at startup to an address egirl has since left.
    kiraUrl = 'http://127.0.0.1:9'
    const t = talentNamed('kira')
    const cfg = cfgFor(t)
    await resolveTalent(cfg, t)
    expect(t.egirl_url).toBe('http://127.0.0.1:9')
    kiraUrl = egirlUrl

    const logs: string[] = []
    const server = startServer({ cfg, talent: t, log: (m) => logs.push(m), overridesDir })
    const base = `http://127.0.0.1:${server.port}`
    try {
      const heard = await fetch(`${base}/transcribe?send=1`, {
        method: 'POST',
        body: new Uint8Array(64),
      }).then((r) => r.json())
      expect(heard.sent).toBe(true)
      // Queued behind the failed turn and the lookup it triggers.
      const r = await fetch(`${base}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hi' }),
      })
      expect(r.ok).toBe(true)
      expect(logs.some((l) => l.includes('mic turn failed'))).toBe(true)
      expect(t.egirl_url).toBe(egirlUrl)
      expect(logs.some((l) => l.includes('egirl kira moved'))).toBe(true)
    } finally {
      server.stop(true)
    }
  })
})
