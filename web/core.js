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

/* ---- widgets: boxes as fractions of the canvas, top-left corner and size, 0..1 ---- */

const MIN_BOX = 0.03
const MAX_FRAMES = 8
const DEFAULT_FRAME_BOX = { x: 0.02, y: 0.5, w: 0.25, h: 0.45 }
const r4 = (v) => Math.round(v * 1e4) / 1e4
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/** A box that stays on the canvas and is at least a little big; junk fields come from `fallback`. */
export function clampBox(b, fallback = DEFAULT_FRAME_BOX) {
  const w = r4(clamp(num(b?.w, fallback.w), MIN_BOX, 1))
  const h = r4(clamp(num(b?.h, fallback.h), MIN_BOX, 1))
  return { x: r4(clamp(num(b?.x, fallback.x), 0, 1 - w)), y: r4(clamp(num(b?.y, fallback.y), 0, 1 - h)), w, h }
}

/** Slide a box by a fraction of the canvas, keeping its size. */
export function moveBox(b, dx, dy) {
  return clampBox({ ...b, x: b.x + dx, y: b.y + dy }, b)
}

/** Drag a box's bottom-right corner. */
export function resizeBox(b, dw, dh) {
  return clampBox({ ...b, w: Math.min(b.w + dw, 1 - b.x), h: Math.min(b.h + dh, 1 - b.y) }, b)
}

/**
 * A screen saved before widgets: centre in -1..1 and a width. Keep both; the height is what a
 * square picture took on a 16:9 canvas, which is what that screen showed.
 */
export function legacyScreenBox(s) {
  const w = num(s?.w, 0.4)
  const h = Math.min(1, (w * 16) / 9)
  return clampBox({ x: 0.5 + num(s?.x, 0) / 2 - w / 2, y: 0.5 + num(s?.y, 0) / 2 - h / 2, w, h })
}

/** Frames (a URL in a box) from untrusted input: http(s) only, unique ids, shown by default. */
export function cleanFrames(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const f of list) {
    if (out.length >= MAX_FRAMES) break
    if (!f || typeof f !== 'object' || typeof f.url !== 'string' || !/^https?:\/\//.test(f.url)) continue
    let id = typeof f.id === 'string' && f.id.trim() ? f.id.trim().slice(0, 40) : `frame-${out.length + 1}`
    while (out.some((o) => o.id === id)) id = `${id}-${out.length + 1}`
    out.push({ id, url: f.url.slice(0, 2000), show: f.show !== false, ...clampBox(f) })
  }
  return out
}

/** The /scene body for a widget dragged to `box`: `screen`, `captions`, or `frame:<id>`. */
export function widgetPatch(scene, key, box) {
  if (key === 'screen' || key === 'captions') return { [key]: box }
  const id = key.startsWith('frame:') ? key.slice('frame:'.length) : null
  if (!id || !scene.frames.some((f) => f.id === id)) return {}
  return { frames: scene.frames.map((f) => (f.id === id ? { ...f, ...box } : f)) }
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

/**
 * What an egirl can hand work to beyond its own tools, from /info: peers (delegation) and MCP
 * servers (their tools never appear in `tools`). Older egirls without `mcp` report nothing.
 */
export function riskyReach(info) {
  const out = []
  if (info?.peers > 0) out.push(`peers: ${info.peers}`)
  if (Array.isArray(info?.mcp) && info.mcp.length) out.push(`mcp: ${info.mcp.join(', ')}`)
  return out
}

/** Go-live checklist. Each item: { key, label, ok, detail }. */
export function readiness({ health, egirl, modelLoaded }) {
  const items = []
  const voiceOk = !!health?.voice && !health.voice.error
  items.push({ key: 'server', label: 'Stage server', ok: !!health?.ok, detail: health?.ok ? 'reachable' : 'unreachable' })
  items.push({ key: 'voice', label: 'Voice service', ok: voiceOk, detail: voiceOk ? `${health.voice.device ?? 'up'}${health.voice.rvc?.length ? `, rvc: ${health.voice.rvc.join(', ')}` : ''}` : (health?.voice?.error ?? 'down') })
  items.push({ key: 'egirl', label: 'egirl instance', ok: !!egirl?.ok, detail: egirl?.ok ? (egirl.info?.model ?? 'reachable') : (egirl?.error ?? 'unreachable') })
  const risky = [...riskyTools(egirl?.info?.tools), ...riskyReach(egirl?.info)]
  items.push({ key: 'tools', label: 'Tools locked down', ok: !!egirl?.ok && risky.length === 0, detail: !egirl?.ok ? 'unknown' : risky.length ? `enabled: ${risky.join(', ')}` : 'no world-acting tools, peers or MCP servers' })
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

/* Offline render (`stage render`): a reel is {duration, clips: [{t0, t1, text, mouth}], cues: [{t, cue}]}. */

/** The clip playing at render time t, or null between clips. */
export function clipAt(reel, t) {
  return reel.clips.find((c) => t >= c.t0 && t < c.t1) ?? null
}

/** Cues whose time falls in (from, to]: stepping frames forward applies each cue exactly once. */
export function cuesBetween(reel, from, to) {
  return reel.cues.filter((c) => c.t > from && c.t <= to).map((c) => c.cue)
}

/**
 * Eye targets for a parameter-driven mood: openness and, on models that have
 * ParamEyeLSmile/RSmile, the smile that curves the eyes into ^^ for happy. The ^^ lasts
 * SMILE_S after the mood cue (`since`, seconds): a mood holds until the next tag, and eyes shut
 * for minutes read as asleep. Models without the smile params keep the plain openness values.
 * Blink is applied on top by the page.
 */
const EYES = { neutral: 1, happy: 0.85, sad: 0.7, angry: 0.9, surprised: 1.15 }
const SMILE_S = 1.6
export function eyeTarget(mood, hasSmile, since) {
  if (hasSmile && mood === 'happy' && since < SMILE_S) return { eye: 0, smile: 1 }
  return { eye: EYES[mood] ?? EYES.neutral, smile: 0 }
}

/**
 * Dancing to a tempo: the head dips on every beat and sways side to side every two beats.
 * `t` is seconds since the beat anchor. fx/fy are focus offsets added to the idle wander;
 * tilt and body are degrees for ParamAngleZ and ParamBodyAngleZ. All zero when bpm is 0.
 */
export function danceAt(t, bpm, sway) {
  if (!bpm || !sway) return { fx: 0, fy: 0, tilt: 0, body: 0 }
  const beat = (t * bpm) / 60
  const bob = Math.cos(Math.PI * beat) ** 2 // 1 on the beat, 0 between
  const side = Math.sin((Math.PI * beat) / 2) // one side and back over two beats
  return {
    fx: side * 0.3 * sway,
    fy: -bob * 0.25 * sway,
    tilt: Math.sin((Math.PI * beat) / 2 + 0.6) * 8 * sway,
    body: Math.sin((Math.PI * beat) / 2 + 0.3) * 4 * sway,
  }
}

// ----- Lively motion (opt-in: scene.motion.lively > 0) -------------------------------------
//
// A talent with no motions and no expressions -- chb119 has 17 parameters and nothing else --
// otherwise only ever sways. These three functions give it something to do from the parameters
// every model has: where it looks, how its head moves while it talks, and short reactions to
// events. Pure and deterministic so they can be tested and so a rendered reel looks the same
// every time; stage.js only applies what they return.

// Cheap deterministic hash -> [0, 1).
const hash01 = (n) => {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453
  return s - Math.floor(s)
}

/**
 * Where the talent looks at time t, as focus-controller coordinates (-1..1, +y up).
 * Gaze holds for 3-8 s at a time, then moves: mostly at the camera, often at the content
 * (gazeX: the side the game or screen is on, -1 left .. 1 right), sometimes a short glance
 * away. Moves ease over ~0.35 s so it reads as a look, not a snap.
 * @param {number} t seconds
 * @param {number} gazeX side of the content, -1..1 (0 = no content to look at)
 * @returns {{x: number, y: number, at: 'camera' | 'content' | 'away'}}
 */
export function gazeAt(t, gazeX = 0) {
  // Segment boundaries: each segment's length is drawn from its index, so any t maps to one.
  let start = 0, i = 0
  while (true) {
    const len = 3 + hash01(i) * 5
    if (start + len > t) break
    start += len; i++
    if (i > 100000) break
  }
  const pick = (k) => {
    const r = hash01(k * 7.13 + 1)
    if (gazeX !== 0 && r < 0.4) return { x: gazeX * 0.75, y: -0.15, at: 'content' }
    if (r > 0.88) return { x: (hash01(k + 3.3) - 0.5) * 1.2, y: 0.25, at: 'away' }
    return { x: (hash01(k + 9.1) - 0.5) * 0.2, y: 0, at: 'camera' }
  }
  const now = pick(i), prev = i > 0 ? pick(i - 1) : now
  const k = Math.min(1, (t - start) / 0.35)
  const e = k * k * (3 - 2 * k)
  return { x: prev.x + (now.x - prev.x) * e, y: prev.y + (now.y - prev.y) * e, at: now.at }
}

/**
 * Head motion that rides on speech: a small bob and tilt that follow the mouth level, so
 * a talking head does not stay perfectly still while only its mouth moves.
 * @param {number} level mouth openness 0..1 (what drives ParamMouthOpenY)
 * @param {number} t seconds
 * @returns {{fy: number, tilt: number, body: number}}
 */
export function talkMotion(level, t) {
  const l = Math.max(0, Math.min(1, level))
  return {
    fy: -l * 0.16 * (0.6 + 0.4 * Math.sin(t * 6.5)),
    tilt: Math.sin(t * 1.7) * l * 5,
    body: Math.sin(t * 1.1 + 0.4) * l * 3,
  }
}

/** Reactions: kind -> [duration s, mood or null]. */
export const REACTIONS = {
  flinch: [0.7, 'surprised'],
  shock: [1.6, 'surprised'],
  cheer: [1.4, 'happy'],
  smug: [2.2, 'happy'],
  sulk: [2.4, 'sad'],
}

/**
 * A reaction's motion `s` seconds after it started, or null once it is over. Envelopes rise
 * fast and settle slowly, the way a body reacts.
 * @param {string} kind a REACTIONS key
 * @param {number} s seconds since the reaction began
 * @returns {{fx: number, fy: number, tilt: number, body: number} | null}
 */
export function reactionAt(kind, s) {
  const spec = REACTIONS[kind]
  if (!spec || s < 0 || s > spec[0]) return null
  const p = s / spec[0]
  const env = Math.sin(Math.PI * Math.min(1, p * 2.5)) ** 2 * (1 - p) // fast attack, slow release
  const settle = Math.exp(-4 * p)
  switch (kind) {
    case 'flinch': return { fx: -0.25 * settle, fy: 0.3 * settle, tilt: -10 * settle, body: -6 * settle }
    case 'shock': return { fx: 0, fy: 0.45 * settle, tilt: 6 * Math.sin(s * 18) * settle, body: -8 * settle }
    case 'cheer': return { fx: 0, fy: -0.35 * Math.abs(Math.sin(s * 9)) * (1 - p), tilt: 8 * Math.sin(s * 4.5) * (1 - p), body: 6 * Math.sin(s * 4.5) * (1 - p) }
    case 'smug': return { fx: 0.2 * env, fy: -0.1 * env, tilt: 12 * Math.min(1, s * 3) * (1 - p * p), body: 3 * env }
    case 'sulk': return { fx: -0.2 * (1 - p), fy: -0.35 * (1 - p), tilt: -5 * (1 - p), body: -3 * (1 - p) }
  }
  return null
}

/**
 * Whole-body motion: offsets applied to the model sprite itself, for rigs that cannot move
 * their own head vertically (chb119 has no ParamAngleY, so every nod and bob sent through the
 * focus controller only ever moved the eyes). A gentle bob and sway at rest, bounce and lean
 * while talking, a lean towards where it is looking, and each reaction's body language.
 * @param {number} t seconds
 * @param {number} level mouth openness 0..1
 * @param {number} gaze current horizontal gaze, -1..1
 * @param {string|null} kind running reaction (REACTIONS key) or null
 * @param {number} s seconds since that reaction began
 * @returns {{dy: number, rot: number, sx: number, sy: number}} dy as a fraction of the model's
 *   height (+ is down), rot in degrees, sx/sy scale multipliers (squash and stretch)
 */
export function bodyMotion(t, level, gaze, kind, s) {
  const l = Math.max(0, Math.min(1, level))
  let dy = Math.sin(t * 1.6) * 0.004 - l * 0.012 * Math.abs(Math.sin(t * 7))
  let rot = Math.sin(t * 0.45) * 0.6 + Math.sin(t * 2.2) * l * 1.2 + gaze * 1.5
  let sx = 1, sy = 1
  const spec = kind ? REACTIONS[kind] : null
  if (spec && s >= 0 && s <= spec[0]) {
    const p = s / spec[0]
    const settle = Math.exp(-5 * p)
    switch (kind) {
      case 'cheer': {
        // Two hops, squashing on each landing.
        const hop = Math.abs(Math.sin(s * 7)) * (1 - p)
        dy -= 0.05 * hop
        const land = 1 - hop
        sy *= 1 - 0.05 * land * (1 - p); sx *= 1 + 0.04 * land * (1 - p)
        rot += Math.sin(s * 5) * 3 * (1 - p)
        break
      }
      case 'flinch': dy += 0.015 * settle; rot -= 4 * settle; sx *= 1 - 0.03 * settle; break
      case 'shock': dy -= 0.03 * Math.exp(-9 * p); sy *= 1 + 0.05 * settle; rot += Math.sin(s * 20) * 1.5 * settle; break
      case 'smug': rot += 5 * Math.min(1, s * 4) * (1 - p * p); dy += 0.006 * Math.min(1, s * 4) * (1 - p); break
      case 'sulk': dy += 0.02 * (1 - p); sy *= 1 - 0.03 * (1 - p); rot -= 2 * (1 - p); break
    }
  }
  return { dy, rot, sx, sy }
}

// Word cues for moodFromText, checked in order: the first that matches wins.
const MOOD_CUES = [
  ['surprised', /\b(ow+|ouch|whoa|wait,|what\?|huh|yikes|oh no)\b|!\?/i],
  ['angry', /\b(stole|steal|rude|how dare|cheap shot|avenge|revenge|grr+)\b/i],
  ['sad', /\b(lost|losing|defeat|ugh|sigh|unlucky|not my day)\b/i],
  ['happy', /\b(calculated|nice|perfect|easy|ha+|hehe|got (?:him|her|them|it)|victory|won|tier up|yes!)\b/i],
]

/**
 * A mood for a spoken sentence, for talents whose model rarely writes cue tags itself. Only
 * clear word cues count; anything else is null, so a plain sentence keeps the current mood.
 * @param {string} text
 * @returns {'happy'|'sad'|'angry'|'surprised'|null}
 */
export function moodFromText(text) {
  for (const [mood, re] of MOOD_CUES) if (re.test(text || '')) return mood
  return null
}
