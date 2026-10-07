---
openclaw:
  requires:
    bins: ["curl"]
  emoji: "🎤"
---

# Stage

Drive a VTuber talent on a running Stage server: make her say lines, change her mood, show a picture, read a script, or stop her.

## When to Use

Activate when asked to make a talent (Bophades, Springfield, ...) say something on stream, react, show an image, read prepared lines, or go quiet.

## Where she is

Each talent is its own Stage server. Bophades is `http://127.0.0.1:3103`; the default port is 3100. `curl -s $URL/talent` names the running talent; check it before you speak through it.

## Speaking

- Your exact words, no AI in between: `POST /say {"text": "..."}`.
- Let the talent answer in her own voice (her egirl thinks of the reply): `POST /chat {"message": "..."}`. Returns `{reply}` after she finished.
- Prefer `/say` when you wrote the line; `/chat` when you want her personality.

```
curl -s -X POST $URL/say -H 'content-type: application/json' -d '{"text":"[happy] Hi chat. Got '"'"'em!"}'
```

Lines are spoken one sentence at a time, so write the way people talk: short sentences, no markdown, no lists, no emoji, no all-caps words (the voice spells them out), no chat abbreviations.

## Body language

Put a tag at the start of a sentence: `[happy] [sad] [angry] [surprised] [neutral]` set the mood, `[nod]` nods, `[pose]` toggles her alternate pose. Tags are not spoken. Or send one directly: `POST /cue {"type":"mood","mood":"surprised"}`.

## Pictures

`POST /image {"url": "https://...", "caption": "...", "seconds": 8}` shows it beside her; `{"url": null}` clears. A markdown image inside a `/say` line does the same.

## Scripts

`POST /script {"lines": ["first line", "[happy] second line"], "gap_ms": 400}` reads them in order. `POST /script/stop` ends it.

## Stopping

- `POST /interrupt`: stop talking now, drop what is queued.
- `POST /mute {"on": true}`: kill switch, nothing is spoken until `{"on": false}`.

Check results: every call returns JSON with `ok`; a 4xx carries `error`. `GET /health` reports Stage and the voice service.
