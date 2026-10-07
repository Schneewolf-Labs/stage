---
openclaw:
  requires:
    bins: ["bun", "ffmpeg"]
  emoji: "🎬"
---

# Stage Video

Turn a script into an mp4 of a VTuber talent reading it, for YouTube tutorials and shorts.

## When to Use

Activate when asked to make a video, short, intro, or tutorial voiced by a talent (for example "make a Bophades video explaining Merlina").

## Steps

1. **Learn the subject first.** Read the docs or code of what the video teaches. Every claim in the script must be something you checked; say "as far as I can tell" where you could not.
2. **Write the script** to a `.txt` file, one spoken line per line, in the talent's voice:
   - short spoken sentences; one idea per line
   - a mood tag at the start of most lines: `[happy] [sad] [angry] [surprised] [neutral] [nod] [pose]`
   - no markdown, emoji, all-caps words or chat abbreviations: everything is read aloud
   - a hook in the first line, a one-line recap at the end
   - names and terms written normally; the talent's `say_as` table in stage.toml fixes pronunciation
3. **Render it** from the Stage repo (`~/Projects/stage`). The voice service must be running; a Stage server does not need to be.

```
cd ~/Projects/stage
bun run src/index.ts render script.txt out.mp4 --talent bophades                       # vertical short, 1080x1920
bun run src/index.ts render script.txt out.mp4 --talent bophades --width 1920 --height 1080 --bg '#00ff00'   # landscape, green screen for compositing
```

   `--gap-ms` sets the pause between lines (default 250), `--caption-size` the caption size.
4. **Check it** before calling it done: `ffprobe out.mp4` for duration and streams, and report the length and path. For a tutorial, say which screen recording it should be composited over; the talent does not record the screen.

To voice a recording a human made instead: `bun run src/index.ts convert take.wav out.wav --rvc reviewed-609` (add `--pitch N` semitones if the speaker is much lower than the voice).
