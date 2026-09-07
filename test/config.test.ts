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
