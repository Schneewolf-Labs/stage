/* Pure logic shared by the console and the render page, kept free of the DOM so bun:test can
 * exercise it (test/core.test.ts). Everything here is a plain function over plain data. */

const MAX_TURNS = 50

/** Console state for the chat timeline and what is audible. */
export function turnReducer(state, ev) {
  const s = state ?? { turns: [], speaking: false, caption: '', currentClipId: null, clipText: {}, sentenceTurn: {} }
  const cur = () => s.turns.find((t) => !t.done)
  switch (ev.type) {
    case 'turn': {
      if (ev.phase === 'start') {
        const t = { message: ev.message ?? '', reasoning: '', tools: [], sentences: [], done: false, error: null, ms: null, t0: Date.now() }
        return { ...s, turns: [t, ...s.turns].slice(0, MAX_TURNS) }
      }
      const t = cur()
      if (!t) return s
      Object.assign(t, { done: true, ms: ev.ms ?? null, error: ev.phase === 'error' ? (ev.message ?? 'error') : null })
      return { ...s }
    }
    case 'reasoning': { const t = cur(); if (t) t.reasoning += ev.v; return { ...s } }
    case 'tool': { const t = cur(); if (t) for (const name of ev.v) t.tools.push({ name, done: false }); return { ...s } }
    case 'tool_done': {
      const t = cur()
      const chip = t && [...t.tools].reverse().find((c) => c.name === ev.v && !c.done)
      if (chip) chip.done = true
      return { ...s }
    }
    case 'clip': {
      const t = cur() ?? s.turns[0]
      if (t) { t.sentences.push({ id: ev.id, text: ev.text, status: 'queued' }); s.sentenceTurn[ev.id] = t }
      s.clipText[ev.id] = ev.text
      return { ...s }
    }
    case 'speak': s.clipText[ev.id] = ev.text; return { ...s }
    case 'playing': {
      if (s.currentClipId === ev.id) return s
      mark(s, ev.id, 'now')
      return { ...s, speaking: true, currentClipId: ev.id, caption: s.clipText[ev.id] ?? '' }
    }
    case 'spoke': {
      mark(s, ev.id, 'done')
      return s.currentClipId === ev.id ? { ...s, speaking: false, currentClipId: null, caption: '' } : { ...s }
    }
    case 'stop': return { ...s, speaking: false, currentClipId: null, caption: '' }
    default: return s
  }
}
function mark(s, id, status) {
  const sen = s.sentenceTurn[id]?.sentences.find((x) => x.id === id)
  if (sen) sen.status = status
}

export function clipStats(clips) {
  if (!clips.length) return { count: 0, lastGenMs: null, lastSeconds: null, avgRtf: null }
  const last = clips[clips.length - 1]
  const rtf = clips.map((c) => c.genMs / 1000 / (c.seconds || 1))
  return { count: clips.length, lastGenMs: last.genMs, lastSeconds: last.seconds, avgRtf: rtf.reduce((a, b) => a + b, 0) / rtf.length }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
export function clampTransform(t) {
  const n = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  return { x: clamp(n(t?.x, 0), -1, 1), y: clamp(n(t?.y, 0), -1, 1), scale: clamp(n(t?.scale, 1), 0.1, 4) }
}

/** Pixel placement for a model: fit to 95% of the screen height at identity, then offset/scale. */
export function fitModel(screen, model, t) {
  const base = Math.min(screen.w / model.w, screen.h / model.h) * 0.95
  return { scale: base * t.scale, x: screen.w / 2 + (t.x * screen.w) / 2, y: screen.h / 2 + (t.y * screen.h) / 2 }
}

/** Enabled egirl tools that act on the world; a stage talent exposed to strangers should have none. */
const RISKY = ['browser', 'codeAgent', 'exec', 'files', 'git', 'github', 'process']
export function riskyTools(tools) {
  if (!tools) return []
  return RISKY.filter((k) => tools[k] === true).sort()
}

/** Go-live checklist. Each item: { key, label, ok, detail }. */
export function readiness({ health, egirl, modelLoaded }) {
  const items = []
  const voiceOk = !!health?.voice && !health.voice.error
  items.push({ key: 'server', label: 'Stage server', ok: !!health?.ok, detail: health?.ok ? 'reachable' : 'unreachable' })
  items.push({ key: 'voice', label: 'Voice service', ok: voiceOk, detail: voiceOk ? `${health.voice.device ?? 'up'}${health.voice.rvc?.length ? `, rvc: ${health.voice.rvc.join(', ')}` : ''}` : (health?.voice?.error ?? 'down') })
  items.push({ key: 'egirl', label: 'egirl instance', ok: !!egirl?.ok, detail: egirl?.ok ? (egirl.info?.model ?? 'reachable') : (egirl?.error ?? 'unreachable') })
  const risky = riskyTools(egirl?.info?.tools)
  items.push({ key: 'tools', label: 'Tools locked down', ok: !!egirl?.ok && risky.length === 0, detail: !egirl?.ok ? 'unknown' : risky.length ? `enabled: ${risky.join(', ')}` : 'no world-acting tools enabled' })
  items.push({ key: 'page', label: 'Render page connected', ok: (health?.pages ?? 0) > 0, detail: `${health?.pages ?? 0} page(s)` })
  items.push({ key: 'model', label: 'Model loaded', ok: !!modelLoaded, detail: modelLoaded ? 'ok' : 'not loaded' })
  if (health?.twitch) items.push({ key: 'twitch', label: 'Twitch chat', ok: !!health.twitch.connected, detail: health.twitch.connected ? 'connected' : 'reconnecting' })
  return items
}
