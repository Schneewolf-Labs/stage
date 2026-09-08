import type { Director } from './persist'
import type { ConsoleEvent } from './types'

export interface DirectorDeps {
  get(): Director
  isBusy(): boolean
  /** Run one turn with the prompt; the director never waits for it. */
  turn(prompt: string): Promise<unknown>
  event(e: ConsoleEvent): void
  log(msg: string): void
}

/**
 * Prompts the talent on a cadence while it is idle. This is how a talent "watches" a game or
 * checks in with chat without a human typing: the prompt is the persona's standing instruction
 * for what to look at. The timer re-arms after every check so a changed interval takes effect
 * on the next tick, and a busy talent is skipped rather than queued behind.
 */
export function startDirector(deps: DirectorDeps): { fire(): void; rearm(): void; stop(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const fire = (): void => {
    const prompt = deps.get().prompt.trim()
    if (!prompt) return
    deps.event({ type: 'director', phase: 'fired' })
    deps.turn(prompt).catch((e) => deps.log(`director turn failed: ${e}`))
  }
  const tick = (): void => {
    const d = deps.get()
    if (d.enabled) {
      if (deps.isBusy()) deps.event({ type: 'director', phase: 'skipped', reason: 'busy' })
      else fire()
    }
    timer = setTimeout(tick, Math.max(50, deps.get().interval_s * 1000))
  }
  const arm = (): void => {
    clearTimeout(timer)
    timer = setTimeout(tick, Math.max(50, deps.get().interval_s * 1000))
  }
  arm()
  // Settings changed: start counting from now with the new interval instead of finishing the old wait.
  return { fire, rearm: arm, stop: () => clearTimeout(timer) }
}
