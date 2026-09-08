import type { Mood } from './types'

const MOODS: readonly Mood[] = ['neutral', 'happy', 'sad', 'angry', 'surprised']
const GESTURES = ['nod', 'pose'] as const
export type Gesture = (typeof GESTURES)[number]

export interface LineImage {
  url: string
  caption: string
}

export interface Line {
  /** Text to synthesize, cue tags and image markup removed. May be empty. */
  text: string
  moods: Mood[]
  gestures: Gesture[]
  /** Pictures the talent wants shown: markdown images and bare image URLs. */
  images: LineImage[]
}

const MD_IMAGE = /!\[([^\]]*)\]\((\S+?)\)/g
const BARE_IMAGE = /https?:\/\/\S+?\.(?:png|jpe?g|gif|webp|avif)(?=[\s)\]]|$)/gi

/**
 * Pull `[happy]`, `[nod]` style cue tags out of a chunk of text. Tags the persona writes inline
 * are the only channel it has for body language, so unknown tags are dropped silently rather
 * than spoken aloud.
 */
export function parseLine(chunk: string): Line {
  const moods: Mood[] = []
  const gestures: Gesture[] = []
  const images: LineImage[] = []
  const text = chunk
    .replace(MD_IMAGE, (_, alt: string, url: string) => {
      images.push({ url, caption: alt.trim() })
      return ' '
    })
    .replace(BARE_IMAGE, (url: string) => {
      images.push({ url, caption: '' })
      return ' '
    })
    .replace(/\[([a-z]+)\]/gi, (_, tag: string) => {
      const t = tag.toLowerCase()
      if ((MOODS as readonly string[]).includes(t)) moods.push(t as Mood)
      else if ((GESTURES as readonly string[]).includes(t)) gestures.push(t as Gesture)
      return ' '
    })
    .replace(/\s+/g, ' ')
    .trim()
  return { text, moods, gestures, images }
}

/**
 * Turns a token stream into sentences as soon as each one closes, so the first sentence of a
 * reply can be synthesized while the model is still writing the rest.
 *
 * A sentence ends at `.`, `!`, `?` (plus any closing quote/bracket) followed by whitespace, or at
 * a newline. Abbreviations and decimals are not special-cased: a false split costs one extra
 * short clip, a missed split costs latency, and the first is the cheaper mistake on stream.
 */
export class SentenceChunker {
  private buf = ''

  push(token: string): string[] {
    this.buf += token
    const out: string[] = []
    const re = /[.!?]["')\]]*(?=\s)|\n/g
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(this.buf)) !== null) {
      const end = m.index + m[0].length
      const s = this.buf.slice(last, end).trim()
      if (s) out.push(s)
      last = end
    }
    this.buf = this.buf.slice(last)
    return out
  }

  /** Whatever is left when the stream ends. */
  flush(): string | undefined {
    const s = this.buf.trim()
    this.buf = ''
    return s || undefined
  }
}
