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
      Object.assign(t, { done: true, ms: ev.ms ?? null, error: ev.phase === 'error' ? (ev.message ?? 'error') : null, tokens: ev.tokens ?? null, turns: ev.turns ?? null, awaiting: ev.awaiting === true })
      return { ...s }
    }
    case 'reasoning': { const t = cur(); if (t) t.reasoning += ev.v; return { ...s } }
    case 'tool': {
      const t = cur()
      if (t) for (const [i, name] of ev.v.entries()) { const args = ev.calls?.[i]?.args; t.tools.push({ name, ...(args ? { args } : {}), done: false }) }
      return { ...s }
    }
    case 'tool_done': {
      const t = cur()
      const chip = t && [...t.tools].reverse().find((c) => c.name === ev.v && !c.done)
      if (chip) { chip.done = true; chip.ok = ev.ok !== false }
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

/**
 * How full the talent's context is, from egirl's `/sessions/:id/context` (utilization as a
 * 0-1 fraction, context_length, the session's own thinking override) with `/info` as the
 * fallback for a session that has not spoken yet.
 */
export function contextUse(ctx, info) {
  const limit = ctx?.context_length ?? info?.contextLength ?? null
  const frac = typeof ctx?.utilization === 'number' ? ctx.utilization : null
  const used = typeof ctx?.available === 'number' && limit ? limit - ctx.available : frac != null && limit ? Math.round(frac * limit) : null
  return { used, limit, pct: frac != null ? Math.round(frac * 100) : null, thinking: ctx?.thinking ?? info?.thinking ?? null }
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

/** Float samples -> 16-bit mono PCM WAV bytes. Used by the console's push-to-talk. */
export function encodeWav(samples, sampleRate) {
  const n = samples.length
  const buf = new ArrayBuffer(44 + n * 2)
  const v = new DataView(buf)
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  str(36, 'data'); v.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true) }
  return new Uint8Array(buf)
}

/** Linear-interpolation downsample; whisper wants 16 kHz. Returns the input when rates match. */
export function downsample(samples, from, to) {
  if (from === to) return samples
  const ratio = from / to
  const out = new Float32Array(Math.floor(samples.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const p = i * ratio, j = Math.floor(p), f = p - j
    out[i] = samples[j] * (1 - f) + (samples[Math.min(j + 1, samples.length - 1)] ?? samples[j]) * f
  }
  return out
}

/**
 * Mouth openness and shape at a playback time, from the per-clip track the voice service
 * computed ({rate, frames: [[open, form], ...]}). Linear between frames; closed outside the
 * clip; null when there is no track so the caller can fall back to the live analyser.
 */
export function mouthAt(track, t) {
  if (!track || !track.frames || !track.frames.length) return null
  const p = t * track.rate
  if (p < 0 || p > track.frames.length - 1 + 1) return { open: 0, form: 0 }
  const i = Math.floor(p), f = p - i
  const a = track.frames[Math.min(i, track.frames.length - 1)]
  const b = track.frames[Math.min(i + 1, track.frames.length - 1)]
  return { open: a[0] + (b[0] - a[0]) * f, form: a[1] + (b[1] - a[1]) * f }
}
