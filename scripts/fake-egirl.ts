#!/usr/bin/env bun
/**
 * A stand-in for egirl's `POST /chat` stream, for developing Stage without a model running.
 * Emits reasoning, a tool call, then a tagged reply token by token, in the frame shapes of
 * egirl's session bus (src/agent/session-events.ts there).
 *
 *     bun run scripts/fake-egirl.ts [--port 3999]
 */
const port = Number(process.argv[process.argv.indexOf('--port') + 1] || 3999)
const REPLY =
  "[happy] Okay, chat, here's the situation. I'm sitting at tier three with two stars, and the policy is eighty-four percent sure I should rush the center. [nod] Eighty-four! That's practically a guarantee, right? If this dice roll goes badly, I'm blaming the map. [surprised] Oh no. [sad] Oh, that is so much worse than I expected."
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** A message containing "ask" parks the turn on a question, the way egirl's report tool does. */
const asks: { id: string; question: string; at: number }[] = []

Bun.serve({
  port,
  async fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/info')
      return Response.json({ name: 'fake', instance: 'fake', persona: 'dev', model: 'fake-27b', contextLength: 32768, thinking: 'low', tools: { files: true, exec: true, git: false, memory: true, browser: false, github: false, tasks: false, codeAgent: false, peers: false } })
    // Shapes are egirl's own (src/api.ts in egirl), so the console sees what a real instance sends.
    if (path.endsWith('/context'))
      return Response.json({ session_id: 'stage:dev', utilization: 0.28, context_length: 32768, system_prompt_tokens: 2100, message_count: 9, message_tokens: 7000, has_summary: false, summary_tokens: 0, available: 23668, thinking: null })
    if (path.endsWith('/thinking')) return Response.json({ ok: true, thinking: ((await req.json().catch(() => ({}))) as { level?: string }).level })
    if (path.endsWith('/interrupt')) {
      const action = ((await req.json().catch(() => ({}))) as { action?: string }).action
      if (action !== 'abort' && action !== 'inject') return Response.json({ error: "action must be 'abort' or 'inject'" }, { status: 400 })
      return Response.json({ ok: true, delivered: true })
    }
    if (path.endsWith('/compact')) return Response.json({ ok: true, messages_before: 9, messages_after: 4, dropped: 5 })
    if (req.method === 'DELETE' && path.startsWith('/sessions/')) return Response.json({ ok: true })
    if (path === '/asks') return Response.json({ asks: asks.map((a) => ({ id: a.id, from: 'stage:dev', question: a.question, asked_at: a.at, kind: 'ask' })) })
    if (path.startsWith('/asks/')) {
      const id = path.split('/')[2]
      const i = asks.findIndex((a) => a.id === id)
      if (i < 0) return Response.json({ error: 'ask not found (it may have timed out)' }, { status: 404 })
      asks.splice(i, 1)
      return Response.json({ ok: true, delivered: true })
    }
    if (path !== '/chat') return new Response('not found', { status: 404 })
    const message = String(((await req.json().catch(() => ({}))) as { message?: string }).message ?? '')
    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        const send = (o: unknown) => c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`))
        c.enqueue(enc.encode(': open\n\n'))
        send({ t: 'run_start', v: { message } })
        for (const w of 'Let me check the board state first.'.split(' ')) {
          send({ t: 'reasoning', v: `${w} ` })
          await sleep(120)
        }
        send({ t: 'tool', v: [{ name: 'read_board', args: '{"round":3}' }] })
        await sleep(1200)
        send({ t: 'tool_done', v: { name: 'read_board', success: true, args: '{"round":3}', output: 'tier 3, 2 stars' } })
        await sleep(300)
        const end = (content: string, awaiting: boolean) => ({
          t: 'run_end',
          v: { content, input_tokens: 800, output_tokens: 96, turns: 2, duration_ms: 4000, aborted: false, awaiting },
        })
        if (message.includes('ask')) {
          asks.push({ id: `ask-${Date.now()}`, question: 'Chat wants me to play the risky line. Should I?', at: Date.now() })
          send(end('', true))
          c.close()
          return
        }
        for (const tok of REPLY.match(/\S+\s*/g) ?? []) {
          send({ t: 'token', v: tok })
          await sleep(60)
        }
        send(end(REPLY, false))
        c.close()
      },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  },
})
console.log(`fake egirl on http://127.0.0.1:${port}/chat`)
