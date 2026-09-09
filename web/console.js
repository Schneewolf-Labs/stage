/* Stage console: the operator's view of one talent. Same WebSocket as the render page,
 * announced as a console so it also receives turn events. State logic lives in core.js
 * (tested); this file is wiring and DOM. Parameter ranges and live values are read straight
 * out of the preview iframe, which is the real render page with sound muted. */
import { clampTransform, clipStats, contextUse, downsample, encodeWav, readiness, riskyTools, turnReducer } from './core.js'

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
const PANEL_KEYS = { m: 'model', e: 'scene', v: 'voice', b: 'brain', d: 'director', c: 'chat', t: 'twitch', i: 'mic', s: 'settings' }

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
function showPanel(name) { app.dataset.panel = name; document.querySelectorAll('.rail-btn').forEach((b) => b.classList.toggle('active', b.dataset.panel === name)); document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name)); if (name === 'brain') { loadBrain(); loadAsks() } if (name === 'settings') renderReady() }
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
  applyTransformUI(t.transform); applySceneUI(t.scene); applyDirectorUI(t.director); S.hotkeys = t.hotkeys || []; renderHotkeys(); loadPresets()
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
  if (mic.recording && mic.analyser) { const b = new Uint8Array(mic.analyser.fftSize); mic.analyser.getByteTimeDomainData(b); let sum = 0; for (const v of b) { const d = (v - 128) / 128; sum += d * d } $('micLevel').style.width = `${Math.min(100, Math.sqrt(sum / b.length) * 400)}%` } else $('micLevel').style.width = '0'
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
function handleKey(e) {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') && !e.fromPreview
  if (e.key === 'Escape') { post('/interrupt'); toast('Stopped'); return }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return
  const custom = S.hotkeys.find((h) => h.key === (e.key === ' ' ? 'Space' : e.key))
  if (custom && !e.repeat) { e.preventDefault(); post('/hotkeys/fire', { key: custom.key }).then((r) => toast(r.error || `${custom.action}${custom.value ? `: ${custom.value.slice(0, 30)}` : ''}`)); return }
  if (MOOD_KEYS[e.key]) post('/cue', { type: 'mood', mood: MOOD_KEYS[e.key] })
  else if (e.key === 'n') post('/cue', { type: 'gesture', name: 'nod' })
  else if (e.key === 'l') toggleLogs()
  else if (PANEL_KEYS[e.key]) showPanel(PANEL_KEYS[e.key])
  else if (e.key === '/') { e.preventDefault(); composer.focus() }
}
document.addEventListener('keydown', handleKey)
// The preview iframe forwards its keystrokes (see stage.js) so hotkeys keep working after a
// click on the model; key-ups matter for push-to-talk.
window.addEventListener('message', (m) => {
  if (m.data?.type !== 'stage-key') return
  const e = { ...m.data, fromPreview: true, preventDefault() {} }
  if (m.data.event === 'keydown') { if (e.code === 'Space' && !e.repeat) micStart(); else handleKey(e) }
  else if (e.code === 'Space' && mic.recording) micStop()
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
  $('bgImage').value = sc.background.image || ''
  if (sc.screen) { setRange('sx', 'sxVal', sc.screen.x, (v) => v.toFixed(2)); setRange('sy', 'syVal', sc.screen.y, (v) => v.toFixed(2)); setRange('sw', 'swVal', sc.screen.w, (v) => Math.round(v * 100)) }
}
const pushScreen = debounce(() => post('/scene', { screen: { x: Number($('sx').value), y: Number($('sy').value), w: Number($('sw').value) } }), 120)
bindRange('sx', 'sxVal', (v) => v.toFixed(2), pushScreen); bindRange('sy', 'syVal', (v) => v.toFixed(2), pushScreen); bindRange('sw', 'swVal', (v) => Math.round(v * 100), pushScreen)
$('btnTestImage').addEventListener('click', () => post('/image', { url: '/models/' + (S.modelList.find((m) => m.icon)?.icon?.replace(/^\/models\//, '') || ''), caption: 'test picture', seconds: 8 }))
$('btnClearImage').addEventListener('click', () => post('/image', { url: null }))
$('btnBgImage').addEventListener('click', () => post('/scene', { background: { image: $('bgImage').value.trim() } }))
$('btnBgImageClear').addEventListener('click', () => post('/scene', { background: { image: '' } }))
const pushMotion = debounce(() => post('/scene', { motion: { sway: Number($('sway').value), speed: Number($('mspeed').value), blink: Number($('blink').value) } }), 120)
bindRange('sway', 'swayVal', (v) => v.toFixed(2), pushMotion); bindRange('mspeed', 'mspeedVal', (v) => v.toFixed(2), pushMotion); bindRange('blink', 'blinkVal', (v) => v.toFixed(1), pushMotion)
const pushCaptions = debounce(() => post('/scene', { captions: { show: $('capShow').checked, size: Number($('capSize').value) } }), 120)
$('capShow').addEventListener('change', pushCaptions); bindRange('capSize', 'capSizeVal', (v) => v, pushCaptions)
$('btnBgApply').addEventListener('click', () => post('/scene', { background: { color: $('bgColor').value } }))
$('btnBgClear').addEventListener('click', () => post('/scene', { background: { color: '' } }))

/* ---------- presets ---------- */
async function loadPresets() {
  const list = await fetch('/presets').then((r) => r.json()).catch(() => [])
  const box = $('presetList'); box.innerHTML = ''
  if (!list.length) box.appendChild(el('div', 'empty', 'No presets yet.'))
  for (const p of list) {
    const row = el('div', 'preset')
    const apply = el('button', 'btn ghost', 'Apply'); apply.addEventListener('click', () => post('/presets/apply', { name: p.name }).then(() => toast(`Preset: ${p.name}`)))
    const del = el('button', 'link', 'delete'); del.addEventListener('click', () => post('/presets/delete', { name: p.name }).then(loadPresets))
    row.append(el('b', null, p.name), el('span', 'help', `${(p.transform.scale).toFixed(2)}× · ${p.scene.background.color || p.scene.background.image || 'transparent'}`), apply, del)
    box.appendChild(row)
  }
}
$('btnPresetSave').addEventListener('click', () => { const name = $('presetName').value.trim(); if (!name) return toast('Name the preset'); post('/presets', { name }).then((r) => { if (r.error) return toast(r.error); $('presetName').value = ''; toast(`Saved ${r.name}`); loadPresets() }) })

/* ---------- hotkeys ---------- */
const HOTKEY_ACTIONS = ['mood', 'gesture', 'say', 'preset', 'stop', 'mute']
S.hotkeys = []
function renderHotkeys() {
  const box = $('hotkeys'); box.innerHTML = ''
  S.hotkeys.forEach((h, i) => {
    const row = el('div', 'hotkey')
    const key = el('button', 'key', h.key || 'press…'); key.title = 'Click, then press a key'
    key.addEventListener('click', () => { key.classList.add('listening'); key.textContent = '…'; const on = (e) => { e.preventDefault(); e.stopPropagation(); h.key = e.key === ' ' ? 'Space' : e.key; document.removeEventListener('keydown', on, true); renderHotkeys(); saveHotkeys() }; document.addEventListener('keydown', on, true) })
    const act = el('select'); for (const a of HOTKEY_ACTIONS) act.appendChild(new Option(a, a)); act.value = h.action; act.addEventListener('change', () => { h.action = act.value; saveHotkeys() })
    const val = el('input'); val.value = h.value || ''; val.placeholder = { mood: 'happy', gesture: 'nod', say: 'a line to say', preset: 'preset name' }[h.action] || '—'; val.disabled = h.action === 'stop' || h.action === 'mute'
    val.addEventListener('change', () => { h.value = val.value; saveHotkeys() })
    const x = el('button', 'x', '×'); x.addEventListener('click', () => { S.hotkeys.splice(i, 1); renderHotkeys(); saveHotkeys() })
    row.append(key, act, val, x); box.appendChild(row)
  })
}
const saveHotkeys = debounce(() => post('/hotkeys', { hotkeys: S.hotkeys.filter((h) => h.key) }).then((r) => r.error && toast(r.error)), 200)
$('btnHotkeyAdd').addEventListener('click', () => { S.hotkeys.push({ key: '', action: 'say', value: '' }); renderHotkeys() })

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
  const use = contextUse(b.context, b.info)
  if (use.thinking) $('thinkSel').value = use.thinking
  $('brCtx').textContent = use.pct != null ? `${use.pct}%` : '—'
  $('brCtx').title = use.used != null ? `${use.used.toLocaleString()} of ${use.limit.toLocaleString()} tokens` : ''
  $('ctxFill').style.width = use.pct != null ? `${Math.min(100, use.pct)}%` : '0'
  $('brSession').textContent = b.context?.session_id ?? '—'
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
$('btnCompact').addEventListener('click', () => post('/egirl/compact').then((r) => { toast(r.error ? r.error : `Compacted: ${r.dropped} message${r.dropped === 1 ? '' : 's'} summarised`); loadBrain() }))
// Two clicks: the first arms the button, the second forgets the session. No browser dialog.
$('btnResetSession').addEventListener('click', () => {
  const b = $('btnResetSession')
  if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Really forget?'; setTimeout(() => { b.dataset.armed = ''; b.textContent = 'New session' }, 4000); return }
  b.dataset.armed = ''; b.textContent = 'New session'
  post('/egirl/reset').then((r) => { toast(r.error ? r.error : 'Session forgotten'); loadBrain() })
})
async function loadAsks() {
  const r = await fetch('/egirl/asks').then((x) => x.json()).catch(() => ({ asks: [] }))
  const box = $('asks'); box.innerHTML = ''
  const asks = r.asks || []
  document.querySelector('.rail-btn[data-panel=brain]').classList.toggle('attention', asks.length > 0)
  if (!asks.length) { box.appendChild(el('div', 'empty', 'Nothing pending.')); return }
  for (const a of asks) {
    const card = el('div', 'ask')
    card.append(el('div', 'from', `${a.from}${a.kind ? ` · ${a.kind}` : ''}`), el('div', 'q', a.question))
    const row = el('div', 'row'); const input = el('input'); input.placeholder = 'Your answer'
    const reply = el('button', 'btn primary', 'Reply'); const dismiss = el('button', 'btn', 'Dismiss')
    const send = () => { if (!input.value.trim()) return; post('/egirl/asks/reply', { id: a.id, reply: input.value }).then((x) => { toast(x.error ? x.error : x.delivered ? 'Answered' : 'Answered, but she had stopped waiting'); loadAsks() }) }
    reply.addEventListener('click', send); input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send() })
    dismiss.addEventListener('click', () => post('/egirl/asks/dismiss', { id: a.id }).then(loadAsks))
    row.append(input, reply, dismiss); card.appendChild(row); box.appendChild(card)
  }
}

/* ---------- mic panel: push-to-talk -> WAV -> /transcribe ---------- */
const mic = { ctx: null, stream: null, source: null, proc: null, analyser: null, chunks: [], recording: false, level: 0 }
async function listMics() {
  const sel = $('micSel'); const cur = sel.value
  const ds = await navigator.mediaDevices?.enumerateDevices?.().catch(() => []) || []
  sel.innerHTML = '<option value="">default</option>'
  for (const d of ds.filter((d) => d.kind === 'audioinput')) sel.appendChild(new Option(d.label || `microphone ${sel.length}`, d.deviceId))
  sel.value = cur
}
listMics()
async function micStart() {
  if (mic.recording) return
  try {
    mic.stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: $('micSel').value || undefined, echoCancellation: true, noiseSuppression: true } })
  } catch (e) { $('micStatus').textContent = `mic: ${e.message}`; return }
  listMics() // labels appear once permission is granted
  mic.ctx = mic.ctx || new (window.AudioContext || window.webkitAudioContext)()
  await mic.ctx.resume()
  mic.source = mic.ctx.createMediaStreamSource(mic.stream)
  mic.analyser = mic.ctx.createAnalyser(); mic.analyser.fftSize = 512
  mic.proc = mic.ctx.createScriptProcessor(4096, 1, 1)
  mic.chunks = []
  mic.proc.onaudioprocess = (e) => { if (mic.recording) mic.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))) }
  mic.source.connect(mic.analyser); mic.analyser.connect(mic.proc); mic.proc.connect(mic.ctx.destination)
  mic.recording = true
  $('btnPtt').classList.add('on'); $('btnPtt').textContent = 'Listening… release to send'; $('micStatus').textContent = 'recording'
}
async function micStop() {
  if (!mic.recording) return
  mic.recording = false
  $('btnPtt').classList.remove('on'); $('btnPtt').textContent = 'Hold to talk'; $('micStatus').textContent = 'transcribing…'
  mic.proc.disconnect(); mic.analyser.disconnect(); mic.source.disconnect()
  for (const t of mic.stream.getTracks()) t.stop()
  const n = mic.chunks.reduce((a, c) => a + c.length, 0)
  const all = new Float32Array(n); let o = 0; for (const c of mic.chunks) { all.set(c, o); o += c.length }
  if (n < mic.ctx.sampleRate * 0.3) { $('micStatus').textContent = 'too short'; return }
  const wav = encodeWav(downsample(all, mic.ctx.sampleRate, 16000), 16000)
  try {
    const r = await fetch(`/transcribe${$('micAuto').checked ? '?send=1' : ''}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav }).then((x) => x.json())
    if (r.error) { $('micStatus').textContent = r.error; return }
    $('micStatus').textContent = r.text ? `${r.seconds.toFixed(1)}s → ${r.ms} ms` : 'heard nothing'
    if (r.text && !r.sent) { composer.value = r.text; composer.focus() }
    if (r.sent) showPanel('chat')
  } catch (e) { $('micStatus').textContent = `failed: ${e.message}` }
}
$('btnPtt').addEventListener('pointerdown', (e) => { e.preventDefault(); micStart() })
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) $('btnPtt').addEventListener(ev, micStop)
document.addEventListener('keydown', (e) => { if (e.code === 'Space' && !e.repeat && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) { e.preventDefault(); micStart() } })
document.addEventListener('keyup', (e) => { if (e.code === 'Space' && mic.recording) { e.preventDefault(); micStop() } })
function onTranscript(ev) {
  $('transcripts').querySelector('.empty')?.remove()
  const line = el('div', 'line'); line.append(el('b', null, ev.sent ? 'sent ' : 'heard '), document.createTextNode(ev.text || '(nothing)'))
  $('transcripts').prepend(line); while ($('transcripts').children.length > 30) $('transcripts').lastChild.remove()
}

/* ---------- chat panel (rendered from the reducer) ---------- */
function renderTurns() {
  const tl = $('timeline'); tl.innerHTML = ''
  if (!S.turns.turns.length) { tl.appendChild(el('div', 'empty', 'No turns yet. Send a message below.')); return }
  for (const t of S.turns.turns) {
    const box = el('div', `turn${t.error ? ' error' : ''}`)
    const you = el('div', 'you'); you.append('you  ', el('b', null, t.message)); box.appendChild(you)
    if (t.reasoning) { const d = el('details', `think${t.done ? '' : ' live'}`); d.append(el('summary', null, `thinking · ${t.reasoning.length} chars`), el('pre', null, t.reasoning)); box.appendChild(d) }
    if (t.tools.length) { const tools = el('div', 'tools'); for (const c of t.tools) { const chip = el('span', `tool${c.done ? ' done' : ''}${c.ok === false ? ' fail' : ''}`, c.name); if (c.args) chip.title = c.args; tools.appendChild(chip) } box.appendChild(tools) }
    if (t.awaiting) box.appendChild(el('span', 'awaiting', 'waiting on you · see Brain'))
    const reply = el('div', 'reply')
    if (t.error) reply.textContent = t.error
    else { for (const s of t.sentences) reply.appendChild(el('span', `s ${s.status}`, `${s.text} `)); if (!t.done) reply.appendChild(el('span', 'cursor')) }
    box.appendChild(reply)
    if (t.done) { const foot = el('div', 'foot'); foot.innerHTML = [`total <b>${ms(t.ms)}</b>`, t.firstAudio != null ? `first audio <b>${ms(t.firstAudio)}</b>` : '', t.reasoning ? `reasoning <b>${t.reasoning.length}</b> chars` : '', t.tokens != null ? `<b>${t.tokens}</b> tokens` : '', t.turns != null && t.turns > 1 ? `<b>${t.turns}</b> turns` : ''].filter(Boolean).join('<span style="opacity:.4"> · </span>'); box.appendChild(foot) }
    tl.appendChild(box)
  }
}
$('btnClearChat').addEventListener('click', () => { S.turns = turnReducer(undefined, { type: 'init' }); renderTurns() })
function onEvent(ev) {
  const before = S.turns.speaking
  S.turns = turnReducer(S.turns, ev)
  if (ev.type === 'turn' && ev.phase === 'start') { S.turnStart = performance.now(); S.ttfa = null; $('roTtfa').textContent = '…' }
  if (ev.type === 'turn' && ev.phase === 'done' && ev.awaiting) { toast('She is waiting on you: open Brain'); loadAsks() }
  if (ev.type === 'clip' && S.ttfa == null) { S.ttfa = performance.now() - S.turnStart; $('roTtfa').textContent = ms(S.ttfa); const t = S.turns.turns.find((x) => !x.done); if (t) t.firstAudio = S.ttfa }
  if (S.turns.speaking !== before || ev.type === 'stop') setState(S.state)
  $('caption').textContent = S.turns.caption; $('caption').classList.toggle('on', !!S.turns.caption)
  renderTurns()
}

/* ---------- director panel ---------- */
function applyDirectorUI(d) { if (!d) return; $('dirOn').checked = d.enabled; setRange('dirInt', 'dirIntVal', d.interval_s, (v) => v); $('dirPrompt').value = d.prompt }
const pushDirector = () => post('/director', { enabled: $('dirOn').checked, interval_s: Number($('dirInt').value), prompt: $('dirPrompt').value }).then((r) => toast(r.error || (r.director.enabled ? `Director on, every ${r.director.interval_s}s` : 'Director off')))
$('dirOn').addEventListener('change', pushDirector); bindRange('dirInt', 'dirIntVal', (v) => v, debounce(pushDirector, 300))
$('btnDirSave').addEventListener('click', pushDirector)
$('btnDirRun').addEventListener('click', () => post('/director', { prompt: $('dirPrompt').value }).then(() => post('/director/run')).then(() => { showPanel('chat'); toast('Director fired') }))
bindRange('gap', 'gapVal', (v) => v, () => {})
$('btnScriptRun').addEventListener('click', () => {
  const lines = $('scriptText').value.split('\n').map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return toast('Script is empty')
  post('/script', { lines, gap_ms: Number($('gap').value) }).then((r) => toast(r.error || (r.muted ? 'Muted: script not read' : `Reading ${r.total} lines`)))
})
$('btnScriptStop').addEventListener('click', () => post('/script/stop'))
function onScript(ev) {
  const p = $('scriptProgress')
  if (ev.phase === 'start') p.textContent = `0 / ${ev.total}`
  else if (ev.phase === 'line') p.textContent = `${ev.index + 1} / ${ev.total}`
  else if (ev.phase === 'done') p.textContent = 'done'
  else if (ev.phase === 'stopped') p.textContent = 'stopped'
}
function onDirector(ev) { $('dirLast').textContent = ev.phase === 'fired' ? `fired ${new Date().toLocaleTimeString()}` : `skipped: ${ev.reason}` }

/* ---------- twitch panel ---------- */
function onChat(ev) {
  $('twEmpty')?.remove()
  const line = el('div', `line${ev.mentioned ? ' mentioned' : ''}`)
  line.append(el('time', null, new Date(ev.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })), el('b', null, ev.author), document.createTextNode(ev.text))
  const log = $('chatlog'); log.prepend(line); while (log.children.length > 200) log.lastChild.remove()
}

$('btnTwPause').addEventListener('click', () => post('/twitch', { paused: !S.health?.twitch?.paused }).then(pollHealth))
$('btnTwReply').addEventListener('click', () => post('/twitch', { reply: !S.health?.twitch?.reply }).then(pollHealth))

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
    if (h.twitch) {
      $('twStatus').textContent = h.twitch.paused ? 'paused' : h.twitch.connected ? 'connected' : 'reconnecting'; $('twStatus').style.color = h.twitch.paused ? 'var(--warn)' : h.twitch.connected ? 'var(--ok)' : 'var(--warn)'
      $('twQueued').textContent = h.twitch.queued; $('twDropped').textContent = h.twitch.dropped; $('twSent').textContent = h.twitch.sent
      $('btnTwPause').disabled = false; $('btnTwReply').disabled = false
      $('btnTwPause').textContent = h.twitch.paused ? 'Resume intake' : 'Pause intake'; $('btnTwPause').classList.toggle('on', !!h.twitch.paused)
      $('btnTwReply').textContent = `Replies: ${h.twitch.reply ? 'on' : 'off'}`; $('btnTwReply').classList.toggle('on', !!h.twitch.reply)
    }
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
      case 'script': onScript(ev); break
      case 'director': onDirector(ev); break
      case 'transcript': onTranscript(ev); break
      case 'clip': addClipStat(ev); onEvent(ev); break
      case 'speak': case 'playing': case 'spoke': case 'stop': case 'turn': case 'reasoning': case 'token': case 'tool': case 'tool_done': onEvent(ev); break
    }
  }
}
connect()
loadModelList(); loadTalents(); pollHealth(); setInterval(pollHealth, 3000)
