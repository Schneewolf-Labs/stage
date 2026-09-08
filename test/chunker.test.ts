import { describe, expect, test } from 'bun:test'
import { parseLine, SentenceChunker } from '../src/chunker'

describe('SentenceChunker', () => {
  test('emits a sentence as soon as it closes, keeps the tail', () => {
    const c = new SentenceChunker()
    expect(c.push('Okay, chat. ')).toEqual(['Okay, chat.'])
    expect(c.push("Here's the situation")).toEqual([])
    expect(c.push('! I am')).toEqual(["Here's the situation!"])
    expect(c.flush()).toBe('I am')
    expect(c.flush()).toBeUndefined()
  })

  test('splits on newlines and closing quotes', () => {
    const c = new SentenceChunker()
    expect(c.push('She said "no way!" Then left.\nNext line')).toEqual([
      'She said "no way!"',
      'Then left.',
    ])
    expect(c.flush()).toBe('Next line')
  })

  test('does not split mid-number', () => {
    const c = new SentenceChunker()
    expect(c.push('It costs 3.50 dollars. ')).toEqual(['It costs 3.50 dollars.'])
  })
})

describe('parseLine', () => {
  test('strips known cue tags and reports them', () => {
    const l = parseLine('[happy] Rolling! [nod] Oh no.')
    expect(l.text).toBe('Rolling! Oh no.')
    expect(l.moods).toEqual(['happy'])
    expect(l.gestures).toEqual(['nod'])
  })

  test('drops unknown tags silently', () => {
    expect(parseLine('[wink] hi').text).toBe('hi')
  })

  test('tag-only chunk yields empty text', () => {
    expect(parseLine('[sad]').text).toBe('')
  })
})

describe('parseLine images', () => {
  test('markdown images are pulled out of the spoken text', () => {
    const l = parseLine('Here you go! ![a cat](http://x/cat.png) [happy] Cute, right?')
    expect(l.text).toBe('Here you go! Cute, right?')
    expect(l.images).toEqual([{ url: 'http://x/cat.png', caption: 'a cat' }])
    expect(l.moods).toEqual(['happy'])
  })
  test('bare image urls count too, other urls are left alone', () => {
    const l = parseLine('see https://x/y/z.webp and https://x/page')
    expect(l.images).toEqual([{ url: 'https://x/y/z.webp', caption: '' }])
    expect(l.text).toBe('see and https://x/page')
  })
  test('no images gives an empty list', () => {
    expect(parseLine('plain').images).toEqual([])
  })
})
