import { describe, expect, test } from 'bun:test'
import { sayAs } from '../src/say-as'

const MAP = {
  Bophades: 'Bo-fay-deez',
  "got 'em": 'got um',
  LoRA: 'lora',
  'LoRA adapter': 'adapter',
}

describe('sayAs', () => {
  test('respells whole words, ignoring case', () => {
    expect(sayAs("I'm Bophades. bophades!", MAP)).toBe("I'm Bo-fay-deez. Bo-fay-deez!")
  })

  test('leaves words that only contain a key alone', () => {
    expect(sayAs('LoRAs and Bophadesque', MAP)).toBe('LoRAs and Bophadesque')
  })

  test('matches keys with punctuation and either apostrophe', () => {
    expect(sayAs("Got 'em! got ’em.", MAP)).toBe('got um! got um.')
  })

  test('prefers the longest key', () => {
    expect(sayAs('a LoRA adapter and a LoRA', MAP)).toBe('a adapter and a lora')
  })

  test('is a no-op without a map', () => {
    expect(sayAs('Bophades', undefined)).toBe('Bophades')
    expect(sayAs('Bophades', {})).toBe('Bophades')
  })
})
