/* Stage console: the operator's view of one talent. Talks to the server over the same
 * WebSocket the render page uses (announcing itself as a console so it also gets turn events),
 * and reads parameter ranges and live values straight out of the preview iframe, which is the
 * real render page with sound muted. */
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

/* ---------- state ---------- */
const S = {
  talent: null, model: null, expressions: [], modelList: [],
  state: 'idle', mood: 'neutral', speaking: false,
  clips: [], turnStart: 0, ttfa: null, currentTurn: null, currentClipId: null,
  pinned: {}, params: [],
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

/* ---------- panels ---------- */
function showPanel(name) { app.dataset.panel = name; document.querySelectorAll('.rail-btn').forEach((b) => b.classList.toggle('active', b.dataset.panel === name)) }
document.querySelectorAll('.rail-btn').forEach((b) => b.addEventListener('click', () => showPanel(b.dataset.panel)))
showPanel('model')

/* ---------- HUD ---------- */
function setState(state, detail) {
  S.state = state
  const pill = $('statePill'); const shown = S.speaking && state === 'idle' ? 'speaking' : state
  pill.dataset.state = shown
  $('stateText').textContent = detail && shown !== 'speaking' ? `${shown} · ${detail}` : shown
}
function setMood(m) { S.mood = m; document.querySelectorAll('.chip[data-mood]').forEach((c) => c.classList.toggle('active', c.dataset.mood === m)) }
function setTalent(t) {
  S.talent = t
  $('talentName').textContent = t.name
  $('talentAvatar').textContent = t.name.slice(0, 1)
  $('talentModel').textContent = t.model
  document.title = `Stage · ${t.name}`
  $('voiceSel').value = t.voice; $('rvcSel').value = t.rvc || ''
  $('pitch').value = t.pitch; $('pitchVal').textContent = t.pitch
  $('speed').value = t.speed; $('speedVal').textContent = Number(t.speed).toFixed(2)
  renderModels()
}
$('btnBg').addEventListener('click', () => { $('stageFrame').classList.toggle('checker'); $('btnBg').classList.toggle('on') })
const obsUrl = `${location.origin}/`
$('obsUrl').textContent = obsUrl
$('btnCopy').addEventListener('click', () => copy(obsUrl))
$('btnCopy2').addEventListener('click', () => copy(obsUrl))

/* level meter + live parameter bars, read from the preview each frame */
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
$('btnSay').addEventListener('click', async () => { const text = composer.value.trim(); if (!text) return; composer.value = ''; await post('/say', { text }) })
$('btnStop').addEventListener('click', () => post('/interrupt').then(() => toast('Stopped')))
document.querySelectorAll('.chip[data-mood]').forEach((c) => c.addEventListener('click', () => post('/cue', { type: 'mood', mood: c.dataset.mood })))
document.querySelectorAll('.chip[data-gesture]').forEach((c) => c.addEventListener('click', () => post('/cue', { type: 'gesture', name: c.dataset.gesture })))
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')
  if (e.key === 'Escape') { post('/interrupt'); toast('Stopped'); return }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return
  if (MOOD_KEYS[e.key]) post('/cue', { type: 'mood', mood: MOOD_KEYS[e.key] })
  else if (e.key === 'n') post('/cue', { type: 'gesture', name: 'nod' })
  else if (e.key === 'm') showPanel('model'); else if (e.key === 'v') showPanel('voice'); else if (e.key === 'c') showPanel('chat')
  else if (e.key === 't') showPanel('twitch'); else if (e.key === 's') showPanel('settings')
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
    if (mood) b.addEventListener('click', () => post('/cue', { type: 'mood', mood }))
    else b.disabled = true
    list.appendChild(b)
  }
}
async function loadParams() {
  const st = preview.contentWindow?.stage
  const m = st?.model
  if (!m || !S.model) return setTimeout(loadParams, 300)
  const core = m.internalModel.coreModel.getModel().parameters
  let names = {}, groups = {}, order = []
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
    const p = { id, index: i, min: core.minimumValues[i], max: core.maximumValues[i], live, slider, val, row }
    S.params.push(p)
    const pin = debounce((v) => post('/cue', { type: 'param', id, value: v }), 30)
    slider.addEventListener('input', () => { const v = Number(slider.value); S.pinned[id] = v; row.classList.add('pinned'); val.textContent = v.toFixed(2); pin(v) })
    slider.addEventListener('dblclick', () => release(id))
  }
}
function release(id) { delete S.pinned[id]; document.querySelector(`.param[data-id="${CSS.escape(id)}"]`)?.classList.remove('pinned'); post('/cue', { type: 'param', id, value: null }) }
$('btnRelease').addEventListener('click', () => Object.keys(S.pinned).forEach(release))

/* ---------- voice panel ---------- */
{
  const sel = $('voiceSel')
  for (const [group, list] of Object.entries(VOICES)) { const og = el('optgroup'); og.label = group; for (const v of list) og.appendChild(new Option(v, v)); sel.appendChild(og) }
}
const pushVoice = debounce(() => post('/voice', { voice: $('voiceSel').value, rvc: $('rvcSel').value || null, pitch: Number($('pitch').value), speed: Number($('speed').value) }), 250)
$('voiceSel').addEventListener('change', pushVoice); $('rvcSel').addEventListener('change', pushVoice)
$('pitch').addEventListener('input', () => { $('pitchVal').textContent = $('pitch').value; pushVoice() })
$('speed').addEventListener('input', () => { $('speedVal').textContent = Number($('speed').value).toFixed(2); pushVoice() })
$('btnTest').addEventListener('click', () => post('/say', { text: $('testLine').value }))
function addClipStat(c) {
  S.clips.push(c); if (S.clips.length > 40) S.clips.shift()
  $('stClips').textContent = S.clips.length
  $('stSynth').textContent = ms(c.genMs); $('stAudio').textContent = secs(c.seconds)
  const rtfs = S.clips.map((x) => x.genMs / 1000 / (x.seconds || 1))
  $('stRtf').textContent = (rtfs.reduce((a, b) => a + b, 0) / rtfs.length).toFixed(3)
  $('roSynth').textContent = ms(c.genMs); $('roRtf').textContent = (c.genMs / 1000 / (c.seconds || 1)).toFixed(2)
  const sp = $('spark'); sp.innerHTML = ''
  const max = Math.max(...S.clips.map((x) => x.genMs), 1)
  for (const x of S.clips.slice(-30)) { const bar = el('i'); bar.style.height = `${Math.max(6, (x.genMs / max) * 100)}%`; bar.title = `${ms(x.genMs)} for ${secs(x.seconds)}`; sp.appendChild(bar) }
}

/* ---------- chat panel ---------- */
function startTurn(message) {
  $('timeline').querySelector('.empty')?.remove()
  const t = el('div', 'turn')
  const you = el('div', 'you'); you.append('you  ', el('b', null, message)); t.appendChild(you)
  const think = el('details', 'think live'); const sum = el('summary', null, 'thinking'); const pre = el('pre'); think.append(sum, pre); think.hidden = true; t.appendChild(think)
  const tools = el('div', 'tools'); tools.hidden = true; t.appendChild(tools)
  const reply = el('div', 'reply'); const cursor = el('span', 'cursor'); reply.appendChild(cursor); t.appendChild(reply)
  const foot = el('div', 'foot'); t.appendChild(foot)
  $('timeline').prepend(t)
  S.currentTurn = { el: t, think, pre, tools, reply, cursor, foot, reasoning: '', text: '', t0: performance.now(), firstToken: null }
  S.turnStart = performance.now(); S.ttfa = null; $('roTtfa').textContent = '…'
}
function onTurnEvent(ev) {
  const T = S.currentTurn
  if (ev.type === 'turn' && ev.phase === 'start') return startTurn(ev.message)
  if (!T) return
  if (ev.type === 'reasoning') { T.reasoning += ev.v; T.think.hidden = false; T.pre.textContent = T.reasoning; T.think.querySelector('summary').textContent = `thinking · ${T.reasoning.length} chars · ${ms(performance.now() - T.t0)}`; T.pre.scrollTop = T.pre.scrollHeight }
  else if (ev.type === 'tool') { T.tools.hidden = false; for (const n of ev.v) { const c = el('span', 'tool', n); c.dataset.tool = n; T.tools.appendChild(c) } }
  else if (ev.type === 'tool_done') { const c = [...T.tools.children].reverse().find((x) => x.dataset.tool === ev.v && !x.classList.contains('done')); c?.classList.add('done') }
  else if (ev.type === 'token') { if (T.firstToken == null) { T.firstToken = performance.now() - T.t0; T.think.classList.remove('live') } T.text += ev.v }
  else if (ev.type === 'clip') {
    if (S.ttfa == null) { S.ttfa = performance.now() - S.turnStart; $('roTtfa').textContent = ms(S.ttfa) }
    const s = el('span', 's queued', `${ev.text} `); sentences.set(ev.id, s); T.reply.insertBefore(s, T.cursor)
    if (sentences.size > 400) sentences.delete(sentences.keys().next().value)
  }
  else if (ev.type === 'turn' && (ev.phase === 'done' || ev.phase === 'error')) {
    T.cursor.remove(); T.think.classList.remove('live')
    if (ev.phase === 'error') { T.el.classList.add('error'); T.reply.textContent = ev.message }
    const parts = [`total <b>${ms(ev.ms)}</b>`]
    if (T.firstToken != null) parts.push(`first token <b>${ms(T.firstToken)}</b>`)
    if (S.ttfa != null) parts.push(`first audio <b>${ms(S.ttfa)}</b>`)
    if (T.reasoning) parts.push(`reasoning <b>${T.reasoning.length}</b> chars`)
    T.foot.innerHTML = parts.join('<span style="opacity:.4"> · </span>')
    S.currentTurn = null
  }
}
/* 'speak' announces a clip (it is queued); 'playing' and 'spoke' come from a page as the clip
 * actually starts and ends. The console shows what is audible, so it keys off those two. */
const clipText = new Map(), sentences = new Map()
function onSpeak(cue) { clipText.set(cue.id, cue.text) }
function onPlaying(id) {
  if (S.currentClipId === id) return // a second page reporting the same clip
  S.speaking = true; S.currentClipId = id; setState(S.state)
  $('caption').textContent = clipText.get(id) || ''; $('caption').classList.add('on'); markSentence(id, 'now')
}
function onSpoke(id) { markSentence(id, 'done'); if (S.currentClipId === id) { S.speaking = false; S.currentClipId = null; setState(S.state); $('caption').classList.remove('on') } }
function markSentence(id, cls) { const s = sentences.get(id); if (s) s.className = `s ${cls}` }
$('btnClearChat').addEventListener('click', () => { $('timeline').innerHTML = '<div class="empty">No turns yet. Send a message below.</div>' })

/* ---------- twitch panel ---------- */
function onChat(ev) {
  $('twEmpty')?.remove()
  const line = el('div', `line${ev.mentioned ? ' mentioned' : ''}`)
  const t = el('time', null, new Date(ev.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }))
  line.append(t, el('b', null, ev.author), document.createTextNode(ev.text))
  const log = $('chatlog'); log.prepend(line); while (log.children.length > 200) log.lastChild.remove()
}

/* ---------- health ---------- */
async function pollHealth() {
  try {
    const h = await fetch('/health').then((r) => r.json())
    $('healthJson').textContent = JSON.stringify(h, null, 1)
    const dots = $('railHealth').querySelectorAll('.dot')
    dots[0].className = 'dot ok'; dots[1].className = `dot ${h.voice && !h.voice.error ? 'ok' : 'bad'}`; dots[2].className = `dot ${h.pages > 0 ? 'ok' : ''}`
    $('railHealth').title = `server ok · voice ${h.voice?.error ? 'down' : 'ok'} · ${h.pages} page(s)`
    if (h.voice?.rvc) { const sel = $('rvcSel'); const cur = sel.value; sel.innerHTML = '<option value="">off (raw Kokoro)</option>'; for (const n of h.voice.rvc) sel.appendChild(new Option(n, n)); sel.value = S.talent?.rvc && h.voice.rvc.includes(S.talent.rvc) ? S.talent.rvc : cur }
    if (h.twitch) { $('twStatus').textContent = h.twitch.connected ? 'connected' : 'reconnecting'; $('twStatus').style.color = h.twitch.connected ? 'var(--ok)' : 'var(--warn)'; $('twQueued').textContent = h.twitch.queued; $('twDropped').textContent = h.twitch.dropped; $('twSent').textContent = h.twitch.sent }
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
      case 'load': S.model = ev.model; S.expressions = ev.expressions || []; renderExpressions(); setTimeout(loadParams, 600); if (S.talent) { S.talent.model = ev.model.replace(/^\/models\//, ''); $('talentModel').textContent = S.talent.model; renderModels() } break
      case 'talent': setTalent(ev); break
      case 'state': setState(ev.state, ev.detail); break
      case 'mood': setMood(ev.mood); break
      case 'speak': onSpeak(ev); break
      case 'playing': onPlaying(ev.id); break
      case 'spoke': onSpoke(ev.id); break
      case 'stop': S.speaking = false; S.currentClipId = null; setState(S.state); $('caption').classList.remove('on'); break
      case 'clip': addClipStat(ev); onTurnEvent(ev); break
      case 'chat': onChat(ev); break
      case 'turn': case 'reasoning': case 'token': case 'tool': case 'tool_done': onTurnEvent(ev); break
    }
  }
}
connect()
loadModelList(); loadTalents(); pollHealth(); setInterval(pollHealth, 3000)
