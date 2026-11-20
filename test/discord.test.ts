import { describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import { formatBatch } from '../src/batcher'
import type { DiscordConfig } from '../src/config'
import { parseConfig } from '../src/config'
import { type DiscordMessage, startDiscord, toDiscordLine, toPost } from '../src/discord'

const cfg: DiscordConfig = {
  channel_id: '42',
  name: 'niku-twitch',
  token: 'bot-token',
  reply: true,
  mirror: true,
  attach_from: ['http://192.168.8.217:8300/images/'],
  wake_words: ['niku', 'draw'],
  interval_ms: 4000,
  max_batch: 6,
}

const msg = (content: string, extra: Partial<DiscordMessage> = {}): DiscordMessage => ({
  channel_id: '42',
  content,
  author: { id: '7', username: 'birubawa', global_name: 'Biru' },
  ...extra,
})

describe('toDiscordLine', () => {
  test('a message in the channel, named by server nick, then display name, then username', () => {
    expect(toDiscordLine(msg('hi there'), cfg, '99', 5)).toEqual({
      author: 'Biru',
      text: 'hi there',
      at: 5,
      mentioned: false,
    })
    expect(toDiscordLine(msg('hi', { member: { nick: 'Biru-chan' } }), cfg, '99')?.author).toBe(
      'Biru-chan',
    )
    const bare = msg('hi', { author: { id: '7', username: 'birubawa', global_name: null } })
    expect(toDiscordLine(bare, cfg, '99')?.author).toBe('birubawa')
  })

  test('other channels, bots (her own posts) and !commands are not heard', () => {
    expect(toDiscordLine(msg('hi', { channel_id: '43' }), cfg, '99')).toBeUndefined()
    const bot = msg('hi', { author: { id: '99', username: 'NikuX', bot: true } })
    expect(toDiscordLine(bot, cfg, '99')).toBeUndefined()
    expect(toDiscordLine(msg('!rank'), cfg, '99')).toBeUndefined()
    expect(toDiscordLine(msg('   '), cfg, '99')).toBeUndefined()
  })

  test('an @mention of her or a wake word wakes her; mention ids leave the text', () => {
    const at = toDiscordLine(
      msg('<@99> how are you <@123>', { mentions: [{ id: '99' }] }),
      cfg,
      '99',
    )
    expect(at).toMatchObject({ text: 'how are you', mentioned: true })
    expect(toDiscordLine(msg('Draw a frog please'), cfg, '99')?.mentioned).toBe(true)
    expect(toDiscordLine(msg('nice <:pog:111>'), cfg, '99')?.text).toBe('nice :pog:')
  })

  test('a picture without words still reaches her, as a note', () => {
    const pic = msg('', { attachments: [{}] })
    expect(toDiscordLine(pic, cfg, '99')?.text).toBe('(sent a picture)')
    expect(toDiscordLine(msg('look', { attachments: [{}, {}] }), cfg, '99')?.text).toBe(
      'look (sent 2 pictures)',
    )
  })
})

describe('toPost', () => {
  test('cue tags out, her pictures split off, anything else left out', () => {
    const text =
      '[happy] Here it is! ![a frog](http://192.168.8.217:8300/images/frog.png) ' +
      'and ![x](http://192.168.8.1/admin.png) http://192.168.8.217:8300/images/two.png'
    const post = toPost(text, cfg.attach_from)
    expect(post.content).toBe('Here it is! and')
    expect(post.images).toEqual([
      'http://192.168.8.217:8300/images/frog.png',
      'http://192.168.8.217:8300/images/two.png',
    ])
    expect(toPost('![x](http://evil/a.png)', []).images).toEqual([])
  })

  test('long lines stop under the 2000-character cap', () => {
    expect(toPost('a'.repeat(3000), []).content.length).toBe(2000)
  })
})

describe('config and batch framing', () => {
  test('[talents.x.discord] parses with defaults and an env token', () => {
    process.env.TEST_DISCORD_TOKEN = 'from-env'
    const c = parseConfig(`
[server]
models_dir = "/tmp"
[talents.niku]
egirl_url = "http://127.0.0.1:3010"
model = "m"
[talents.niku.discord]
channel_id = "1156996056748400700"
token = "$TEST_DISCORD_TOKEN"
`)
    expect(c.talents.niku?.discord).toEqual({
      channel_id: '1156996056748400700',
      name: 'discord',
      token: 'from-env',
      reply: true,
      mirror: false,
      attach_from: [],
      wake_words: ['niku'],
      interval_ms: 4000,
      max_batch: 6,
    })
    expect(() =>
      parseConfig(`
[server]
models_dir = "/tmp"
[talents.niku]
egirl_url = "http://x"
model = "m"
[talents.niku.discord]
channel_id = "#niku-twitch"
token = "t"
`),
    ).toThrow(/channel id/)
  })

  test('a Discord batch says where it came from', () => {
    const line = { author: 'Biru', text: 'hi', at: 0, mentioned: false }
    expect(formatBatch('niku-twitch', [line], 0, undefined, 'Discord')).toStartWith(
      '[Discord chat in #niku-twitch.',
    )
    expect(formatBatch('nikuniku900', [line], 0)).toStartWith('[Twitch chat in #nikuniku900.')
  })
})

describe('startDiscord against a fake gateway and API', () => {
  function fakeGateway() {
    const received: { op: number; d: unknown }[] = []
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
          ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 50 } }))
        },
        message(ws, raw) {
          const p = JSON.parse(String(raw))
          received.push(p)
          if (p.op === 1) ws.send(JSON.stringify({ op: 11 }))
          if (p.op === 2)
            ws.send(
              JSON.stringify({
                op: 0,
                s: 1,
                t: 'READY',
                d: { user: { id: '99', username: 'NikuX' } },
              }),
            )
        },
      },
    })
    return {
      url: `ws://127.0.0.1:${srv.port}`,
      received,
      opened: () => opened,
      dispatch: (t: string, d: unknown) => sock?.send(JSON.stringify({ op: 0, s: 2, t, d })),
      kick: () => sock?.close(1001),
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

  test('identifies, hears its channel, posts text and her pictures without pings', async () => {
    const gw = fakeGateway()
    const calls: { url: string; init?: RequestInit }[] = []
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      calls.push({ url: u, init })
      if (u.endsWith('/frog.png')) return new Response(new Uint8Array([1, 2, 3]))
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const lines: string[] = []
    const logs: string[] = []
    const dc = startDiscord({
      cfg,
      onLine: (l) => lines.push(`${l.author}: ${l.text}${l.mentioned ? ' (@)' : ''}`),
      log: (m) => logs.push(m),
      gatewayUrl: gw.url,
      apiUrl: 'http://api.test',
      fetch: fakeFetch,
    })
    try {
      await until(() => dc.stats().connected)
      const identify = gw.received.find((p) => p.op === 2)?.d as { token: string; intents: number }
      expect(identify.token).toBe('bot-token')
      expect(identify.intents & (1 << 15)).toBeTruthy()
      await until(() => gw.received.some((p) => p.op === 1)) // heartbeats flow

      gw.dispatch('MESSAGE_CREATE', msg('niku draw a frog'))
      gw.dispatch('MESSAGE_CREATE', msg('elsewhere', { channel_id: '1' }))
      await until(() => lines.length === 1)
      expect(lines).toEqual(['Biru: niku draw a frog (@)'])

      dc.post('[happy] Here! ![frog](http://192.168.8.217:8300/images/frog.png) @everyone')
      await until(() => dc.stats().posted === 1)
      const post = calls.find((c) => c.url === 'http://api.test/channels/42/messages')
      expect(new Headers(post?.init?.headers).get('Authorization')).toBe('Bot bot-token')
      const form = post?.init?.body as FormData
      const payload = JSON.parse(String(form.get('payload_json')))
      expect(payload.content).toBe('Here! @everyone')
      expect(payload.allowed_mentions).toEqual({ parse: [] })
      expect(payload.attachments).toEqual([{ id: 0, filename: 'frog.png' }])
      expect((form.get('files[0]') as File).size).toBe(3)

      gw.kick()
      await until(() => gw.opened() === 2, 4000)
      expect(logs.some((l) => l.includes('retrying'))).toBe(true)
    } finally {
      dc.close()
      gw.stop()
    }
  })
})
