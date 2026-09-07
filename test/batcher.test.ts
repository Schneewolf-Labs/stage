import { describe, expect, test } from 'bun:test'
import { ChatBatcher, formatBatch } from '../src/batcher'
import type { ChatLine } from '../src/types'

let t = 0
const line = (text: string, mentioned = false, author = 'viewer'): ChatLine => ({
  author,
  text,
  at: ++t,
  mentioned,
})

function setup(maxBatch = 3, maxQueue?: number) {
  const batches: { lines: ChatLine[]; skipped: number }[] = []
  let busy = false
  const b = new ChatBatcher({ maxBatch, maxQueue, isBusy: () => busy }, (lines, skipped) =>
    batches.push({ lines, skipped }),
  )
  return { b, batches, setBusy: (v: boolean) => (busy = v) }
}

describe('ChatBatcher', () => {
  test('tick releases the queue when free, nothing when empty', () => {
    const { b, batches } = setup()
    b.tick()
    expect(batches).toHaveLength(0)
    b.add(line('hi'))
    b.add(line('hello'))
    b.tick()
    expect(batches).toHaveLength(1)
    expect(batches[0]?.lines.map((l) => l.text)).toEqual(['hi', 'hello'])
    expect(batches[0]?.skipped).toBe(0)
    expect(b.size).toBe(0)
  })

  test('holds the queue while busy, releases on the next free tick', () => {
    const { b, batches, setBusy } = setup()
    setBusy(true)
    b.add(line('a'))
    b.tick()
    expect(batches).toHaveLength(0)
    expect(b.size).toBe(1)
    setBusy(false)
    b.tick()
    expect(batches).toHaveLength(1)
  })

  test('a mention flushes immediately, or waits when busy instead of being lost', () => {
    const { b, batches, setBusy } = setup()
    b.add(line('chatter'))
    b.add(line('stage say hi', true))
    expect(batches).toHaveLength(1)
    expect(batches[0]?.lines.map((l) => l.text)).toEqual(['chatter', 'stage say hi'])

    setBusy(true)
    b.add(line('stage again', true))
    expect(batches).toHaveLength(1)
    setBusy(false)
    b.tick()
    expect(batches).toHaveLength(2)
    expect(batches[1]?.lines[0]?.text).toBe('stage again')
  })

  test('flush keeps mentions plus the newest of the rest and reports the skipped count', () => {
    const { b, batches } = setup(3)
    for (const s of ['old1', 'old2', 'old3']) b.add(line(s))
    b.add(line('mention', true))
    // mention flushed everything above: 'mention' + newest two of the rest.
    expect(batches[0]?.lines.map((l) => l.text)).toEqual(['old2', 'old3', 'mention'])
    expect(batches[0]?.skipped).toBe(1)
    expect(b.dropped).toBe(1)
  })

  test('mentions alone can fill a batch; the newest mentions win', () => {
    const { b, batches, setBusy } = setup(2)
    setBusy(true)
    for (const s of ['m1', 'm2', 'm3']) b.add(line(s, true))
    b.add(line('plain'))
    setBusy(false)
    b.tick()
    expect(batches[0]?.lines.map((l) => l.text)).toEqual(['m2', 'm3'])
    expect(batches[0]?.skipped).toBe(2)
  })

  test('caps the waiting queue, dropping the oldest unmentioned line first', () => {
    const { b, setBusy } = setup(3, 3)
    setBusy(true)
    b.add(line('keep me', true))
    b.add(line('a'))
    b.add(line('b'))
    b.add(line('c'))
    expect(b.size).toBe(3)
    expect(b.dropped).toBe(1)
    setBusy(false)
    b.tick()
  })
})

describe('formatBatch', () => {
  test('one line per message, mentions marked, skipped count appended', () => {
    const out = formatBatch(
      'nbeerbower',
      [line('is this live', false, 'kanade_fan'), line('say hi to chat', true, 'nbeerbower')],
      4,
    )
    expect(out.startsWith('[Twitch chat in #nbeerbower.')).toBe(true)
    expect(out).toContain('\n\nkanade_fan: is this live\nnbeerbower (@you): say hi to chat\n')
    expect(out.endsWith('(4 earlier lines skipped)')).toBe(true)
    expect(formatBatch('c', [line('x')], 0)).not.toContain('skipped')
  })
})
