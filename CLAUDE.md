# Stage — VTuber harness for egirl agents

## What This Is

Stage renders an egirl agent as a Live2D VTuber. It is a **client** of egirl's HTTP API: it
sends `POST /chat` with `stream: true`, turns the SSE events into speech and body language, and
pushes cues to a browser page over a WebSocket. OBS captures the page. A **talent** is one egirl
instance + one Live2D model + one voice; one talent per `serve` process.

Sister project of [egirl](https://github.com/Schneewolf-Labs/egirl); same conventions, same
palette, same "flat and readable" rule. Read egirl's CLAUDE.md if in doubt.

## The Mental Model

> **egirl thinks, Stage performs.** Stage never calls an LLM. Everything the talent says comes
> out of egirl's stream; Stage only decides *how* it is said and shown.

If you catch yourself adding prompt logic, a persona, or a model call here, stop: that belongs
in egirl's workspace (SOUL.md / AGENTS.md). Stage's only "intelligence" is the sentence
chunker and the cue-tag parser.

## Design Rules

1. **egirl stays untouched.** Extensibility lives at egirl's HTTP boundary. Never add a Stage
   endpoint to egirl; consume what `/chat` already streams.
2. **Latency first.** The first sentence must be speaking before the reply finishes. Synthesize
   per sentence, push clips as they land, play in order on the page.
3. **One talent per process.** No multi-talent routing inside the server. Two talents are two
   processes on two ports (and two OBS sources).
4. **Flat and readable.** Hardcoded cue types, hardcoded engines. No plugin system for voices,
   renderers, or cues. If a second TTS engine is wanted, add a branch in `services/voice/`.
5. **Models are not code.** Live2D models live outside the repo under `[server].models_dir`.

## Tech Stack

| Component | Technology |
|---|---|
| Runtime | Bun, TypeScript (strict) |
| Server | `Bun.serve` with WebSocket, ~200 lines |
| Page | plain JS, PixiJS 7 + pixi-live2d-display 0.5 (lipsync fork) + Cubism Core, vendored in `web/libs` |
| Voice | Python `services/voice/`: Kokoro-82M + rvc-python, plain `http.server` |
| Config | TOML via `smol-toml`, validated by hand in `config.ts` |

Dependencies are deliberately minimal (`smol-toml` only at runtime). Ask before adding one.

## Live2D Gotchas (load-bearing)

- The vendored `index.min.js` bundle needs `live2d.min.js` (Cubism 2 runtime) loaded first, even
  for Cubism 4 models.
- pixi-live2d-display 0.5 does not auto-register the PixiJS ticker; `stage.js` calls
  `model.update(dt)` itself.
- `coreModel.*ParameterValueById` wants CubismId handles; a plain string silently creates a
  phantom parameter. Address parameters by index (see `pidx` in `stage.js`).
- The plugin calls `loadParameters()` at the top of every frame, so drive parameters from the
  `beforeModelUpdate` hook, and drive head/body through `focusController`.
- Hidden browser tabs pause `requestAnimationFrame`; the page keeps a `setInterval` fallback.
- Models without `.exp3` files (e.g. chb119) get moods by setting brow/eye/mouth params directly.

## Voice Service Gotchas

- uv venvs ship without `pkg_resources`; `rvc-python`/fairseq need `setuptools<70`.
- torch>=2.6 `weights_only=True` rejects the official RVC `hubert_base.pt`; `server.py` wraps
  `torch.load` to allow it. Do not "fix" this by downgrading torch.
- One inference lock. A sentence is sub-second; batching would add complexity for nothing.

## Code Style

Same as egirl: `interface` for shapes, no `any`, explicit return types on exports, named exports
only, kebab-case files, one concept per file, ~200 lines per file, early returns, errors thrown
early and caught at the boundary (`server.ts` handlers). Tests in `test/` with `bun:test`.

Verify before calling work done:

```
bun test && bun run lint && bun run typecheck
```

## Don't Be Helpful

No unsolicited refactors, no README additions not asked for, no comments on code you did not
change. Do what was asked. Stop.
