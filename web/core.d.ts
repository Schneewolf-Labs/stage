import type { Scene, Transform } from '../src/persist'

export interface Sentence { id: string; text: string; status: 'queued' | 'now' | 'done' }
export interface Turn {
  message: string; reasoning: string; tools: { name: string; done: boolean }[]; sentences: Sentence[]
  done: boolean; error: string | null; ms: number | null; t0: number
}
export interface TurnState { turns: Turn[]; speaking: boolean; caption: string; currentClipId: string | null }
export function turnReducer(state: TurnState | undefined, ev: { type: string; [k: string]: unknown }): TurnState
export function clipStats(clips: { genMs: number; seconds: number }[]): { count: number; lastGenMs: number | null; lastSeconds: number | null; avgRtf: number | null }
export function clampTransform(t: Partial<Transform> | undefined | null): Transform
export function fitModel(screen: { w: number; h: number }, model: { w: number; h: number }, t: Transform): { scale: number; x: number; y: number }
export function riskyTools(tools: Record<string, unknown> | undefined | null): string[]
export interface ReadyItem { key: string; label: string; ok: boolean; detail: string }
export function readiness(input: { health: Record<string, unknown> | undefined; egirl: Record<string, unknown> | undefined; modelLoaded?: boolean }): ReadyItem[]
export type { Scene, Transform }
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array
export function downsample(samples: Float32Array, from: number, to: number): Float32Array
export interface MouthTrack { rate: number; frames: [number, number][] }
export function mouthAt(track: MouthTrack | null | undefined, t: number): { open: number; form: number } | null
