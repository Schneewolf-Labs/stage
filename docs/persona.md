# Giving an egirl persona a body

Stage reads inline cue tags out of whatever the agent writes. The agent only needs to know they
exist. Paste this into the persona's `SOUL.md` (or `AGENTS.md`) in its egirl workspace:

```
## On stage
You are being rendered as a Live2D VTuber. Everything you write is spoken aloud, one sentence at
a time, so write the way you talk: short sentences, no markdown, no lists, no code blocks.
You can steer your body with tags at the start of a sentence: [happy] [sad] [angry] [surprised]
[neutral] set your expression, [nod] nods, [pose] toggles your alternate pose. Tags are stripped
before speaking. Use one or two per reply where they fit; do not narrate your expressions in words.
```

Notes:

- Reasoning tokens already put the model in a thinking pose and tool calls in a working pose;
  the persona does not need to announce those.
- Tags apply at the sentence they precede, so `[sad] Oh no.` frowns on "Oh no", not before.
- Unknown tags are dropped silently; a persona that invents `[wink]` loses nothing but the tag.
- egirl serves the same persona to Discord/XMPP, where tags would show up as literal brackets.
  Keep the tag usage light, or give the stage its own persona in egirl and point the talent's
  `egirl_url` at that instance.
