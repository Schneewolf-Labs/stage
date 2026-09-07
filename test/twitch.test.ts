import { describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { TwitchConfig } from '../src/config'
import { formatReply, parseIrcLine, startTwitch, toChatLine } from '../src/twitch'

const PRIVMSG =
  '@badge-info=;badges=broadcaster/1;color=#FF69B4;display-name=Kanade\\sFan;id=abc;mod=0;user-id=1 ' +
  ':kanade_fan!kanade_fan@kanade_fan.tmi.twitch.tv PRIVMSG #nbeerbower :is this thing live? :3'

const cfg: TwitchConfig = {
  channel: 'nbeerbower',
  nick: 'springfield_bot',
  token: 'oauth:x',
  reply: false,
  wake_words: ['springfield'],
  interval_ms: 4000,
  max_batch: 6,
  ignore: ['nightbot'],
}

const privmsg = (nick: string, text: string, tags = '') =>
  parseIrcLine(`${tags}:${nick}!${nick}@${nick}.tmi.twitch.tv PRIVMSG #nbeerbower :${text}`)

describe('parseIrcLine', () => {
  test('tags, prefix, command, params and trailing with an inner colon', () => {
    const m = parseIrcLine(PRIVMSG)
    expect(m?.command).toBe('PRIVMSG')
    expect(m?.prefix).toBe('kanade_fan!kanade_fan@kanade_fan.tmi.twitch.tv')
    expect(m?.params).toEqual(['#nbeerbower', 'is this thing live? :3'])
    expect(m?.tags['display-name']).toBe('Kanade Fan')
    expect(m?.tags['badge-info']).toBe('')
  })

  test('server messages without tags or prefix', () => {
    expect(parseIrcLine('PING :tmi.twitch.tv')).toEqual({
      tags: {},
      prefix: undefined,
      command: 'PING',
      params: ['tmi.twitch.tv'],
    })
    const welcome = parseIrcLine(':tmi.twitch.tv 001 justinfan123 :Welcome, GLHF!')
    expect(welcome?.command).toBe('001')
    expect(welcome?.params).toEqual(['justinfan123', 'Welcome, GLHF!'])
    expect(parseIrcLine(':tmi.twitch.tv RECONNECT')?.command).toBe('RECONNECT')
    expect(parseIrcLine('')).toBeUndefined()
  })
})

describe('toChatLine', () => {
  test('display name, text, and wake-word mention', () => {
    const m = parseIrcLine(PRIVMSG)
    if (!m) throw new Error('parse failed')
    const l = toChatLine(m, cfg, 42)
    expect(l).toEqual({
      author: 'Kanade Fan',
      text: 'is this thing live? :3',
      at: 42,
      mentioned: false,
    })
    const hit = privmsg('someone', 'Springfield are you real')
    if (!hit) throw new Error('parse failed')
    expect(toChatLine(hit, cfg)?.mentioned).toBe(true)
    const at = privmsg('someone', 'yo @Springfield_Bot')
    if (!at) throw new Error('parse failed')
    expect(toChatLine(at, cfg)?.mentioned).toBe(true)
  })

  test('falls back to the nick and unwraps /me', () => {
    const m = privmsg('lurker', '\x01ACTION waves at the screen\x01')
    if (!m) throw new Error('parse failed')
    expect(toChatLine(m, cfg)).toMatchObject({ author: 'lurker', text: 'waves at the screen' })
  })

  test('ignores ourselves, listed bots, bot commands, and non-PRIVMSG', () => {
    for (const m of [
      privmsg('springfield_bot', 'hello chat'),
      privmsg('nightbot', 'follow the socials'),
      privmsg('viewer', '!uptime'),
      parseIrcLine(':tmi.twitch.tv NOTICE * :Login authentication failed'),
    ]) {
      if (!m) throw new Error('parse failed')
      expect(toChatLine(m, cfg)).toBeUndefined()
    }
  })
})

describe('formatReply', () => {
  test('strips cue tags, flattens whitespace, truncates to the chat cap', () => {
    expect(formatReply('[happy] Hi chat!\n\nGood to  see you. [nod]')).toBe(
      'Hi chat! Good to see you.',
    )
    const long = formatReply('a'.repeat(600))
    expect(long.length).toBe(480)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('startTwitch against a fake Twitch', () => {
  /** A one-channel IRC server: records what the client sends, lets the test push lines. */
  function fakeTwitch() {
    const received: string[] = []
    let sock: ServerWebSocket<unknown> | undefined
    let opened = 0
    const srv = Bun.serve<unknown>({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req, s) {
        return s.upgrade(req, { data: undefined }) ? undefined : new Response('no', { status: 400 })
      },
      websocket: {
        open(ws) {
          sock = ws
          opened++
        },
        message(_ws, raw) {
          received.push(String(raw))
        },
      },
    })
    return {
      url: `ws://127.0.0.1:${srv.port}`,
      received,
      opened: () => opened,
      push: (line: string) => sock?.send(`${line}\r\n`),
      kick: () => sock?.close(),
      stop: () => srv.stop(true),
    }
  }
  const until = async (pred: () => boolean, ms = 2000): Promise<void> => {
    const t0 = Date.now()
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error('timed out')
      await Bun.sleep(10)
    }
  }

  test('anonymous handshake, PONG, PRIVMSG delivery, no posting, reconnect', async () => {
    const fake = fakeTwitch()
    const lines: string[] = []
    const logs: string[] = []
    const anon: TwitchConfig = { ...cfg, nick: undefined, token: undefined }
    const tw = startTwitch({
      cfg: anon,
      onLine: (l) => lines.push(l.text),
      log: (m) => logs.push(m),
      url: fake.url,
    })
    try {
      await until(() => fake.received.length >= 3)
      expect(fake.received[0]).toBe('CAP REQ :twitch.tv/tags twitch.tv/commands')
      expect(fake.received[1]).toMatch(/^NICK justinfan\d+$/)
      expect(fake.received[2]).toBe('JOIN #nbeerbower')

      fake.push(':tmi.twitch.tv 001 justinfan1 :Welcome, GLHF!')
      await until(() => tw.stats().connected)
      fake.push('PING :tmi.twitch.tv')
      await until(() => fake.received.includes('PONG :tmi.twitch.tv'))

      fake.push(PRIVMSG)
      fake.push(':nightbot!nightbot@nightbot.tmi.twitch.tv PRIVMSG #nbeerbower :ignored')
      await until(() => lines.length === 1)
      expect(lines).toEqual(['is this thing live? :3'])

      tw.send('hello')
      expect(tw.stats().sent).toBe(0)
      expect(logs.some((m) => m.includes('not posting'))).toBe(true)

      fake.kick()
      await until(() => fake.opened() === 2, 3000)
      expect(logs.some((m) => m.includes('retrying in 1s'))).toBe(true)
    } finally {
      tw.close()
      fake.stop()
    }
  })

  test('authenticated handshake sends PASS before NICK and can post', async () => {
    const fake = fakeTwitch()
    const tw = startTwitch({
      cfg: { ...cfg, token: 'abc' },
      onLine: () => {},
      log: () => {},
      url: fake.url,
    })
    try {
      await until(() => fake.received.length >= 4)
      expect(fake.received.slice(1, 3)).toEqual(['PASS oauth:abc', 'NICK springfield_bot'])
      fake.push(':tmi.twitch.tv 001 springfield_bot :Welcome, GLHF!')
      await until(() => tw.stats().connected)
      tw.send('[happy] hi chat')
      await until(() => fake.received.includes('PRIVMSG #nbeerbower :hi chat'))
      expect(tw.stats().sent).toBe(1)
    } finally {
      tw.close()
      fake.stop()
    }
  })
})
