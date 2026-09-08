/* Stage console: the operator's view of one talent. Same WebSocket as the render page,
 * announced as a console so it also receives turn events. State logic lives in core.js
 * (tested); this file is wiring and DOM. Parameter ranges and live values are read straight
 * out of the preview iframe, which is the real render page with sound muted. */
import { clampTransform, clipStats, readiness, riskyTools, turnReducer } from './core.js'

const $ = (id) => document.getElementById(id)
const app = document.querySelector('.app')
const preview = $('preview')
const VOICES = {
  'American female': ['af_heart', 'af_bella', 'af_sky', 'af_nicole', 'af_sarah', 'af_nova', 'af_kore', 'af_aoede', 'af_alloy', 'af_jessica', 'af_river'],
  'American male': ['am_adam', 'am_michael', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_onyx', 'am_puck', 'am_santa'],
  'British female': ['bf_emma', 'bf_isabella', 'bf_alice', 'bf_lily'],
  'British male': ['bm_george', 'bm_lewis', 'bm_daniel', 'bm_fable'],
}
const MOOD_KEYS = { 1: 'neutral', 2: 'happy', 3: 'sad', 4: 'angry', 5: 'surprised' }
const PANEL_KEYS = { m: 'model', e: 'scene', v: 'voice', b: 'brain', c: 'chat', t: 'twitch', i: 'mic', s: 'settings' }

/* ---------- state ---------- */
const S = {
  talent: null, model: null, expressions: [], modelList: [], health: null, brain: null,
  state: 'idle', mood: 'neutral', turns: turnReducer(undefined, { type: 'init' }),
  clips: [], turnStart: 0, ttfa: null, pinned: {}, params: [], monitor: false,
}

/* ---------- helpers ---------- */
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json())
const ms = (n) => (n == null ? '—' : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(2)} s`)
const secs = (n) => (n == null ? '—' : `${n.toFixed(1)} s`)
const debounce = (fn, t) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), t) } }
let toastT
function toast(text) { const el = $('toast'); el.textContent = text; el.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), 1800) }
function copy(text) { navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast(text)) }
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
const bindRange = (id, valId, fmt, onChange) => { const r = $(id); r.addEventListener('input', () => { $(valId).textContent = fmt(Number(r.value)); onChange(Number(r.value)) }) }
const setRange = (id, valId, v, fmt) => { $(id).value = v; $(valId).textContent = fmt(v) }

/* ---------- panels ---------- */
function showPanel(name) { app.dataset.panel = name; document.querySelectorAll('.rail-btn').forEach((b) => b.classList.toggle('active', b.dataset.panel === name)); document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name)); if (name === 'brain') loadBrain(); if (name === 'settings') renderReady() }
document.querySelectorAll('.rail-btn').forEach((b) => b.addEventListener('click', () => showPanel(b.dataset.panel)))
showPanel('model')

/* ---------- HUD ---------- */
function setState(state, detail) {
  S.state = state
  const pill = $('statePill'); const shown = S.turns.speaking && state === 'idle' ? 'speaking' : state
  pill.dataset.state = shown
  $('stateText').textContent = detail && shown !== 'speaking' ? `${shown} · ${detail}` : shown
}
function setMood(m) { S.mood = m; document.querySelectorAll('.chip[data-mood]').forEach((c) => c.classList.toggle('active', c.dataset.mood === m)) }
function setTalent(t) {
  S.talent = t
  $('talentName').textContent = t.name; $('talentAvatar').textContent = t.name.slice(0, 1); $('talentModel').textContent = t.model
  document.title = `Stage · ${t.name}`
  $('voiceSel').value = t.voice; $('rvcSel').value = t.rvc || ''
  setRange('pitch', 'pitchVal', t.pitch, (v) => v); setRange('speed', 'speedVal', t.speed, (v) => v.toFixed(2))
  $('btnMute').classList.toggle('on', !!t.muted); $('btnMute').title = t.muted ? 'Unmute the talent' : 'Mute the talent (kill switch)'
  if (t.muted) toast('Talent is muted')
  applyTransformUI(t.transform); applySceneUI(t.scene)
  $('brSession').textContent = `session ${t.name}`
  renderModels()
}
$('btnBg').addEventListener('click', () => { $('stageFrame').classList.toggle('checker'); $('btnBg').classList.toggle('on') })
const obsUrl = `${location.origin}/`
$('obsUrl').textContent = obsUrl
$('btnCopy').addEventListener('click', () => copy(obsUrl)); $('btnCopy2').addEventListener('click', () => copy(obsUrl))
$('btnMute').addEventListener('click', () => post('/mute', { on: !S.talent?.muted }))
$('btnMonitor').addEventListener('click', () => {
  S.monitor = !S.monitor; $('btnMonitor').classList.toggle('on', S.monitor)
  preview.src = `/?${S.monitor ? 'mute=0' : 'mute=1'}&status=0&caption=0&edit=1`
  toast(S.monitor ? 'Monitoring preview audio (click the preview once if silent)' : 'Preview muted')
})
$('btnLogs').addEventListener('click', toggleLogs)
function toggleLogs() { const on = $('logs').hidden; $('logs').hidden = !on; $('btnLogs').classList.toggle('on', on); document.querySelector('.viewport').classList.toggle('with-logs', on) }
function addLog(line) { const pre = $('logLines'); pre.textContent += `${line}\n`; const lines = pre.textContent.split('\n'); if (lines.length > 400) pre.textContent = lines.slice(-400).join('\n'); pre.scrollTop = pre.scrollHeight }
$('btnClearLogs').addEventListener('click', () => { $('logLines').textContent = '' })

/* level meter + live parameter bars + transform sliders, from the preview each frame */
function tick() {
  const st = preview.contentWindow?.stage
  const m = st?.model
  $('levelFill').style.width = `${Math.round((st?.level || 0) * 100)}%`
  if (m && S.params.length) {
    const core = m.internalModel.coreModel
    for (const p of S.params) {
      const v = core.getParameterValueByIndex(p.index)
      p.live.style.width = `${((v - p.min) / (p.max - p.min || 1)) * 100}%`
      if (!(p.id in S.pinned)) { p.val.textContent = v.toFixed(2); p.slider.value = v }
    }
  }
  if (st?.transform && !draggingTransform) applyTransformUI(st.transform)
  requestAnimationFrame(tick)
}
requestAnimationFrame(tick)

/* ---------- transport ---------- */
const composer = $('composer')
composer.addEventListener('input', () => { composer.style.height = 'auto'; composer.style.height = `${Math.min(140, composer.scrollHeight)}px` })
composer.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } })
async function send() {
  const message = composer.value.trim(); if (!message) return
  composer.value = ''; composer.style.height = 'auto'
  $('btnSend').classList.add('busy'); $('btnSend').disabled = true
  showPanel('chat')
  try { await post('/chat', { message }) } catch (e) { toast(`send failed: ${e.message}`) }
  $('btnSend').classList.remove('busy'); $('btnSend').disabled = false
}
$('btnSend').addEventListener('click', send)
$('btnSay').addEventListener('click', async () => { const text = composer.value.trim(); if (!text) return; composer.value = ''; const r = await post('/say', { text }); if (r.muted) toast('Muted: nothing was said') })
$('btnStop').addEventListener('click', () => post('/interrupt').then(() => toast('Stopped')))
document.querySelectorAll('.chip[data-mood]').forEach((c) => c.addEventListener('click', () => post('/cue', { type: 'mood', mood: c.dataset.mood })))
document.querySelectorAll('.chip[data-gesture]').forEach((c) => c.addEventListener('click', () => post('/cue', { type: 'gesture', name: c.dataset.gesture })))
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')
  if (e.key === 'Escape') { post('/interrupt'); toast('Stopped'); return }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return
  if (MOOD_KEYS[e.key]) post('/cue', { type: 'mood', mood: MOOD_KEYS[e.key] })
  else if (e.key === 'n') post('/cue', { type: 'gesture', name: 'nod' })
  else if (e.key === 'l') toggleLogs()
  else if (PANEL_KEYS[e.key]) showPanel(PANEL_KEYS[e.key])
  else if (e.key === '/') { e.preventDefault(); composer.focus() }
})

/* ---------- model panel ---------- */
async function loadModelList() { S.modelList = await fetch('/models.json').then((r) => r.json()); renderModels() }
function renderModels() {
  const grid = $('modelGrid'); grid.innerHTML = ''
  for (const m of S.modelList) {
    const card = el('button', `model-card${S.talent && m.model === S.talent.model ? ' active' : ''}`)
    card.title = m.model
    if (m.icon) { const img = el('img'); img.src = m.icon; img.alt = ''; img.loading = 'lazy'; card.appendChild(img) }
    else card.appendChild(el('div', 'initials', m.name.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?'))
    if (m.expressions) card.appendChild(el('span', 'badge', `${m.expressions} exp`))
    card.appendChild(el('div', 'label', m.name))
    card.addEventListener('click', () => post('/model', { model: m.model }).then((r) => r.error && toast(r.error)))
    grid.appendChild(card)
  }
  if (!S.modelList.length) grid.appendChild(el('div', 'empty', 'No *.model3.json found under models_dir.'))
}
function renderExpressions() {
  const list = $('exprList'); list.innerHTML = ''
  $('exprHint').textContent = S.expressions.length ? `${S.expressions.length} from .exp3 files` : 'none shipped; moods use brow/eye/mouth params'
  for (const e of S.expressions) {
    const mood = Object.values(MOOD_KEYS).find((m) => e.name.toLowerCase().includes(m))
    const b = el('button', 'chip', e.name); b.title = mood ? `bound to [${mood}]` : 'no mood tag matches this name'
    if (mood) b.addEventListener('click', () => post('/cue', { type: 'mood', mood })); else b.disabled = true
    list.appendChild(b)
  }
}
async function loadParams() {
  const st = preview.contentWindow?.stage
  const m = st?.model
  if (!m || !S.model) return setTimeout(loadParams, 300)
  const core = m.internalModel.coreModel.getModel().parameters
  const names = {}, groups = {}, order = []
  try {
    const m3 = await fetch(S.model).then((r) => r.json())
    if (m3.FileReferences?.DisplayInfo) {
      const cdi = await fetch(new URL(m3.FileReferences.DisplayInfo, location.origin + S.model)).then((r) => r.json())
      for (const p of cdi.Parameters || []) { names[p.Id] = p.Name; groups[p.Id] = p.GroupId; order.push(p.Id) }
      for (const g of cdi.ParameterGroups || []) groups[g.Id] = g.Name
    }
  } catch {}
  const box = $('params'); box.innerHTML = ''; S.params = []
  const ids = order.length ? order.filter((id) => core.ids.includes(id)) : [...core.ids]
  let lastGroup
  for (const id of ids) {
    const i = core.ids.indexOf(id)
    const g = groups[groups[id]] || groups[id] || ''
    if (g !== lastGroup) { box.appendChild(el('div', 'param-group', g || 'parameters')); lastGroup = g }
    const row = el('div', 'param'); row.dataset.id = id
    const name = el('div', 'name', names[id] || id); name.title = id
    const track = el('div', 'track'); const live = el('div', 'live')
    const slider = el('input'); slider.type = 'range'; slider.min = core.minimumValues[i]; slider.max = core.maximumValues[i]; slider.step = (core.maximumValues[i] - core.minimumValues[i]) / 200 || 0.01
    const val = el('div', 'val', '0.00')
    track.append(live, slider); row.append(name, track, val); box.appendChild(row)
    S.params.push({ id, index: i, min: core.minimumValues[i], max: core.maximumValues[i], live, slider, val, row })
    const pin = debounce((v) => post('/cue', { type: 'param', id, value: v }), 30)
    slider.addEventListener('input', () => { const v = Number(slider.value); S.pinned[id] = v; row.classList.add('pinned'); val.textContent = v.toFixed(2); pin(v) })
    slider.addEventListener('dblclick', () => release(id))
  }
}
function release(id) { delete S.pinned[id]; document.querySelector(`.param[data-id="${CSS.escape(id)}"]`)?.classList.remove('pinned'); post('/cue', { type: 'param', id, value: null }) }
$('btnRelease').addEventListener('click', () => Object.keys(S.pinned).forEach(release))

/* ---------- scene panel ---------- */
let draggingTransform = false
function applyTransformUI(t) { const c = clampTransform(t); setRange('tx', 'txVal', c.x, (v) => v.toFixed(2)); setRange('ty', 'tyVal', c.y, (v) => v.toFixed(2)); setRange('ts', 'tsVal', c.scale, (v) => `${v.toFixed(2)}`) }
const pushTransform = debounce(() => post('/transform', { x: Number($('tx').value), y: Number($('ty').value), scale: Number($('ts').value) }).then(() => { draggingTransform = false }), 80)
for (const id of ['tx', 'ty', 'ts']) { $(id).addEventListener('pointerdown', () => { draggingTransform = true }) }
bindRange('tx', 'txVal', (v) => v.toFixed(2), pushTransform); bindRange('ty', 'tyVal', (v) => v.toFixed(2), pushTransform); bindRange('ts', 'tsVal', (v) => v.toFixed(2), pushTransform)
$('btnResetTransform').addEventListener('click', () => post('/transform', { x: 0, y: 0, scale: 1 }))
function applySceneUI(sc) {
  if (!sc) return
  setRange('sway', 'swayVal', sc.motion.sway, (v) => v.toFixed(2)); setRange('mspeed', 'mspeedVal', sc.motion.speed, (v) => v.toFixed(2)); setRange('blink', 'blinkVal', sc.motion.blink, (v) => v.toFixed(1))
  $('capShow').checked = sc.captions.show; setRange('capSize', 'capSizeVal', sc.captions.size, (v) => v)
  if (sc.background.color) $('bgColor').value = sc.background.color
}
const pushMotion = debounce(() => post('/scene', { motion: { sway: Number($('sway').value), speed: Number($('mspeed').value), blink: Number($('blink').value) } }), 120)
bindRange('sway', 'swayVal', (v) => v.toFixed(2), pushMotion); bindRange('mspeed', 'mspeedVal', (v) => v.toFixed(2), pushMotion); bindRange('blink', 'blinkVal', (v) => v.toFixed(1), pushMotion)
const pushCaptions = debounce(() => post('/scene', { captions: { show: $('capShow').checked, size: Number($('capSize').value) } }), 120)
$('capShow').addEventListener('change', pushCaptions); bindRange('capSize', 'capSizeVal', (v) => v, pushCaptions)
$('btnBgApply').addEventListener('click', () => post('/scene', { background: { color: $('bgColor').value } }))
$('btnBgClear').addEventListener('click', () => post('/scene', { background: { color: '' } }))

/* ---------- voice panel ---------- */
{ const sel = $('voiceSel'); for (const [group, list] of Object.entries(VOICES)) { const og = el('optgroup'); og.label = group; for (const v of list) og.appendChild(new Option(v, v)); sel.appendChild(og) } }
const pushVoice = debounce(() => post('/voice', { voice: $('voiceSel').value, rvc: $('rvcSel').value || null, pitch: Number($('pitch').value), speed: Number($('speed').value) }).then(() => toast('Voice saved')), 250)
$('voiceSel').addEventListener('change', pushVoice); $('rvcSel').addEventListener('change', pushVoice)
bindRange('pitch', 'pitchVal', (v) => v, pushVoice); bindRange('speed', 'speedVal', (v) => v.toFixed(2), pushVoice)
$('btnTest').addEventListener('click', () => post('/say', { text: $('testLine').value }))
function addClipStat(c) {
  S.clips.push(c); if (S.clips.length > 40) S.clips.shift()
  const st = clipStats(S.clips)
  $('stClips').textContent = st.count; $('stSynth').textContent = ms(st.lastGenMs); $('stAudio').textContent = secs(st.lastSeconds); $('stRtf').textContent = st.avgRtf.toFixed(3)
  $('roSynth').textContent = ms(c.genMs); $('roRtf').textContent = (c.genMs / 1000 / (c.seconds || 1)).toFixed(2)
  const sp = $('spark'); sp.innerHTML = ''
  const max = Math.max(...S.clips.map((x) => x.genMs), 1)
  for (const x of S.clips.slice(-30)) { const bar = el('i'); bar.style.height = `${Math.max(6, (x.genMs / max) * 100)}%`; bar.title = `${ms(x.genMs)} for ${secs(x.seconds)}`; sp.appendChild(bar) }
}

/* ---------- brain panel ---------- */
async function loadBrain() {
  const b = await fetch('/egirl').then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }))
  S.brain = b
  $('brUp').textContent = b.ok ? 'yes' : 'no'; $('brUp').style.color = b.ok ? 'var(--ok)' : 'var(--err)'
  $('brName').textContent = b.info?.name ?? '—'; $('brModel').textContent = b.info?.model ?? '—'; $('brModel').title = b.info?.model ?? ''
  if (b.info?.thinking) $('thinkSel').value = b.info.thinking
  const ctx = b.context || {}
  const used = ctx.used ?? ctx.tokens ?? ctx.total ?? null, limit = ctx.limit ?? ctx.contextLength ?? ctx.max ?? b.info?.contextLength ?? null
  $('brCtx').textContent = used != null && limit ? `${Math.round((used / limit) * 100)}%` : used != null ? String(used) : '—'
  $('ctxFill').style.width = used != null && limit ? `${Math.min(100, (used / limit) * 100)}%` : '0'
  const badges = $('toolBadges'); badges.innerHTML = ''
  const risky = new Set(riskyTools(b.info?.tools))
  for (const [k, v] of Object.entries(b.info?.tools || {})) { const on = v === true || (typeof v === 'string' && v !== 'off'); badges.appendChild(el('span', `badge-tool${on ? (risky.has(k) ? ' risky' : ' on') : ''}`, `${k}${on ? '' : ' off'}`)) }
  if (!b.info?.tools) badges.appendChild(el('div', 'empty', b.ok ? 'No tool information in /info.' : `Unreachable: ${b.error}`))
  $('brainJson').textContent = JSON.stringify(b, null, 1)
  renderReady()
}
$('btnBrainRefresh').addEventListener('click', loadBrain)
$('thinkSel').addEventListener('change', () => post('/egirl/thinking', { level: $('thinkSel').value }).then((r) => toast(r.error ? r.error : `Thinking: ${$('thinkSel').value}`)))
$('btnAbortTurn').addEventListener('click', () => post('/interrupt').then((r) => toast(r.aborted ? 'Turn aborted' : 'Nothing to abort')))

/* ---------- mic panel (stub with real device list) ---------- */
navigator.mediaDevices?.enumerateDevices?.().then((ds) => { const sel = $('micSel'); sel.innerHTML = ''; const ins = ds.filter((d) => d.kind === 'audioinput'); for (const d of ins) sel.appendChild(new Option(d.label || `microphone ${sel.length + 1}`, d.deviceId)); if (!ins.length) sel.appendChild(new Option('no input devices (grant mic permission)', '')) }).catch(() => {})

/* ---------- chat panel (rendered from the reducer) ---------- */
function renderTurns() {
  const tl = $('timeline'); tl.innerHTML = ''
  if (!S.turns.turns.length) { tl.appendChild(el('div', 'empty', 'No turns yet. Send a message below.')); return }
  for (const t of S.turns.turns) {
    const box = el('div', `turn${t.error ? ' error' : ''}`)
    const you = el('div', 'you'); you.append('you  ', el('b', null, t.message)); box.appendChild(you)
    if (t.reasoning) { const d = el('details', `think${t.done ? '' : ' live'}`); d.append(el('summary', null, `thinking · ${t.reasoning.length} chars`), el('pre', null, t.reasoning)); box.appendChild(d) }
    if (t.tools.length) { const tools = el('div', 'tools'); for (const c of t.tools) tools.appendChild(el('span', `tool${c.done ? ' done' : ''}`, c.name)); box.appendChild(tools) }
    const reply = el('div', 'reply')
    if (t.error) reply.textContent = t.error
    else { for (const s of t.sentences) reply.appendChild(el('span', `s ${s.status}`, `${s.text} `)); if (!t.done) reply.appendChild(el('span', 'cursor')) }
    box.appendChild(reply)
    if (t.done) { const foot = el('div', 'foot'); foot.innerHTML = [`total <b>${ms(t.ms)}</b>`, t.firstAudio != null ? `first audio <b>${ms(t.firstAudio)}</b>` : '', t.reasoning ? `reasoning <b>${t.reasoning.length}</b> chars` : ''].filter(Boolean).join('<span style="opacity:.4"> · </span>'); box.appendChild(foot) }
    tl.appendChild(box)
  }
}
$('btnClearChat').addEventListener('click', () => { S.turns = turnReducer(undefined, { type: 'init' }); renderTurns() })
function onEvent(ev) {
  const before = S.turns.speaking
  S.turns = turnReducer(S.turns, ev)
  if (ev.type === 'turn' && ev.phase === 'start') { S.turnStart = performance.now(); S.ttfa = null; $('roTtfa').textContent = '…' }
  if (ev.type === 'clip' && S.ttfa == null) { S.ttfa = performance.now() - S.turnStart; $('roTtfa').textContent = ms(S.ttfa); const t = S.turns.turns.find((x) => !x.done); if (t) t.firstAudio = S.ttfa }
  if (S.turns.speaking !== before || ev.type === 'stop') setState(S.state)
  $('caption').textContent = S.turns.caption; $('caption').classList.toggle('on', !!S.turns.caption)
  renderTurns()
}

/* ---------- twitch panel ---------- */
function onChat(ev) {
  $('twEmpty')?.remove()
  const line = el('div', `line${ev.mentioned ? ' mentioned' : ''}`)
  line.append(el('time', null, new Date(ev.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })), el('b', null, ev.author), document.createTextNode(ev.text))
  const log = $('chatlog'); log.prepend(line); while (log.children.length > 200) log.lastChild.remove()
}

/* ---------- health + readiness ---------- */
function renderReady() {
  const items = readiness({ health: S.health, egirl: S.brain, modelLoaded: !!preview.contentWindow?.stage?.model })
  const ul = $('ready'); ul.innerHTML = ''
  for (const i of items) { const li = el('li', i.ok ? 'ok' : ''); li.append(el('span', null, i.label), el('span', 'd', i.detail)); ul.appendChild(li) }
  const ok = items.filter((i) => i.ok).length
  $('readySummary').textContent = `${ok}/${items.length}`
}
async function pollHealth() {
  try {
    const h = await fetch('/health').then((r) => r.json())
    S.health = h
    $('healthJson').textContent = JSON.stringify(h, null, 1)
    const dots = $('railHealth').querySelectorAll('.dot')
    dots[0].className = 'dot ok'; dots[1].className = `dot ${h.voice && !h.voice.error ? 'ok' : 'bad'}`; dots[2].className = `dot ${h.pages > 0 ? 'ok' : ''}`
    $('railHealth').title = `server ok · voice ${h.voice?.error ? 'down' : 'ok'} · egirl ${h.egirl?.ok ? 'ok' : 'down'} · ${h.pages} page(s)`
    if (h.voice?.rvc) { const sel = $('rvcSel'); const cur = sel.value; sel.innerHTML = '<option value="">off (raw Kokoro)</option>'; for (const n of h.voice.rvc) sel.appendChild(new Option(n, n)); sel.value = S.talent?.rvc && h.voice.rvc.includes(S.talent.rvc) ? S.talent.rvc : cur }
    if (h.twitch) { $('twStatus').textContent = h.twitch.connected ? 'connected' : 'reconnecting'; $('twStatus').style.color = h.twitch.connected ? 'var(--ok)' : 'var(--warn)'; $('twQueued').textContent = h.twitch.queued; $('twDropped').textContent = h.twitch.dropped; $('twSent').textContent = h.twitch.sent }
    if (app.dataset.panel === 'settings') renderReady()
  } catch { $('railHealth').querySelectorAll('.dot')[0].className = 'dot bad' }
}
async function loadTalents() {
  const t = await fetch('/talent').then((r) => r.json())
  const list = $('talentList'); list.innerHTML = ''
  for (const name of t.talents) { const row = el('div', `talent-row${name === t.name ? ' current' : ''}`); row.append(el('span', null, name), name === t.name ? el('span', 'tag', 'this stage') : el('code', null, `stage serve --talent ${name}`)); list.appendChild(row) }
}

/* ---------- websocket ---------- */
let ws
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
  ws.onopen = () => { ws.send(JSON.stringify({ type: 'ready', role: 'console' })); toast('Connected') }
  ws.onclose = () => { setTimeout(connect, 1500) }
  ws.onmessage = (m) => {
    let ev; try { ev = JSON.parse(m.data) } catch { return }
    switch (ev.type) {
      case 'load': S.model = ev.model; S.expressions = ev.expressions || []; renderExpressions(); setTimeout(loadParams, 600); if (ev.transform) applyTransformUI(ev.transform); if (ev.scene) applySceneUI(ev.scene); if (S.talent) { S.talent.model = ev.model.replace(/^\/models\//, ''); $('talentModel').textContent = S.talent.model; renderModels() } break
      case 'talent': setTalent(ev); break
      case 'state': setState(ev.state, ev.detail); break
      case 'mood': setMood(ev.mood); break
      case 'transform': if (!draggingTransform) applyTransformUI(ev); break
      case 'scene': applySceneUI(ev.scene); break
      case 'logs': for (const l of ev.lines) addLog(l); break
      case 'log': addLog(ev.text); break
      case 'chat': onChat(ev); break
      case 'clip': addClipStat(ev); onEvent(ev); break
      case 'speak': case 'playing': case 'spoke': case 'stop': case 'turn': case 'reasoning': case 'token': case 'tool': case 'tool_done': onEvent(ev); break
    }
  }
}
connect()
loadModelList(); loadTalents(); pollHealth(); setInterval(pollHealth, 3000)
