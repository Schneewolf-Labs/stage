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
bun run src/index.ts init            # stage.toml from the example; point models_dir and egirl_url at your machine
bun run src/index.ts doctor          # models, voice service, every talent's egirl and tool lockdown

# 1. voice service (creates its venv on first run; Kokoro on the GPU, RVC models in services/voice/models/<name>/)
bun run voice

# 2. stage server
bun run serve --talent springfield

# 3. open the console at http://127.0.0.1:3100/console  (the render page itself is http://127.0.0.1:3100/)
bun run src/index.ts say "Testing, testing. [happy] Is this thing on?"
bun run src/index.ts chat "What are you working on today?"
bun run src/index.ts stop                                    # cut her off mid-sentence
bun run src/index.ts convert take1.wav take1-egirl.wav --rvc egirl --pitch 12   # your own recording, in the character voice
```

In OBS add a **Browser** source with the stage URL, 1920x1080, and it renders with a transparent
background. Any normal browser tab needs one click on the page before audio plays (autoplay
policy); OBS does not.

## Console

`/console` is the operator's view of one talent: a live preview of the actual render page (muted,
same cues), the talent's state, a level meter and latency readouts, and panels for the model
(picker with hot-swap, expressions, every Cubism parameter as a live slider you can pin), the
voice (Kokoro voice, RVC model, pitch, speed, a test line, per-clip latency), the chat (each
turn as a timeline: reasoning, tool calls, sentences lighting up as they are spoken, timing),
Twitch (connection, queue, live lines) and setup (a go-live checklist, OBS URL, talents,
shortcuts, health). Moods and gestures are one click or one key away; Esc stops the talent
mid-sentence.

Also in the console: **Scene** (drag the model in the preview and scroll to scale, saved per
model; idle sway, blink rate, caption size, background colour), **Brain** (the talent's egirl
instance: model, context use, which tools are enabled with the world-acting ones flagged,
thinking level, abort), a **kill switch** that silences the talent instantly, a monitor toggle
to hear the preview, and a server log drawer. Everything the console changes is saved to
`stage.d/<talent>.toml` (gitignored) and wins over `stage.toml` on the next start; delete the
file to reset.

**Director** covers the two ways a talent performs without a human typing: an **auto-prompt**
that runs a standing instruction on a cadence while she is idle (game commentary, chat check-ins;
persisted, with a run-once button), and a **script** reader for narration written ahead
(tutorials, intros): one line per row, cue tags honoured, a pause between lines, stoppable.

**Pictures.** A markdown image or a bare image URL in a reply is not read aloud; it is shown on
the scene's *screen*, a placeable area next to the model, with its alt text as caption. Anything
else can put a picture there with `POST /image`. This is how an image-generating talent shows
her work on stream.

**Mic.** Push-to-talk in the console (hold the button or Space): the browser records, encodes a
16 kHz WAV, and the voice service transcribes it with whisper.cpp. The text is sent as a turn
right away or dropped into the composer to edit. This is the co-host workflow: a human talking
with the talent on stream.

**Lipsync.** The voice service returns a mouth track with every clip: 50 frames a second of
openness (a loudness envelope, normalised per clip, fast attack, short release) and shape (the
spectral tilt: wide for e/i, round for o/u). The page reads it at the audio clock, output
latency compensated, so the mouth is on the syllable rather than trailing a loudness meter.
Clips without a track fall back to the live analyser.

**Presets and hotkeys.** Save the current placement, motion, captions, background and screen as
a named preset and apply it in one click (a chatting layout, a game layout). Bind console keys
to a mood, a gesture, a canned line, a preset, stop, or mute; hotkeys keep working after a click
on the preview. Both are saved to `stage.d`.

Planned and stubbed in the UI: live RVC passthrough of your own voice, clip recording.

### Which workflow needs what

| Use case | Talent setup | In the console |
|---|---|---|
| Just chatting on Twitch | `[talents.x.twitch]`, an egirl with tools off, persona with the cue-tag paragraph | Twitch panel (pause intake, replies), Setup checklist green incl. "tools locked down", background from Scene |
| Playing / reacting to a game | egirl with the screenshot tool on | Director auto-prompt every N seconds; OBS captures game + stage |
| Tutorial screencast | any voice; egirl optional | Director script with the narration; OBS records the app + stage; or voice it and `stage convert` |
| Image generation (nikuniku900) | egirl with an image tool (MCP) that returns URLs; persona includes them as markdown | Scene → Screen placement; pictures appear as she describes them |

## Cue Tags

The persona can steer its body with inline tags, which are stripped before synthesis:
`[happy] [sad] [angry] [surprised] [neutral]` set the expression, `[nod]` nods, `[pose]` toggles
the model's alternate pose. Unknown tags are dropped silently. See [docs/persona.md](docs/persona.md)
for the paragraph to paste into the persona's SOUL.md.

Models that ship `.exp3.json` expression files (in the model folder or an `Exp/` subfolder, the
way VTube Studio finds them) get their moods from those, faded in and out; models without them
get moods from brow, eye, and mouth parameters directly.

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
| POST | `/interrupt` | | stop talking now: cut audio, drop queued clips, abort the egirl turn |
| POST | `/model` | `{model}` | hot-swap the Live2D model (path under models_dir) on every page |
| POST | `/voice` | `{voice?, rvc?, pitch?, speed?}` | live voice settings for the next sentence, saved to stage.d |
| POST | `/transform` | `{x?, y?, scale?}` | place the model on the canvas (fractions of the screen, scale x), saved per model |
| POST | `/scene` | `{motion?, captions?, background?}` | idle motion, caption style, background, saved |
| POST | `/mute` | `{on}` | kill switch: stop now and synthesize nothing until unmuted |
| POST | `/script` | `{lines, gap_ms?}` | read lines in order; `/script/stop` ends it; progress as `script` events |
| POST | `/director` | `{enabled?, interval_s?, prompt?}` | the auto-prompt loop, saved; `/director/run` fires it once |
| POST | `/image` | `{url, caption?, seconds?}` | show a picture on the screen area; `url: null` clears |
| POST | `/twitch` | `{paused?, reply?}` | runtime chat toggles (400 without a twitch table) |
| POST | `/transcribe[?send=1]` | WAV body | speech to text via the voice service; `send=1` runs it as a turn |
| GET/POST | `/presets`, `/presets/apply`, `/presets/delete` | `{name}` | named layout snapshots |
| POST | `/hotkeys`, `/hotkeys/fire` | `{hotkeys}` / `{key}` | console key bindings, saved; fire one by key |
| GET | `/egirl` | | the talent's egirl `/info` and session context, for the Brain panel |
| POST | `/egirl/thinking` | `{level}` | set the session's thinking level (off/low/medium/high) |
| GET | `/models.json` | | every model3.json under models_dir, with icons and expression counts |
| GET | `/talent` | | the running talent's settings and the names of all configured talents |
| GET | `/console` | | the operator console |
| GET | `/health` | | stage + voice service status, plus Twitch connection and queue when configured |
| WS | `/ws` | | what the page listens on |

## Voice Service

`services/voice/` is a small Python HTTP server: Kokoro-82M for the read (~40 ms to first audio
on a GPU), optional RVC for the character's timbre, whisper.cpp for the mic (`WHISPER_MODEL`,
default `base.en`), and a lipsync track computed for every clip. Put an RVC model in
`services/voice/models/<name>/` (one `.pth`, optional `.index`) and name it in the talent's
`rvc =`, with `pitch =` in semitones when the base voice sits in a different range than the
model. `POST /convert` (and `stage convert`) runs a recorded WAV through the same model, for
voiceovers you perform yourself. Measured on an RTX A6000: Kokoro RTF 0.01, RVC RTF ~0.1, a
3.6 s sentence in ~0.4 s end to end.

## Safety

An egirl agent has hands: shell, git, browser, code agent. Anything that lets strangers talk to a
talent (a chat integration, a public `/chat`) is a prompt-injection path into those tools. Point
such talents at an egirl instance with its tools disabled (`[tools]` in egirl.toml) and its own
persona, and keep `stage.toml` bound to `127.0.0.1`.

## Models

Live2D models are licensed per model and are never committed. `[server].models_dir` is served
read-only at `/models/`; a talent's `model` is a path under it to the `model3.json`.

## Layout

```
src/
  index.ts      CLI: init / doctor / serve / say / chat / cue / stop / convert
  doctor.ts     the pre-flight checks behind `stage doctor`
  config.ts     stage.toml -> typed config (no schema library; the shape is small)
  server.ts     Bun.serve: page, models, clips, HTTP API, WebSocket
  egirl.ts      POST /chat stream consumer (SSE frames)
  twitch.ts     Twitch IRC over WebSocket: parse, filter, reconnect, optional reply
  batcher.ts    chat queue -> one egirl turn at a time
  chunker.ts    sentence splitter + cue-tag parser
  performer.ts  egirl events -> voice -> cues
  voice.ts      voice service client
  models.ts     model + .exp3 discovery under models_dir
  persist.ts    stage.d/<talent>.toml overrides (voice, model, placement, scene, director)
  script.ts     reads a list of lines in order
  director.ts   prompts the talent on a cadence while idle
web/            render page (index.html + stage.js), console (console.html/css/js), core.js (pure
                logic shared by both and unit-tested), vendored libs
services/voice/ Kokoro + RVC HTTP service
test/           bun test
```

## Running as services

`services/systemd/` has user units like egirl's: `stage-voice.service` for the voice service and
`stage@.service` for one stage per talent (`systemctl --user enable --now stage@springfield`).

## Development

```bash
bun test && bun run lint && bun run typecheck
```

`test/server.test.ts` boots the real server against a fake voice service and a fake egirl on
ephemeral ports and drives every endpoint and both WebSocket roles; it is the contract the
console is written against. `test/core.test.ts` covers the shared UI logic. Add the test
before the feature.
