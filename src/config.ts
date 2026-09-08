import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { parse } from 'smol-toml'
import { applyOverrides, readOverrides } from './persist'

export interface TwitchConfig {
  channel: string
  /** Login nick + oauth token. Both or neither; without them Stage reads anonymously and cannot post. */
  nick?: string
  token?: string
  reply: boolean
  wake_words: string[]
  interval_ms: number
  max_batch: number
  ignore: string[]
}

export interface TalentConfig {
  name: string
  egirl_url: string
  egirl_token?: string
  session: string
  model: string
  voice: string
  rvc?: string
  speed: number
  /** Semitones of f0 shift into the RVC model (e.g. +12 for a low voice into a high model). */
  pitch: number
  twitch?: TwitchConfig
}

export interface StageConfig {
  server: { host: string; port: number; models_dir: string }
  voice: { url: string }
  talents: Record<string, TalentConfig>
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** `~/x` -> home; `$NAME` -> env (empty string when unset, so optional tokens just disappear). */
export function expand(s: string): string {
  const home = s.startsWith('~/') ? homedir() + s.slice(1) : s
  return home.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, k: string) => process.env[k] ?? '')
}

function str(o: Record<string, unknown>, k: string, where: string, fallback?: string): string {
  const v = o[k] ?? fallback
  if (typeof v !== 'string' || !v) throw new Error(`${where}.${k} must be a non-empty string`)
  return expand(v)
}

function num(o: Record<string, unknown>, k: string, fallback: number): number {
  const v = o[k] ?? fallback
  if (typeof v !== 'number') throw new Error(`${k} must be a number`)
  return v
}

function strList(
  o: Record<string, unknown>,
  k: string,
  where: string,
  fallback: string[],
): string[] {
  const v = o[k] ?? fallback
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string'))
    throw new Error(`${where}.${k} must be a list of strings`)
  return v.map((x) => x.toLowerCase())
}

function parseTwitch(raw: unknown, name: string): TwitchConfig | undefined {
  if (raw === undefined) return undefined
  const w = `talents.${name}.twitch`
  if (!isObj(raw)) throw new Error(`${w} must be a table`)
  const nick = typeof raw.nick === 'string' ? raw.nick.toLowerCase() : ''
  const token = typeof raw.token === 'string' ? expand(raw.token) : ''
  if ((nick === '') !== (token === ''))
    throw new Error(`${w}: set both nick and token to post, or neither to read anonymously`)
  const reply = raw.reply ?? false
  if (typeof reply !== 'boolean') throw new Error(`${w}.reply must be a boolean`)
  return {
    channel: str(raw, 'channel', w).toLowerCase().replace(/^#/, ''),
    ...(nick ? { nick, token } : {}),
    reply,
    wake_words: strList(raw, 'wake_words', w, [name]),
    interval_ms: num(raw, 'interval_ms', 4000),
    max_batch: num(raw, 'max_batch', 6),
    ignore: strList(raw, 'ignore', w, []),
  }
}

export function parseConfig(text: string): StageConfig {
  const raw = parse(text)
  const server = isObj(raw.server) ? raw.server : {}
  const voice = isObj(raw.voice) ? raw.voice : {}
  const talentsRaw = isObj(raw.talents) ? raw.talents : {}
  const talents: Record<string, TalentConfig> = {}
  for (const [name, t] of Object.entries(talentsRaw)) {
    if (!isObj(t)) throw new Error(`talents.${name} must be a table`)
    const w = `talents.${name}`
    const token = typeof t.egirl_token === 'string' ? expand(t.egirl_token) : ''
    const rvc = typeof t.rvc === 'string' && t.rvc ? t.rvc : undefined
    const twitch = parseTwitch(t.twitch, name)
    talents[name] = {
      name,
      egirl_url: str(t, 'egirl_url', w).replace(/\/$/, ''),
      ...(token ? { egirl_token: token } : {}),
      session: str(t, 'session', w, `stage:${name}`),
      model: str(t, 'model', w),
      voice: str(t, 'voice', w, 'af_heart'),
      ...(rvc ? { rvc } : {}),
      speed: num(t, 'speed', 1.0),
      pitch: num(t, 'pitch', 0),
      ...(twitch ? { twitch } : {}),
    }
  }
  if (Object.keys(talents).length === 0)
    throw new Error('at least one [talents.<name>] is required')
  return {
    server: {
      host: str(server, 'host', 'server', '127.0.0.1'),
      port: num(server, 'port', 3100),
      models_dir: resolve(str(server, 'models_dir', 'server')),
    },
    voice: { url: str(voice, 'url', 'voice', 'http://127.0.0.1:8100').replace(/\/$/, '') },
    talents,
  }
}

export function loadConfig(path = 'stage.toml'): StageConfig {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`cannot read ${path} (copy stage.example.toml to stage.toml)`)
  }
  const cfg = parseConfig(text)
  // Console changes (voice, model) saved in stage.d/<talent>.toml win over stage.toml.
  for (const t of Object.values(cfg.talents)) applyOverrides(t, readOverrides(t.name))
  return cfg
}

export function pickTalent(cfg: StageConfig, name?: string): TalentConfig {
  const key = name ?? Object.keys(cfg.talents)[0]
  const t = key ? cfg.talents[key] : undefined
  if (!t) throw new Error(`unknown talent "${name}" (have: ${Object.keys(cfg.talents).join(', ')})`)
  return t
}
