import { parseLine } from './chunker'
import type { DiscordConfig } from './config'
import type { ChatLine } from './types'

export const DISCORD_GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json'
export const DISCORD_API_URL = 'https://discord.com/api/v10'
const MAX_CONTENT_CHARS = 2000
const MAX_BACKOFF_MS = 30_000
/** Discord's upload cap for a bot in an unboosted server. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
/** GUILD_MESSAGES | MESSAGE_CONTENT (privileged: on in the bot's settings). */
const INTENTS = (1 << 9) | (1 << 15)

/** The parts of a gateway MESSAGE_CREATE Stage reads. */
export interface DiscordMessage {
  channel_id: string
  content: string
  author: { id: string; username: string; global_name?: string | null; bot?: boolean }
  member?: { nick?: string | null }
  mentions?: { id: string }[]
  attachments?: unknown[]
}

/**
 * A channel message as a ChatLine, or undefined when Stage should not hear it: other channels,
 * bots (her own posts included), and `!commands`. Mentions of her bot are a wake-up, like a
 * wake word; other user mentions are dropped from the text (the ids mean nothing to her).
 */
export function toDiscordLine(
  msg: DiscordMessage,
  cfg: DiscordConfig,
  selfId: string | undefined,
  now = Date.now(),
): ChatLine | undefined {
  if (msg.channel_id !== cfg.channel_id || msg.author.bot) return undefined
  const atHer = !!selfId && (msg.mentions ?? []).some((m) => m.id === selfId)
  let text = msg.content
    .replace(/<@!?\d+>|<@&\d+>|<#\d+>/g, ' ')
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/\s+/g, ' ')
    .trim()
  const pictures = msg.attachments?.length ?? 0
  if (pictures)
    text = `${text} (sent ${pictures === 1 ? 'a picture' : `${pictures} pictures`})`.trim()
  if (!text || text.startsWith('!')) return undefined
  const lower = text.toLowerCase()
  const author = msg.member?.nick || msg.author.global_name || msg.author.username
  return {
    author,
    text,
    at: now,
    mentioned: atHer || cfg.wake_words.some((w) => lower.includes(w)),
  }
}

/** What she said, as a Discord post: cue tags out, pictures split off to upload. */
export function toPost(text: string, attachFrom: string[]): { content: string; images: string[] } {
  const line = parseLine(text)
  const images = line.images
    .map((i) => i.url)
    .filter((u) => attachFrom.some((prefix) => u.startsWith(prefix)))
  const flat = line.text
  const content =
    flat.length > MAX_CONTENT_CHARS ? `${flat.slice(0, MAX_CONTENT_CHARS - 1).trimEnd()}…` : flat
  return { content, images }
}

export interface DiscordOptions {
  cfg: DiscordConfig
  onLine: (line: ChatLine) => void
  log: (msg: string) => void
  gatewayUrl?: string
  apiUrl?: string
  fetch?: typeof fetch
}

export interface DiscordHandle {
  /** Post what she said to the channel; pictures from `attach_from` are uploaded with it. */
  post(text: string): void
  stats(): { connected: boolean; posted: number; failed: number }
  close(): void
}

/**
 * One Discord channel as a second chat beside Twitch: a bare gateway connection for the channel's
 * messages, and the REST API to post what she says there. The same bot may also run elsewhere (an
 * egirl Discord instance with its own channels): each gateway session gets every event, so this
 * one answers in `channel_id` only and the other must not list it.
 *
 * Posts never ping anyone (`allowed_mentions` is empty), and pictures are uploaded only from the
 * URL prefixes in `attach_from`: she talks to strangers, so a URL she was talked into writing
 * must not make Stage fetch and publish something else on the LAN.
 */
export function startDiscord({
  cfg,
  onLine,
  log,
  gatewayUrl = DISCORD_GATEWAY_URL,
  apiUrl = DISCORD_API_URL,
  fetch: fetchFn = fetch,
}: DiscordOptions): DiscordHandle {
  let ws: WebSocket | undefined
  let connected = false
  let closed = false
  let attempt = 0
  let seq: number | null = null
  let selfId: string | undefined
  let beat: ReturnType<typeof setInterval> | undefined
  let acked = true
  let posted = 0
  let failed = 0
  let queue: Promise<void> = Promise.resolve()

  const stopBeat = (): void => {
    if (beat) clearInterval(beat)
    beat = undefined
  }

  const connect = (): void => {
    if (closed) return
    const sock = new WebSocket(gatewayUrl)
    ws = sock
    seq = null
    sock.onmessage = (ev) => {
      if (ws !== sock) return
      let p: { op: number; d?: unknown; s?: number | null; t?: string | null }
      try {
        p = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (typeof p.s === 'number') seq = p.s
      switch (p.op) {
        case 10: {
          // HELLO: heartbeat on its interval; a beat that was never acknowledged means the
          // connection is dead without having closed (see twitch.ts), so replace it.
          const interval = (p.d as { heartbeat_interval: number }).heartbeat_interval
          stopBeat()
          acked = true
          beat = setInterval(() => {
            if (ws !== sock) return
            if (!acked) {
              log('discord: heartbeat not acknowledged, reconnecting')
              sock.close(4000)
              return
            }
            acked = false
            sock.send(JSON.stringify({ op: 1, d: seq }))
          }, interval)
          sock.send(
            JSON.stringify({
              op: 2,
              d: {
                token: cfg.token,
                intents: INTENTS,
                properties: { os: 'linux', browser: 'stage', device: 'stage' },
              },
            }),
          )
          return
        }
        case 11:
          acked = true
          return
        case 1:
          sock.send(JSON.stringify({ op: 1, d: seq }))
          return
        case 7:
        case 9:
          log(`discord: gateway asked for a ${p.op === 7 ? 'reconnect' : 'new session'}`)
          sock.close(4000)
          return
        case 0:
          if (p.t === 'READY') {
            const d = p.d as { user: { id: string; username: string } }
            selfId = d.user.id
            connected = true
            attempt = 0
            log(`discord: connected as ${d.user.username}, listening in ${cfg.channel_id}`)
          } else if (p.t === 'MESSAGE_CREATE') {
            const line = toDiscordLine(p.d as DiscordMessage, cfg, selfId)
            if (line) onLine(line)
          }
          return
      }
    }
    sock.onerror = () => log('discord: socket error')
    sock.onclose = (ev) => {
      if (ws !== sock) return
      connected = false
      stopBeat()
      if (closed) return
      // 4004 bad token, 4013/4014 intents not allowed: retrying cannot fix those.
      if ([4004, 4013, 4014].includes(ev.code)) {
        log(`discord: gateway refused us (${ev.code} ${ev.reason}); not retrying`)
        return
      }
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt++)
      log(`discord: disconnected (${ev.code}), retrying in ${delay / 1000}s`)
      setTimeout(connect, delay)
    }
  }
  connect()

  const upload = async (text: string): Promise<void> => {
    const { content, images } = toPost(text, cfg.attach_from)
    if (!content && !images.length) return
    const form = new FormData()
    const files: { id: number; filename: string }[] = []
    for (const url of images) {
      try {
        const res = await fetchFn(url, { signal: AbortSignal.timeout(20_000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const blob = await res.blob()
        if (blob.size > MAX_IMAGE_BYTES) throw new Error(`${blob.size} bytes, over the cap`)
        const filename = new URL(url).pathname.split('/').pop() || `picture-${files.length}.png`
        form.append(`files[${files.length}]`, blob, filename)
        files.push({ id: files.length, filename })
      } catch (e) {
        log(`discord: could not attach ${url}: ${e}`)
      }
    }
    if (!content && !files.length) return
    form.append(
      'payload_json',
      JSON.stringify({ content, allowed_mentions: { parse: [] }, attachments: files }),
    )
    for (let tries = 0; tries < 3; tries++) {
      const res = await fetchFn(`${apiUrl}/channels/${cfg.channel_id}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${cfg.token}` },
        body: form,
      })
      if (res.ok) {
        posted++
        return
      }
      if (res.status === 429) {
        const wait = Number(
          ((await res.json().catch(() => ({}))) as { retry_after?: number }).retry_after ?? 1,
        )
        await new Promise((r) => setTimeout(r, Math.min(30, wait) * 1000))
        continue
      }
      throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
    }
    throw new Error('rate limited three times')
  }

  return {
    post(text) {
      if (!text.trim()) return
      // In order, one at a time: a picture's upload must not let the next line overtake it.
      queue = queue
        .then(() => upload(text))
        .catch((e) => {
          failed++
          log(`discord: post failed: ${e}`)
        })
    },
    stats: () => ({ connected, posted, failed }),
    close() {
      closed = true
      stopBeat()
      ws?.close()
    },
  }
}
