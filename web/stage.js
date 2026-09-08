/* Stage page: renders one Live2D talent and applies cues from the server over a WebSocket.
 *
 * Query params:  ?bg=1 paints the brand background (default is transparent for OBS);
 *                ?status=0 hides the debug status line;
 *                ?mute=1 keeps lipsync but plays no sound (the console's preview);
 *                ?caption=0 hides the on-page caption (the console draws its own);
 *                ?edit=1 lets the mouse move (drag) and scale (wheel) the model; the result is
 *                        POSTed to /transform so every page, OBS included, follows.
 *
 * Three things about pixi-live2d-display 0.5 that are easy to get wrong:
 *  1. The bundle needs the Cubism 2 runtime (live2d.min.js) loaded even for Cubism 4 models.
 *  2. It does not auto-register the PixiJS ticker; we call model.update(dt) ourselves.
 *  3. coreModel.*ParameterValueById wants CubismId handles, not strings; a string silently
 *     writes to a phantom slot. Parameters are addressed by index here.
 */
import { clampTransform, fitModel, mouthAt } from './core.js'

const q = new URLSearchParams(location.search)
const editable = q.get('edit') === '1'
if (q.get('bg') === '1') document.body.classList.add('opaque')
if (q.get('status') === '0') document.getElementById('status').classList.add('hidden')
const captionParam = q.get('caption') !== '0'
const showCaptions = () => captionParam && scene.captions.show
const statusEl = document.getElementById('status')
const captionEl = document.getElementById('caption')
const status = (s) => { statusEl.textContent = s }

const app = new PIXI.Application({ resizeTo: window, backgroundAlpha: 0, antialias: true })
document.body.appendChild(app.view)

const MOODS = {
  neutral:   { bl: 0,    br: 0,    ba: 0,    form: 0,    eye: 1 },
  happy:     { bl: 0.6,  br: 0.6,  ba: 0,    form: 1,    eye: 0.85 },
  sad:       { bl: -0.5, br: -0.5, ba: -0.6, form: -0.8, eye: 0.7 },
  angry:     { bl: -0.9, br: -0.9, ba: 0.8,  form: -0.4, eye: 0.9 },
  surprised: { bl: 0.9,  br: 0.9,  ba: 0,    form: 0.2,  eye: 1.15 },
}
const lerp = (a, b, k) => a + (b - a) * k

let model = null, pidx = {}
let transform = { x: 0, y: 0, scale: 1 }
let scene = { motion: { sway: 1, speed: 1, blink: 3.7 }, captions: { show: true, size: 22 }, background: { color: '', image: '' }, screen: { x: -0.55, y: -0.15, w: 0.4 } }
let imageTimer
let fitNow = () => {}
// mood -> [{id, value, blend}] from the model's .exp3 files (server finds them; see 'load' cue).
// Applied on top of the parameter-driven moods with a fade, the way Cubism's ExpressionMotion does.
let expressions = {}, expWeight = {}
let mood = 'neutral', state = 'idle', poseOn = 0, nodT = -1
const cur = { bl: 0, br: 0, ba: 0, form: 0, eye: 1 }
let mouth = 0, analyser = null, ac = null
// Lipsync: a clip's mouth track (from the voice service) is read at the audio clock; the
// analyser is only the fallback for clips without one. See core.mouthAt.
let track = null, trackStart = 0, form = 0
const muted = q.get('mute') === '1'
const pinned = {} // param id -> value from the console's sliders; applied last, released with null

const set = (id, v) => { const i = pidx[id]; if (i !== undefined) model.internalModel.coreModel.setParameterValueByIndex(i, v) }

async function load(url) {
  if (model) { app.stage.removeChild(model); model.destroy(); model = null }
  const m = await PIXI.live2d.Live2DModel.from(url, { autoInteract: false })
  app.stage.addChild(m)
  // Natural size before any scale, so fitModel's math is stable across re-fits.
  m.scale.set(1)
  const natural = { w: m.width, h: m.height }
  const fit = () => {
    const f = fitModel({ w: app.screen.width, h: app.screen.height }, natural, transform)
    m.scale.set(f.scale); m.anchor.set(0.5, 0.5); m.position.set(f.x, f.y)
  }
  fitNow = fit
  fit(); window.addEventListener('resize', fit)
  pidx = {}; m.internalModel.coreModel.getModel().parameters.ids.forEach((id, i) => { pidx[id] = i })

  let t = 0, last = performance.now()
  m.internalModel.on('beforeModelUpdate', () => {
    const now = performance.now(), dt = (now - last) / 1000; last = now; t += dt
    // Idle wander through the focus controller; Cubism physics turns it into hair/body sway.
    const { sway, speed } = scene.motion
    const ts = t * speed
    let fx = (Math.sin(ts * 0.55) * 0.35 + Math.sin(ts * 1.3) * 0.1) * sway
    let fy = Math.sin(ts * 0.4 + 1) * 0.15 * sway
    if (state === 'thinking') { fx += 0.35; fy += 0.3 }          // glance up and away
    if (state === 'working') { fy -= 0.25; fx += Math.sin(t * 6) * 0.05 } // head down, busy
    if (nodT >= 0) { fy += Math.sin(nodT * Math.PI * 2) * -0.5; nodT += dt * 2.2; if (nodT > 1) nodT = -1 }
    m.internalModel.focusController.focus(fx, fy, false)
    const blink = (t % Math.max(0.5, scene.motion.blink)) < 0.12 ? 0 : 1
    const target = expressions[mood] ? MOODS.neutral : (MOODS[mood] || MOODS.neutral)
    for (const k in cur) cur[k] = lerp(cur[k], target[k], 0.08)
    set('ParamEyeLOpen', cur.eye * blink); set('ParamEyeROpen', cur.eye * blink)
    set('ParamBrowLY', cur.bl); set('ParamBrowRY', cur.br); set('ParamBrowLAngle', cur.ba); set('ParamBrowRAngle', cur.ba)
    let level = 0, targetForm = 0
    const tracked = track && ac ? mouthAt(track, ac.currentTime - trackStart - (ac.outputLatency || ac.baseLatency || 0)) : null
    if (tracked) { level = tracked.open; targetForm = tracked.form }
    else if (analyser) {
      const b = new Uint8Array(analyser.fftSize); analyser.getByteTimeDomainData(b)
      let s = 0; for (const v of b) { const d = (v - 128) / 128; s += d * d }
      level = Math.min(1, Math.sqrt(s / b.length) * 6)
    }
    mouth = lerp(mouth, level, tracked ? 0.7 : level > mouth ? 0.6 : 0.25); set('ParamMouthOpenY', mouth)
    // Vowel shape rides on top of the mood's mouth form only while the mouth is open.
    form = lerp(form, targetForm * Math.min(1, mouth * 2), 0.3)
    set('ParamMouthForm', cur.form + form * 0.7)
    for (const name in expressions) {
      expWeight[name] = lerp(expWeight[name] || 0, name === mood ? 1 : 0, 0.1)
      const w = expWeight[name]; if (w < 0.005) continue
      for (const p of expressions[name]) {
        const i = pidx[p.id]; if (i === undefined) continue
        const c = m.internalModel.coreModel.getParameterValueByIndex(i)
        const v = p.blend === 'Add' ? c + p.value * w : p.blend === 'Multiply' ? c * (1 + (p.value - 1) * w) : lerp(c, p.value, w)
        m.internalModel.coreModel.setParameterValueByIndex(i, v)
      }
    }
    set('Param', poseOn) // chb119's pose toggle; harmless on models without it
    for (const id in pinned) set(id, pinned[id])
  })
  model = m
  status(`model ${url}\nparams ${Object.keys(pidx).length}`)
}
app.ticker.add(() => { if (model) model.update(app.ticker.deltaMS) })
// Browsers pause requestAnimationFrame in hidden tabs. OBS never hides the page, but a plain
// browser tab in the background would freeze mid-sentence without this.
setInterval(() => { if (document.hidden && model) { model.update(33); app.render() } }, 33)

/* ---- audio queue: clips play strictly in the order the server announced them ---- */
const queue = []
let playing = false, current = null
async function pump() {
  if (playing || !queue.length) return
  playing = true
  const cue = queue.shift()
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)()
    if (ac.state !== 'running') await ac.resume()
    const buf = await ac.decodeAudioData(await (await fetch(cue.url)).arrayBuffer())
    const src = ac.createBufferSource(); src.buffer = buf; current = src
    track = cue.mouth || null
    analyser = ac.createAnalyser(); analyser.fftSize = 512
    src.connect(analyser)
    if (muted) { const g = ac.createGain(); g.gain.value = 0; analyser.connect(g); g.connect(ac.destination) }
    else analyser.connect(ac.destination)
    if (showCaptions()) { captionEl.textContent = cue.text; captionEl.style.display = 'block' }
    send({ type: 'playing', id: cue.id })
    await new Promise((res) => { src.onended = res; trackStart = ac.currentTime; src.start() })
  } catch (e) { status(`playback error: ${e.message}`) }
  analyser = null; current = null; track = null; captionEl.style.display = 'none'
  send({ type: 'spoke', id: cue.id })
  playing = false
  pump()
}

async function loadExpressions(list) {
  expressions = {}; expWeight = {}
  for (const e of list) {
    const key = Object.keys(MOODS).find((m) => e.name.toLowerCase().includes(m))
    if (!key) continue
    try {
      const j = await (await fetch(e.url)).json()
      expressions[key] = (j.Parameters || []).map((p) => ({ id: p.Id, value: p.Value, blend: p.Blend || 'Add' }))
    } catch (err) { status(`expression ${e.name}: ${err.message}`) }
  }
}

/* ---- cues ---- */
function apply(cue) {
  switch (cue.type) {
    case 'load':
      loadExpressions(cue.expressions || [])
      if (cue.transform) transform = clampTransform(cue.transform)
      if (cue.scene) applyScene(cue.scene)
      load(cue.model).catch((e) => status(`load failed: ${e.message}`))
      break
    case 'transform': transform = clampTransform(cue); fitNow(); break
    case 'image': showImage(cue); break
    case 'scene': applyScene(cue.scene); break
    case 'speak': queue.push(cue); pump(); break
    case 'mood': mood = cue.mood; break
    case 'state': state = cue.state; if (cue.detail) status(`${cue.state}: ${cue.detail}`); break
    case 'gesture': if (cue.name === 'nod') nodT = 0; else if (cue.name === 'pose') poseOn = poseOn ? 0 : 1; break
    case 'caption': captionEl.textContent = cue.text; captionEl.style.display = cue.text ? 'block' : 'none'; break
    case 'stop': queue.length = 0; if (current) { try { current.stop() } catch {} } break
    case 'param': if (cue.value === null) delete pinned[cue.id]; else pinned[cue.id] = cue.value; break
  }
}

function applyScene(sc) {
  scene = { motion: { ...scene.motion, ...sc.motion }, captions: { ...scene.captions, ...sc.captions }, background: { ...scene.background, ...sc.background }, screen: { ...scene.screen, ...sc.screen } }
  captionEl.style.fontSize = `${scene.captions.size}px`
  if (!showCaptions()) captionEl.style.display = 'none'
  const bg = scene.background
  const img = bg.image ? (/^https?:\/\//.test(bg.image) ? bg.image : `/models/${bg.image}`) : ''
  document.body.classList.toggle('opaque', !!bg.color || !!img || q.get('bg') === '1')
  document.body.style.background = img ? `${bg.color || '#000'} url("${img}") center / cover no-repeat` : bg.color || ''
  placeScreen()
}

/* ---- the screen: a picture the talent shows, placed by scene.screen ---- */
const screenEl = document.getElementById('screen')
function placeScreen() {
  const { x, y, w } = scene.screen
  screenEl.style.width = `${w * 100}%`
  screenEl.style.left = `${50 + x * 50}%`; screenEl.style.top = `${50 + y * 50}%`
}
function showImage(cue) {
  clearTimeout(imageTimer)
  if (!cue.url) { screenEl.classList.remove('on'); return }
  const img = screenEl.querySelector('img'); const cap = screenEl.querySelector('figcaption')
  img.onload = () => screenEl.classList.add('on')
  img.src = cue.url; img.alt = cue.caption || ''
  cap.textContent = cue.caption || ''; cap.style.display = cue.caption ? 'block' : 'none'
  if (cue.seconds > 0) imageTimer = setTimeout(() => screenEl.classList.remove('on'), cue.seconds * 1000)
}

/* ---- edit mode: drag to move, wheel to scale; the server rebroadcasts to every page ---- */
if (editable) {
  let drag = null
  const push = (() => { let h; return () => { clearTimeout(h); h = setTimeout(() => fetch('/transform', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(transform) }), 120) } })()
  const view = app.view
  view.style.cursor = 'grab'
  view.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, tx: transform.x, ty: transform.y }; view.setPointerCapture(e.pointerId); view.style.cursor = 'grabbing' })
  view.addEventListener('pointermove', (e) => {
    if (!drag) return
    transform = clampTransform({ ...transform, x: drag.tx + ((e.clientX - drag.x) / app.screen.width) * 2, y: drag.ty + ((e.clientY - drag.y) / app.screen.height) * 2 })
    fitNow()
  })
  const end = () => { if (drag) { drag = null; view.style.cursor = 'grab'; push() } }
  view.addEventListener('pointerup', end); view.addEventListener('pointercancel', end)
  view.addEventListener('wheel', (e) => { e.preventDefault(); transform = clampTransform({ ...transform, scale: transform.scale * (e.deltaY < 0 ? 1.06 : 1 / 1.06) }); fitNow(); push() }, { passive: false })
}

/* ---- websocket with reconnect ---- */
let ws
function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)) }
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
  ws.onopen = () => send({ type: 'ready' })
  ws.onmessage = (ev) => { try { apply(JSON.parse(ev.data)) } catch (e) { status(`bad cue: ${e.message}`) } }
  ws.onclose = () => setTimeout(connect, 1500)
}
connect()

// Autoplay policy: audio needs one user gesture in a normal browser tab. OBS's browser source
// does not enforce it. Any click on the page unlocks the AudioContext.
document.addEventListener('click', () => { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); ac.resume() })
window.stage = { apply, get model() { return model }, get level() { return mouth }, get form() { return form }, get tracked() { return !!track }, get transform() { return transform } }
