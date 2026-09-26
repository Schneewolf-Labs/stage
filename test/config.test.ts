import { describe, expect, test } from 'bun:test'
import { parseConfig, pickTalent } from '../src/config'

const TOML = `
[server]
models_dir = "/models"
[talents.a]
egirl_url = "http://x:3000/"
model = "a/a.model3.json"
[talents.b]
egirl_url = "http://y:3000"
model = "b/b.model3.json"
rvc = "egirl"
egirl_token = "$STAGE_TEST_TOKEN"
`

describe('parseConfig', () => {
  test('applies defaults and strips trailing slashes', () => {
    const cfg = parseConfig(TOML)
    expect(cfg.server.port).toBe(3100)
    expect(cfg.voice.url).toBe('http://127.0.0.1:8100')
    expect(cfg.talents.a?.egirl_url).toBe('http://x:3000')
    expect(cfg.talents.a?.session).toBe('stage:a')
    expect(cfg.talents.a?.voice).toBe('af_heart')
    expect(cfg.talents.a?.rvc).toBeUndefined()
    expect(cfg.talents.b?.rvc).toBe('egirl')
  })

  test('expands $ENV in tokens and omits empty ones', () => {
    process.env.STAGE_TEST_TOKEN = 'secret'
    expect(parseConfig(TOML).talents.b?.egirl_token).toBe('secret')
    delete process.env.STAGE_TEST_TOKEN
    expect(parseConfig(TOML).talents.b?.egirl_token).toBeUndefined()
  })

  test('parses the optional twitch table with defaults', () => {
    expect(parseConfig(TOML).talents.a?.twitch).toBeUndefined()
    const cfg = parseConfig(`${TOML}
[talents.a.twitch]
channel = "#NBeerbower"
ignore = ["NightBot"]
`)
    expect(cfg.talents.a?.twitch).toEqual({
      channel: 'nbeerbower',
      reply: false,
      wake_words: ['a'],
      interval_ms: 4000,
      max_batch: 6,
      ignore: ['nightbot'],
    })
    expect(() =>
      parseConfig(`${TOML}
[talents.a.twitch]
channel = "x"
nick = "bot"
`),
    ).toThrow(/both nick and token/)
  })

  test('a talent can name its egirl in wald instead of pinning a URL', () => {
    const cfg = parseConfig(`${TOML}
[wald]
url = "http://wald:8000/"
[talents.c]
egirl = "kira"
model = "c/c.model3.json"
`)
    expect(cfg.wald).toEqual({ url: 'http://wald:8000' })
    expect(cfg.talents.c?.egirl).toBe('kira')
    expect(cfg.talents.c?.egirl_url).toBe('')
    expect(cfg.talents.a?.egirl).toBeUndefined()
    expect(parseConfig(TOML).wald).toBeUndefined()
  })

  test('a pinned egirl_url wins over a wald name', () => {
    const cfg = parseConfig(`${TOML}
[wald]
url = "http://wald:8000"
[talents.c]
egirl = "kira"
egirl_url = "http://pinned:3000"
model = "c/c.model3.json"
`)
    expect(cfg.talents.c?.egirl_url).toBe('http://pinned:3000')
    expect(cfg.talents.c?.egirl).toBeUndefined()
  })

  test('a wald name needs a [wald] table, and a talent needs one of the two', () => {
    expect(() =>
      parseConfig(`${TOML}
[talents.c]
egirl = "kira"
model = "c/c.model3.json"
`),
    ).toThrow(/talents\.c\.egirl needs a \[wald\] table/)
    expect(() =>
      parseConfig(`${TOML}
[talents.c]
model = "c/c.model3.json"
`),
    ).toThrow(/talents\.c: set egirl_url, or egirl/)
    expect(() => parseConfig(`${TOML}\n[wald]\n`)).toThrow(/wald\.url/)
  })

  test('first talent is the default', () => {
    const cfg = parseConfig(TOML)
    expect(pickTalent(cfg).name).toBe('a')
    expect(pickTalent(cfg, 'b').name).toBe('b')
    expect(() => pickTalent(cfg, 'zzz')).toThrow(/unknown talent/)
  })

  test('requires a talent', () => {
    expect(() => parseConfig('[server]\nmodels_dir="/m"')).toThrow(/at least one/)
  })
})
