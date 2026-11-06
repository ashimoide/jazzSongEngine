# jazz-song-engine.js

This generative jazz engine creates and performs complete songs from a single
JavaScript file.

By providing a few style presets and a seed, it generates everything from tempo
and harmony to melody, bass, and drums. Because nothing is looped, every bar is
performed according to a set plan. This ensures the same seed always produces the
exact same song, allowing you to share a link to replay a specific track.

It is made for radio: it can back a lo-fi jazz radio, a study or focus radio, or
a small ambient station that plays continuously without ever repeating the same
loop. It is live at [KISSATEN RADIO](https://kissaten.pages.dev), a lo-fi jazz
radio that can play continuously.

This lightweight engine operates from a single file without any dependencies, build
steps, presets, or audio files. It includes built-in synthesizer instruments and
supports optional recorded samples.

## Good for

- **Lo-fi jazz radio** — warm, dusty, jazz that keeps playing.
- **Study and focus radio** — steady piano-led beats with a calm, non-distracting
  energy arc for working or reading.

## Capabilities

This engine plans entire songs rather than loops or beats, giving each piece a distinct
arrangement and arc. While you can use presets to explore different styles, it defaults
to a soft jazz trio. Its core vocabulary includes ninth and thirteenth chords, altered
dominants, ii–V–I progressions, a walking bass, and brushwork.

## What it can produce

Each song is planned before it plays:

- **Harmony** — jazz voicings (maj9, m9, 13, 6/9, altered dominants), common
  and reharmonised progressions, ii–V turns, borrowed colours, and a slow
  chromatic or diatonic bass line.
- **Form** — intro, A, B, breaks, A′ and outro, with a few archetypes
  (cyclic, AABA, build, vamp, through-composed, double-break, head-and-solos)
  and an energy arc that opens up and settles back down.
- **Melody** — short motifs that get inverted, retrogressed, stretched and
  answered across phrases, or, on request, a long through-composed piano line.
- **Rhythm section** — comping piano (light offbeats, Charleston, stabs,
  block chords, two-handed), walking or sparse root–fifth bass, and a kit or
  brushes with ride, hi-hat, ghosts and fills.
- **Arrangement** — sections that add and remove instruments, free-time
  intros and outros, a beat-first opening, drum fills, and subtle per-song
  human timing and dynamics.
- **Atmosphere** — exact-length reverb and delay, a dusty chorus on keys and
  lead, vinyl crackle, rain, room tone, hiss, and gentle wow/flutter. The
  beds are always built; a style sets how loud each one sits, so at `0` it is
  inaudible rather than absent. A recorded vinyl loop can be supplied, but
  the engine makes its own if not.
- **Mixing** — separated keys, bass, melody and drum buses, a glue
  compressor, a safety limiter, and a bass/keys balance that avoids mud.

It runs fine with no samples at all. With samples it gets more organic: a
grand piano, Rhodes, upright or electric bass, vibes, flute, guitar and drums.

## Using it

```html
<script src="jazz-song-engine.js"></script>
<script>
  const ctx = new AudioContext();
  const engine = JazzSong.createEngine(ctx, {
    styles: myStyles,          // your style presets, keyed by name
    samples: mySampleBank,     // optional; see "Samples" below
    title: (seed, styleKey) => 'Song ' + seed.toString(36)
  });

  engine.setSeed('midnight');
  engine.loadSamples();
  engine.start('chill');
</script>
```

`engine.start()` returns immediately; audio is scheduled ahead of time, so the
page stays responsive. Useful calls:

| Call | What it does |
| --- | --- |
| `engine.setSeed(value)` | Sets the session seed. `'s:<base36>'` replays that exact song first. |
| `engine.start(styleKey)` / `engine.stop()` | Start or pause the radio. |
| `engine.next()` / `engine.replay()` | Move to a new song, or replay the current one. |
| `engine.setVolume(0..1)` | Output level. |
| `engine.onSong = fn` | Called with the plan for each new song (title, BPM, key, form, instruments). |

### Styles

The caller owns style presets. A style is a plain object with the musical
core the engine needs (tempo, roots, progressions, sections, levels, tone,
space, drums, keys, bass and palette, plus the atmosphere levels).

Some fields are opinionated shorthands rather than independent switches, and
each changes several things at once:

- `lofi` — dusty dynamics and tighter arrangement arcs: quieter gains,
  darker keys, less human timing, shallower reverb, sparser walking bass and
  steadier comping.
- `jazz` — jazz defaults: walking bass, ride, brush kit, trio personalities
  and denser harmony.
- `traits.warm` / `traits.ambient` / `traits.calm` / `traits.bright` —
  nudges toward piano-led, airy, darker or brighter. `traits.calm` overlaps
  `lofi` wherever the engine asks whether a style is calm.
- `spice` — how much altered-dominant bite to keep.
- `vinyl` / `rain` / `texture` / `hiss` / `age` — atmosphere levels. These
  are always read, including when no flag is set.

The engine does not automatically assign a mood like "chill" to a style;
it simply plays the style you provide. You can find the exact structure of a
style object documented at the top of jazz-song-engine.js.
The single-style example above serves as a complete, minimal preset to help
you get started.

### Sharing songs

A song's seed is the only thing needed to rebuild it. `engine.setSeed('s:<base36>')`
takes the numeric song seed already encoded in base 36, which is what the
engine reports as `song.seedString`. 

### Samples

Samples are optional and any recordings you supply are your own to license.
The engine asks the caller for them through a small provider object
(`pick`, `drum`, `vinyl`, `requestBank`, and a few more — the
full list is at the top of the file). Anything missing falls back to a synth
voice, and the engine keeps playing with no samples at all.

## How [kissaten.pages.dev](https://kissaten.pages.dev) uses it

At [KISSATEN RADIO](https://kissaten.pages.dev) the styles are moods. Each mood is a preset passed to
the engine's `styles` option:

- **Chill** — warm, slow, piano-led beats for studying and working.
- **Jazz** — straight-ahead jazz with walking bass and brushes.
- **Rain** — airier and darker, with the rain bed up and a long reverb.
- **Sleepy** — slow pads and soft waltz touches.

The site adds a small UI, a title generator, and a sample bank that decodes
recorded instruments.

## Browser support

Uses standard Web Audio (`AudioContext`, `OfflineAudioContext` for generated
beds). Chrome, Safari, Firefox and Edge all work; a user gesture is required
before audio starts.

## License

MIT **with attribution required**. You can use, modify and ship the engine
freely, but the license text and an attribution link must stay with it:

```
Generative engine: jazz-song-engine.js
https://github.com/ashimoide/jazzSongEngine
```

In a minified bundle, that notice can live in a README, an about page or a
notice file instead of the minified source. See [LICENSE](LICENSE).
