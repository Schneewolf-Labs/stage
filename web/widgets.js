/* Widgets on the render page: the picture screen, the caption box and web-page frames, each
 * placed by a box from the scene (fractions of the canvas). In edit mode (the console preview)
 * each gets an outline to drag and a corner to resize; the result goes to POST /scene and the
 * server rebroadcasts it to every page. The geometry lives in core.js. */
import { moveBox, resizeBox, widgetPatch } from './core.js'

const framesEl = document.getElementById('frames')
const editEl = document.getElementById('edit')

/** Put an element where a box says. */
export function place(el, b) {
  el.style.left = `${b.x * 100}%`
  el.style.top = `${b.y * 100}%`
  el.style.width = `${b.w * 100}%`
  el.style.height = `${b.h * 100}%`
}

/** One iframe per shown frame, reused by id so a scene update does not reload the page in it. */
export function renderFrames(frames) {
  const shown = frames.filter((f) => f.show)
  for (const f of shown) {
    let el = [...framesEl.children].find((c) => c.dataset.id === f.id)
    if (!el) {
      el = document.createElement('iframe')
      el.dataset.id = f.id
      el.setAttribute('allowtransparency', 'true')
      el.setAttribute('scrolling', 'no')
      framesEl.append(el)
    }
    if (el.getAttribute('src') !== f.url) el.src = f.url
    place(el, f)
  }
  for (const el of [...framesEl.children]) if (!shown.some((f) => f.id === el.dataset.id)) el.remove()
}

const label = (url) => {
  try { return new URL(url).host + new URL(url).pathname } catch { return url }
}

/**
 * Edit handles for every shown widget. `live(key, box)` moves the real widget while dragging;
 * `post(body)` saves the final box. Handles sit on top of everything, so a drag on a widget
 * never reaches the model underneath.
 */
export function renderEdit(scene, live, post) {
  const items = [
    { key: 'screen', name: 'screen', box: scene.screen, show: scene.screen.show },
    { key: 'captions', name: 'caption', box: scene.captions, show: scene.captions.show },
    ...scene.frames.map((f) => ({ key: `frame:${f.id}`, name: label(f.url), box: f, show: f.show })),
  ]
  editEl.replaceChildren(...items.filter((i) => i.show).map((i) => handle(i, scene, live, post)))
}

function handle(item, scene, live, post) {
  const el = document.createElement('div')
  el.className = 'wedit'
  el.append(document.createElement('b'), document.createElement('i'))
  el.querySelector('b').textContent = item.name
  place(el, item.box)
  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation()
    el.setPointerCapture(e.pointerId)
    const resize = e.target.tagName === 'I'
    const start = { x: e.clientX, y: e.clientY, box: { x: item.box.x, y: item.box.y, w: item.box.w, h: item.box.h } }
    let box = start.box
    const move = (ev) => {
      const dx = (ev.clientX - start.x) / innerWidth
      const dy = (ev.clientY - start.y) / innerHeight
      box = resize ? resizeBox(start.box, dx, dy) : moveBox(start.box, dx, dy)
      place(el, box)
      live(item.key, box)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      if (box !== start.box) post(widgetPatch(scene, item.key, box))
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  })
  return el
}
