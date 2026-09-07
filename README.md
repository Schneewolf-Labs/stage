<p align="center"><strong>Stage</strong><br>VTuber harness for <a href="https://github.com/Schneewolf-Labs/egirl">egirl</a> agents.</p>

---

## What This Is

Stage puts an egirl agent on screen. It connects to an egirl instance's HTTP API, turns the
streamed reply into speech one sentence at a time, and drives a Live2D model in a browser page
that OBS captures. Reasoning becomes a thinking pose, tool calls become a working pose, inline
cue tags become expressions, and the mouth follows the audio.

A **talent** is one egirl instance + one Live2D model + one voice. Stage runs one talent per
process, the way egirl runs one instance per process.

```
egirl (local LLM)  --SSE-->  stage server  --WebSocket-->  browser page (Live2D)  -->  OBS
                                  |
                                  +--HTTP-->  voice service (Kokoro -> RVC)
```

egirl is untouched: Stage is a client of `POST /chat` and nothing else.

## Quick Start

```bash
bun install
cp stage.example.toml stage.toml     # point models_dir and egirl_url at your machine

# 1. voice service (creates its venv on first run; Kokoro on the GPU, RVC models in services/voice/models/<name>/)
bun run voice

# 2. stage server
bun run serve --talent springfield

# 3. open http://127.0.0.1:3100/  (add ?bg=1 outside OBS to see the background)
bun run src/index.ts say "Testing, testing. [happy] Is this thing on?"
bun run src/index.ts chat "What are you working on today?"
```

In OBS add a **Browser** source with the stage URL, 1920x1080, and it renders with a transparent
background. Any normal browser tab needs one click on the page before audio plays (autoplay
policy); OBS does not.

## Cue Tags

The persona can steer its body with inline tags, which are stripped before synthesis:
`[happy] [sad] [angry] [surprised] [neutral]` set the expression, `[nod]` nods, `[pose]` toggles
the model's alternate pose. Unknown tags are dropped silently. Add one line to the persona's
SOUL.md or AGENTS.md telling it these exist.

## Twitch Chat

Add a `[talents.<name>.twitch]` table (see `stage.example.toml`) and the talent listens to that
channel over Twitch's IRC WebSocket, no extra dependency. Chat is buffered and handed to egirl as
one message every `interval_ms` while the talent is not already speaking; a line containing a
wake word triggers a turn right away. Each turn gets the mentioned lines plus the newest others
up to `max_batch`, and egirl is told how many older lines were skipped. Without `nick` and
`token` Stage reads anonymously; with them and `reply = true` the spoken reply is also posted to
chat, cue tags stripped.

## HTTP API

| Method | Path | Body | Purpose |
|---|---|---|---|
| POST | `/chat` | `{message}` | send to the talent's egirl, perform the reply, return `{reply}` |
| POST | `/say` | `{text}` | speak text directly (cue tags honored), no egirl |
| POST | `/cue` | a cue object | raw cue passthrough, e.g. `{"type":"mood","mood":"sad"}` |
| GET | `/health` | | stage + voice service status, plus Twitch connection and queue when configured |
| WS | `/ws` | | what the page listens on |

## Voice Service

`services/voice/` is a small Python HTTP server: Kokoro-82M for the read (~40 ms to first audio
on a GPU), optional RVC for the character's timbre. Put an RVC model in
`services/voice/models/<name>/` (one `.pth`, optional `.index`) and name it in the talent's
`rvc =`. Measured on an RTX A6000, per sentence: Kokoro RTF 0.01, RVC RTF ~0.11.

## Models

Live2D models are licensed per model and are never committed. `[server].models_dir` is served
read-only at `/models/`; a talent's `model` is a path under it to the `model3.json`.

## Layout

```
src/
  index.ts      CLI: serve / say / chat / cue
  config.ts     stage.toml -> typed config (no schema library; the shape is small)
  server.ts     Bun.serve: page, models, clips, HTTP API, WebSocket
  egirl.ts      POST /chat stream consumer (SSE frames)
  twitch.ts     Twitch IRC over WebSocket: parse, filter, reconnect, optional reply
  batcher.ts    chat queue -> one egirl turn at a time
  chunker.ts    sentence splitter + cue-tag parser
  performer.ts  egirl events -> voice -> cues
  voice.ts      voice service client
web/            the page (index.html + stage.js) and vendored Live2D/Pixi libs
services/voice/ Kokoro + RVC HTTP service
test/           bun test
```

## Development

```bash
bun test && bun run lint && bun run typecheck
```
