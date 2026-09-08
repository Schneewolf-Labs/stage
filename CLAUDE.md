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
| Console | `web/console.{html,css,js}`, plain JS, one hand-written design system, no framework |
| Voice | Python `services/voice/`: Kokoro-82M + rvc-python, plain `http.server` |
| Config | TOML via `smol-toml`, validated by hand in `config.ts` |

Dependencies are deliberately minimal (`smol-toml` only at runtime). Ask before adding one.

## Two Kinds of WebSocket Client

A render page and the console share `/ws`. A client is a page until it sends
`{type:'ready', role:'console'}`. Cues go to everyone; `ConsoleEvent`s (turn progress, clips,
chat lines, talent settings) go to consoles only. The console's preview is a real render page in
an iframe (`?mute=1&status=0&caption=0`), which is also where it reads parameter ranges and live
values from: same origin, no extra protocol. "Now speaking" comes from a page's `playing` report,
never from the `speak` cue, which only means "queued".

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
- Reading a Cubism parameter between frames returns the *saved* value (often 0), not what was
  drawn: `loadParameters()` runs at the top of every update. Measure inside the update hook, or
  read the page's own variables (`window.stage.level`), never `getParameterValueByIndex` from
  outside for verification.
- Lipsync is the clip's mouth track at the audio clock (`mouthAt`), not the analyser; the analyser
  is the fallback. Do not "improve" it by smoothing the analyser harder.

## Voice Service Gotchas

- uv venvs ship without `pkg_resources`; `rvc-python`/fairseq need `setuptools<70`.
- torch>=2.6 `weights_only=True` rejects the official RVC `hubert_base.pt`; `server.py` wraps
  `torch.load` to allow it. Do not "fix" this by downgrading torch.
- One inference lock. A sentence is sub-second; batching would add complexity for nothing.

## Tests Come First

Server behaviour is specified in `test/server.test.ts` (real server, fake voice + egirl on
port 0, WebSocket clients with roles) and UI logic in `test/core.test.ts` over `web/core.js`.
A new endpoint, cue or event gets its test written first, run red, then implemented. DOM code
in `console.js`/`stage.js` stays thin; anything with a decision in it goes in `core.js` where
it can be tested.

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
