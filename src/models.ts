import { type Dirent, existsSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

export interface ExpressionFile {
  name: string
  url: string
}

export interface ModelEntry {
  /** Path under models_dir to the model3.json; what a talent's `model` holds. */
  model: string
  /** Top-level folder under models_dir: how the owner names models, unlike the rigger's file codes. */
  name: string
  /** A png next to the model that looks like an icon, when there is one. */
  icon?: string
  expressions: number
}

/**
 * Expression files next to a model. VTube Studio finds `.exp3.json` by scanning the model's
 * folder (some riggers use an `Exp/` subfolder), and most commissioned model3.json files do not
 * list them, so scan rather than trust FileReferences.Expressions.
 */
export function findExpressions(modelsDir: string, model: string): ExpressionFile[] {
  const dir = dirname(resolve(modelsDir, model))
  const out: ExpressionFile[] = []
  const walk = (d: string, depth: number): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory() && depth < 2) walk(p, depth + 1)
      else if (e.name.endsWith('.exp3.json'))
        out.push({
          name: e.name.replace(/\.exp3\.json$/, ''),
          url: `/models/${relative(modelsDir, p)}`,
        })
    }
  }
  if (existsSync(dir)) walk(dir, 0)
  return out
}

const ICON_RE = /^(icon|ico_.*|.*_icon|preview)\.png$/i

/** Every Live2D model under models_dir, a few levels deep, for the console's model picker. */
export function findModels(modelsDir: string): ModelEntry[] {
  const out: ModelEntry[] = []
  const walk = (d: string, depth: number): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory() && depth < 4 && !e.name.startsWith('.') && e.name !== 'node_modules')
        walk(p, depth + 1)
      else if (e.name.endsWith('.model3.json')) {
        const icon = entries.find((f: Dirent) => f.isFile() && ICON_RE.test(f.name))
        const model = relative(modelsDir, p)
        out.push({
          model,
          name: model.split('/')[0] ?? e.name.replace(/\.model3\.json$/, ''),
          ...(icon ? { icon: `/models/${relative(modelsDir, join(d, icon.name))}` } : {}),
          expressions: findExpressions(modelsDir, model).length,
        })
      }
    }
  }
  walk(modelsDir, 0)
  return out.sort((a, b) => a.model.localeCompare(b.model))
}
