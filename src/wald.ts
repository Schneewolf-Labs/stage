import type { StageConfig, TalentConfig } from './config'

/** What egirl instances register under in Wald; an agent speaking anything else is not one. */
export const EGIRL_PROTOCOL = 'egirl-peer/1'

/** The fields Stage reads from Wald's `GET /agents/{slug}` (AgentOut in Wald's schemas.py). */
interface WaldAgent {
  endpoint_url?: string | null
  protocol?: string
  status?: string
}

/**
 * Ask a Wald registry where the egirl instance registered as `slug` lives. Plain REST, no
 * auth (Wald's REST surface has none), bounded. Throws naming the slug and the reason: the
 * talent has no other address, so a lookup that fails has to say why.
 */
export async function lookupEgirl(waldUrl: string, slug: string): Promise<string> {
  const who = `wald: agent "${slug}"`
  const res = await fetch(`${waldUrl}/agents/${encodeURIComponent(slug)}`, {
    signal: AbortSignal.timeout(5000),
  }).catch((e: Error) => {
    throw new Error(`wald ${waldUrl} unreachable resolving "${slug}": ${e.message}`)
  })
  if (res.status === 404) throw new Error(`${who} is not registered at ${waldUrl}`)
  if (!res.ok) throw new Error(`${who}: ${waldUrl} answered HTTP ${res.status}`)
  const a = (await res.json().catch(() => ({}))) as WaldAgent
  if (a.protocol !== EGIRL_PROTOCOL)
    throw new Error(`${who} speaks "${a.protocol ?? '?'}", not ${EGIRL_PROTOCOL}`)
  if (a.status !== 'active')
    throw new Error(`${who} is ${a.status ?? 'without a status'}, not active`)
  if (!a.endpoint_url) throw new Error(`${who} has no endpoint_url`)
  return a.endpoint_url.replace(/\/+$/, '')
}

/**
 * Fill in a Wald-named talent's egirl_url in place, so every caller holding the talent sees the
 * new address. A talent with a pinned URL is left alone. Returns whether the URL changed.
 */
export async function resolveTalent(cfg: StageConfig, talent: TalentConfig): Promise<boolean> {
  if (!talent.egirl || !cfg.wald) return false
  const url = await lookupEgirl(cfg.wald.url, talent.egirl)
  const changed = url !== talent.egirl_url
  talent.egirl_url = url
  return changed
}
