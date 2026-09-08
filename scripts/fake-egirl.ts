#!/usr/bin/env bun
/**
 * A stand-in for egirl's `POST /chat` stream, for developing Stage without a model running.
 * Emits reasoning, a tool call, then a tagged reply token by token.
 *
 *     bun run scripts/fake-egirl.ts [--port 3999]
 */
const port = Number(process.argv[process.argv.indexOf('--port') + 1] || 3999)
const REPLY =
  "[happy] Okay, chat, here's the situation. I'm sitting at tier three with two stars, and the policy is eighty-four percent sure I should rush the center. [nod] Eighty-four! That's practically a guarantee, right? If this dice roll goes badly, I'm blaming the map. [surprised] Oh no. [sad] Oh, that is so much worse than I expected."
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

Bun.serve({
  port,
  async fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/info')
      return Response.json({ name: 'fake', instance: 'fake', persona: 'dev', model: 'fake-27b', contextLength: 32768, thinking: 'low', tools: { files: true, exec: true, git: false, memory: true, browser: false, github: false, tasks: false, codeAgent: false, peers: false } })
    if (path.endsWith('/context')) return Response.json({ used: 9100, limit: 32768 })
    if (path.endsWith('/thinking')) return Response.json({ ok: true, thinking: ((await req.json().catch(() => ({}))) as { level?: string }).level })
    if (path.endsWith('/interrupt')) return Response.json({ ok: true, delivered: true })
    if (path !== '/chat') return new Response('not found', { status: 404 })
    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        const send = (o: unknown) => c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`))
        for (const w of 'Let me check the board state first.'.split(' ')) {
          send({ t: 'reasoning', v: `${w} ` })
          await sleep(120)
        }
        send({ t: 'tool', v: ['read_board'] })
        await sleep(1200)
        send({ t: 'tool_done', v: 'read_board' })
        await sleep(300)
        for (const tok of REPLY.match(/\S+\s*/g) ?? []) {
          send({ t: 'token', v: tok })
          await sleep(60)
        }
        send({ t: 'done', content: REPLY })
        c.close()
      },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  },
})
console.log(`fake egirl on http://127.0.0.1:${port}/chat`)
