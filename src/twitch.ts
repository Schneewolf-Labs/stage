import { parseLine } from './chunker'
import type { TwitchConfig } from './config'
import type { ChatLine } from './types'

export const TWITCH_IRC_URL = 'wss://irc-ws.chat.twitch.tv:443'
const MAX_REPLY_CHARS = 480
const MAX_BACKOFF_MS = 30_000

export interface IrcMessage {
  tags: Record<string, string>
  /** `nick!user@host`, or the server name. */
  prefix?: string
  command: string
  params: string[]
}

const TAG_ESCAPES: Record<string, string> = { ':': ';', s: ' ', r: '\r', n: '\n', '\\': '\\' }
/** `/me text` arrives as CTCP ACTION: `\x01ACTION text\x01`. */
const CTCP = '\x01'
const ACTION = `${CTCP}ACTION `

/** `[@tags ][:prefix ]COMMAND [params] [:trailing]`, the IRCv3 line Twitch sends. */
export function parseIrcLine(line: string): IrcMessage | undefined {
  let rest = line.trim()
  if (!rest) return undefined
  const tags: Record<string, string> = {}
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ')
    if (sp === -1) return undefined
    for (const kv of rest.slice(1, sp).split(';')) {
      const eq = kv.indexOf('=')
      const k = eq === -1 ? kv : kv.slice(0, eq)
      const v = eq === -1 ? '' : kv.slice(eq + 1)
      tags[k] = v.replace(/\\(.)/g, (_, c: string) => TAG_ESCAPES[c] ?? c)
    }
    rest = rest.slice(sp + 1)
  }
  let prefix: string | undefined
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ')
    if (sp === -1) return undefined
    prefix = rest.slice(1, sp)
    rest = rest.slice(sp + 1)
  }
  const colon = rest.indexOf(' :')
  const trailing = colon === -1 ? undefined : rest.slice(colon + 2)
  const head = (colon === -1 ? rest : rest.slice(0, colon)).split(' ').filter(Boolean)
  const command = head.shift()
  if (!command) return undefined
  if (trailing !== undefined) head.push(trailing)
  return { tags, prefix, command, params: head }
}

const nickOf = (prefix: string | undefined): string =>
  (prefix ?? '').split('!')[0]?.toLowerCase() ?? ''

/**
 * A PRIVMSG as a ChatLine, or undefined when it is not chat Stage should hear: our own
 * messages, listed bots, and `!commands` aimed at other bots.
 */
export function toChatLine(
  msg: IrcMessage,
  cfg: TwitchConfig,
  now = Date.now(),
): ChatLine | undefined {
  if (msg.command !== 'PRIVMSG') return undefined
  const nick = nickOf(msg.prefix)
  if (!nick || nick === cfg.nick || cfg.ignore.includes(nick)) return undefined
  let text = (msg.params[1] ?? '').trim()
  if (text.startsWith(ACTION) && text.endsWith(CTCP))
    text = text.slice(ACTION.length, -CTCP.length).trim()
  if (!text || text.startsWith('!')) return undefined
  const lower = text.toLowerCase()
  const mentioned =
    cfg.wake_words.some((w) => lower.includes(w)) || (!!cfg.nick && lower.includes(`@${cfg.nick}`))
  return { author: msg.tags['display-name'] || nick, text, at: now, mentioned }
}

/** What goes back into chat: cue tags stripped, one line, under Twitch's message cap. */
export function formatReply(text: string): string {
  const flat = parseLine(text.replace(/\s+/g, ' ')).text
  return flat.length > MAX_REPLY_CHARS ? `${flat.slice(0, MAX_REPLY_CHARS - 1).trimEnd()}…` : flat
}

export interface TwitchOptions {
  cfg: TwitchConfig
  onLine: (line: ChatLine) => void
  log: (msg: string) => void
  url?: string
}

export interface TwitchHandle {
  /** Post to the channel. A no-op (logged once) without nick and token. */
  send(text: string): void
  stats(): { connected: boolean; sent: number }
  close(): void
}

/**
 * Twitch chat over its IRC WebSocket. Reads anonymously as a `justinfan` when no nick and
 * token are configured. Reconnects with backoff on close or a server RECONNECT; a failed login
 * drops to anonymous rather than looping on the same bad token.
 */
export function startTwitch({
  cfg,
  onLine,
  log,
  url = TWITCH_IRC_URL,
}: TwitchOptions): TwitchHandle {
  let auth = cfg.nick && cfg.token ? { nick: cfg.nick, token: cfg.token } : undefined
  let ws: WebSocket | undefined
  let connected = false
  let closed = false
  let attempt = 0
  let sent = 0
  let warnedReadOnly = false

  const handle = (msg: IrcMessage): void => {
    switch (msg.command) {
      case 'PING':
        ws?.send(`PONG :${msg.params[0] ?? 'tmi.twitch.tv'}`)
        return
      case '001':
        connected = true
        attempt = 0
        log(`twitch: connected as ${auth?.nick ?? 'anonymous'}, joining #${cfg.channel}`)
        return
      case 'RECONNECT':
        log('twitch: server asked us to reconnect')
        ws?.close()
        return
      case 'NOTICE':
        if (/login (authentication failed|unsuccessful)/i.test(msg.params[1] ?? '') && auth) {
          log('twitch: login failed, falling back to anonymous read')
          auth = undefined
        } else log(`twitch: ${msg.params[1] ?? 'notice'}`)
        return
      case 'PRIVMSG': {
        const line = toChatLine(msg, cfg)
        if (line) onLine(line)
        return
      }
    }
  }

  const connect = (): void => {
    if (closed) return
    const sock = new WebSocket(url)
    ws = sock
    sock.onopen = () => {
      const nick = auth?.nick ?? `justinfan${Math.floor(Math.random() * 1e5)}`
      sock.send('CAP REQ :twitch.tv/tags twitch.tv/commands')
      if (auth)
        sock.send(`PASS ${auth.token.startsWith('oauth:') ? auth.token : `oauth:${auth.token}`}`)
      sock.send(`NICK ${nick}`)
      sock.send(`JOIN #${cfg.channel}`)
    }
    sock.onmessage = (ev) => {
      for (const raw of String(ev.data).split('\r\n')) {
        const msg = parseIrcLine(raw)
        if (msg) handle(msg)
      }
    }
    sock.onerror = () => log('twitch: socket error')
    sock.onclose = () => {
      connected = false
      if (closed || ws !== sock) return
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt++)
      log(`twitch: disconnected, retrying in ${delay / 1000}s`)
      setTimeout(connect, delay)
    }
  }
  connect()

  return {
    send(text) {
      if (!auth) {
        if (!warnedReadOnly) log('twitch: no nick/token, not posting replies')
        warnedReadOnly = true
        return
      }
      const body = formatReply(text)
      if (!body || !connected) return
      ws?.send(`PRIVMSG #${cfg.channel} :${body}`)
      sent++
    },
    stats: () => ({ connected, sent }),
    close() {
      closed = true
      ws?.close()
    },
  }
}
