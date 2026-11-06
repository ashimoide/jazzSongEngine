/*
 * jazz-song-engine.js
 * -------------------
 * A seeded generative song engine for the Web Audio API, leaning jazz.
 *
 * Call this file "the engine"; the page or app that loads it is the caller.
 * Given a set of style presets and a seed, the engine writes whole songs by
 * itself and plays them live: tempo, key, chord progression, form, an
 * arrangement that builds and breathes, a motif-based melody (or a
 * through-composed piano line), comping piano, walking or root-fifth bass,
 * brushes or a stick kit, and a dusty mix on top. Nothing is looped back:
 * every bar is performed from the plan, so the same seed always builds the
 * same song.
 *
 * What it is and is not:
 *   - It is a whole-song planner, not a beat or loop generator. One call is
 *     one arrangement with sections and an arc.
 *   - Its default vocabulary is jazz (ninth and thirteenth chords, altered
 *     dominants, ii-V turns, walking bass, ride and brushes). The style layer
 *     only reads the preset it is handed, but where a preset says nothing the
 *     fallback is a soft jazz trio, not a blank slate.
 *   - It has no UI, no audio files and no recorded content of its own.
 *     Samples are optional and supplied by the caller.
 *
 * The usual shape of a caller:
 *
 *     const engine = JazzSong.createEngine(ctx, {
 *       styles,                 // caller-owned style presets, keyed by name
 *       samples,                // optional sample provider (contract below)
 *       instrumentSpecs,        // display names and synth fallback voices
 *       instrumentChains,       // which recorded instrument to try first
 *       title,                  // optional (seed, styleKey, style) => string
 *       isHidden,               // optional () => boolean for background tabs
 *       mixKey, mixPool, ...    // optional "mix" mode settings
 *     });
 *
 *     engine.setSeed('midnight');     // or 's:<base36>' to replay one song
 *     engine.loadSamples();
 *     engine.start(styleKey);         // returns at once; audio schedules ahead
 *     engine.onSong = (song) => { ... };  // title, BPM, key, form, instruments
 *
 * WHAT A STYLE IS (caller-owned; the musical core is the only requirement)
 *   A style is a plain object. The engine reads bpm, swing, roots,
 *   progressions, sections, levels, tone, space, drums, keys, bass, palette,
 *   comping, walking, rubato, beatFirst, pianoBanks, arpInst, guitarChance,
 *   wanderPiano, wanderLead, jazzLite, backbeat, evolve, chorus,
 *   pianoLayer, targetSec and age.
 *
 *   Atmosphere is read from the same object as levels, not chosen by the
 *   engine: vinyl, rain, texture (room tone), hiss and age (wow/flutter)
 *   set how loud each bed sits, and evolve lets them drift across a song.
 *   The beds exist in every graph; a level of 0 makes one inaudible, not
 *   absent.
 *
 *   Several flags are opinionated shorthands that change many things at
 *   once, not independent knobs:
 *     lofi             dusty dynamics and tighter arrangement arcs: quieter
 *                      gains, darker keys, less human timing, shallower
 *                      reverb, sparser bass walking, steadier comping
 *     jazz             jazz defaults: walking bass, ride, brush kit, trio
 *                      personalities, denser harmony
 *     traits.warm      more piano-led, dreamier keys
 *     traits.ambient   airy mix, longer reverb, mid-bar re-voices
 *     traits.calm      darker keys, quieter jazz-lite passages; overlaps
 *                      `lofi` wherever the engine asks "is this calm?"
 *     traits.bright    brighter keys more often
 *     spice            0..1, how much altered-dominant bite stays in
 *     melodyRhythms    this style's motif rhythm bank
 *     melodyPlans      bar -> phrase code maps for the melody
 *     wanderRhythms    long through-composed phrase shapes
 *
 *   The caller names styles; the engine plays the key it is given. A few
 *   planning cues are still named after one caller's moods (rainLift,
 *   airyRain, sleepyJazz); treat them as internal, not as API.
 *
 *   A "mix" style is the caller's shorthand for "pick one from mixPool each
 *   song". A seed of 's:<base36>' makes the first song exact, so a caller can
 *   share a link that replays one particular song.
 *
 * THE SAMPLE PROVIDER (optional; every instrument has a synth fallback)
 *   ready                         Promise that settles when loading ends
 *   status                        optional 'loading' | 'ready' | 'unavailable'
 *   isReady()                     boolean
 *   has(name)                     boolean
 *   pick(name, midi)              { buffer, layers?, takes? } | null
 *   pickChain(names, midi)        same, first available in the list
 *   drum(name)                    AudioBuffer | AudioBuffer[] | null
 *   drumVariant(name)             { buffer } | null
 *   trimFor(name)                 number (per-instrument level trim)
 *   requestBank(name)             Promise (lazy piano packs)
 *   vinyl()                       AudioBuffer | null (a recorded surface loop)
 *   onVinyl(fn)                   register a callback for a late vinyl loop
 *
 *   Useful sample names if the caller has recordings: pianoNatural, piano,
 *   ep, ebass, ubass, vibes, guitar, flute; kick, snare, hat, ride,
 *   brushRide, brushHat, brushHatOpen, shaker, rim, tomHi, tomLo, crash.
 *   Brushed drum feels take the brush cymbals automatically. With no samples
 *   at all the engine still plays, using its synthesised instruments.
 *
 * License: MIT with attribution required.
 *
 *     Generative engine: jazz-song-engine.js
 *     https://github.com/ashimoide/jazzSongEngine
 *
 *   See LICENSE and README.md for the full terms.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.JazzSong = api;
  /* Deprecated: the engine was published as LofiJazz. Kept so existing pages
     keep working; new code should use JazzSong. */
  if (!root.LofiJazz) root.LofiJazz = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
'use strict';
function hashSeed(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let _rng = Math.random;
const rand = (a, b) => a + _rng() * (b - a);
const randInt = (a, b) => Math.floor(a + _rng() * (b - a + 1));
const pick = (arr) => arr[(_rng() * arr.length) | 0];
const chance = (p) => _rng() < p;
const mod12 = (n) => ((n % 12) + 12) % 12;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/* The shared seed stays base 36 in the URL; the caller can render it any
   way it likes (katakana, a short id, a timestamp...). */

function weightedPick(items, weights) {
  let total = 0;
  for (let i = 0; i < items.length; i++) total += weights[i];
  let r = _rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/* Pick a dominant colour, making the 7b9 bite rarer in calmer styles. */
function pickDom(options, spice) {
  if (spice === undefined || spice >= 1 || options.indexOf('7b9') === -1) return pick(options);
  const p = 0.05 + 0.32 * spice;
  if (chance(p)) return '7b9';
  return pick(options.filter((o) => o !== '7b9'));
}

/* ============================================================
   harmony
   ============================================================ */
const CHORDS = {
  m7:    [0, 3, 7, 10],
  m9:    [0, 3, 7, 10, 14],
  m11:   [0, 3, 7, 10, 14, 17],
  m6:    [0, 3, 7, 9],
  m7b5:  [0, 3, 6, 10],
  maj7:  [0, 4, 7, 11],
  maj9:  [0, 4, 7, 11, 14],
  '6/9': [0, 4, 7, 9, 14],
  dom7:  [0, 4, 7, 10],
  dom9:  [0, 4, 7, 10, 14],
  dom13: [0, 4, 7, 10, 14, 21],
  sus4:  [0, 5, 7, 10],
  sus2:  [0, 2, 7, 10],
  dim7:  [0, 3, 6, 9]
};
CHORDS['7'] = CHORDS.dom7;
CHORDS['9'] = CHORDS.dom9;
CHORDS['13'] = CHORDS.dom13;
CHORDS['7sus4'] = CHORDS.sus4;
CHORDS['7b9'] = [0, 4, 7, 10, 13];

const SCALES = {
  minor:  [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  major:  [0, 2, 4, 5, 7, 9, 11],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11]
};

const SCALE_NAMES = {
  minor: 'minor',
  dorian: 'dorian',
  major: 'major',
  lydian: 'lydian',
  mixolydian: 'mixolydian',
  harmonicMinor: 'harmonic minor'
};

/* borrowed colors from the parallel major/minor — used sparingly */
const BORROWED_COLORS = [
  [8, 'maj9'],
  [10, '9'],
  [3, 'maj9'],
  [5, 'm9']
];

/* How much close-interval / altered-dominant bite a style keeps.
   Styles own this value; 1 means no filtering. */
const spiceFor = (style) => {
  const s = style && style.spice;
  return s === undefined ? 1 : s;
};

/* Calm styles keep their lofi dynamics and tighter arrangement arcs. The
   caller marks them with `lofi` or `traits.calm`. */
const isCalm = (style) => !!(style && (style.lofi || (style.traits && style.traits.calm)));

/* warm mid-register voicings that move by the smallest distance.
   A rootless option keeps the piano out of the bass's way and opens the
   upper structure, which suits the jazzier presets. */
function buildVoicing(rootPc, type, prev, spice, rootless) {
  const ivs = CHORDS[type] || CHORDS.m7;
  let pcs = ivs.map((iv) => mod12(rootPc + iv));
  if (rootless) {
    const withoutRoot = pcs.filter((pc) => pc !== mod12(rootPc));
    if (withoutRoot.length >= 3) pcs = withoutRoot;
  }
  const base = 52 + mod12(rootPc - 52);
  const notes = [];
  for (const pc of pcs) {
    let n = base + mod12(pc - base);
    if (notes.length && n <= notes[notes.length - 1]) n += 12;
    notes.push(n);
  }
  const candidates = [];
  for (let k = 0; k < notes.length; k++) {
    candidates.push(notes.map((n, i) => (i < k ? n + 12 : n)).sort((a, b) => a - b));
  }
  candidates.push(notes.map((n) => n - 12));
  candidates.push(notes);

  /* Calmer styles sometimes reject the semitone clusters outright. */
  const allowClusters = spice === undefined || spice >= 1 || chance(spice);
  let best = notes;
  let bestScore = Infinity;
  let safe = null;
  let safeScore = Infinity;
  for (const c of candidates) {
    const avg = c.reduce((s, n) => s + n, 0) / c.length;
    let score = Math.abs(avg - 61) * 0.5;
    if (prev && prev.length) {
      const n = Math.min(c.length, prev.length);
      let d = 0;
      for (let i = 0; i < n; i++) d += Math.abs(c[i] - prev[i]);
      score += (d / n) * 1.2;
    }
    score += Math.max(0, c[c.length - 1] - c[0] - 17) * 0.6;
    if (score < bestScore) { bestScore = score; best = c; }
    let cluster = false;
    for (let i = 1; i < c.length; i++) if (c[i] - c[i - 1] === 1) { cluster = true; break; }
    if (!cluster && score < safeScore) { safeScore = score; safe = c; }
  }
  return allowClusters || !safe ? best : safe;
}

function chordThird(type) {
  const ivs = CHORDS[type] || CHORDS.m7;
  if (ivs.indexOf(4) !== -1) return 4;
  if (ivs.indexOf(3) !== -1) return 3;
  return 5;
}

/* Nearest scale tone in one direction; used for diatonic bass approaches. */
function scaleNeighbor(midi, pcs, dir) {
  for (let d = 1; d <= 4; d++) {
    const m = midi + dir * d;
    if (pcs.indexOf(mod12(m)) !== -1) return m;
  }
  return midi + dir * 2;
}

/* A walking-bass approach into `target`. The direction follows the line, so
   an ascending phrase approaches from below and a descending one from above.
   It never repeats the previous note. */
function bassApproach(target, from, pcs, style) {
  const dir = from <= target ? -1 : 1;
  let note;
  if (style === 'chromatic') note = target + dir;
  else if (style === 'diatonic') note = scaleNeighbor(target, pcs, dir);
  else note = chance(0.6) ? scaleNeighbor(target, pcs, dir) : target + dir;
  if (note === from) {
    const alt = style === 'chromatic' ? target - dir : scaleNeighbor(target, pcs, -dir);
    note = alt !== from ? alt : target + dir * 2;
  }
  return note;
}

/* Chord interval folded into a comfortable bass register. */
function bassChordTone(rootMidi, iv) {
  let m = rootMidi + iv;
  if (m - rootMidi > 7) m -= 12;
  return m;
}

/* ============================================================
   sampled instruments
   ============================================================ */

/* Velocity used to compare the perceived level of bank variants. */
const REF_VEL = 0.55;

const TEXTURE_DRIFT = {
  rain: 0.32, vinyl: 0.28, room: 0.45, hiss: 0.35, wow: 0.40, rainLp: 0.16, roomLp: 0.18
};

/* A coherent set of correlated trio feels used when the caller does not
   supply its own. This is not a style preset: any caller can override it. */
const DEFAULT_TRIO_PERSONALITIES = [
  {
    id: 'lyrical',
    w: 35,
    comps: ['light', 'charleston', 'rolled'],
    wander: 1,
    rubato: 0.7,
    drumScale: 0.72,
    swing: 0.06
  },
  {
    id: 'swinging',
    w: 30,
    comps: ['charleston', 'stabs', 'blockChords'],
    wander: 0.15,
    rubato: 0.12,
    drumScale: 1,
    swing: -0.04
  },
  {
    id: 'modal',
    w: 20,
    comps: ['light', 'blockChords'],
    wander: 0.9,
    rubato: 0.85,
    drumScale: 0.55,
    swing: 0.02
  },
  {
    id: 'groove',
    w: 15,
    comps: ['blockChords', 'twoHand'],
    wander: 0.1,
    rubato: 0.2,
    drumScale: 1.15,
    swing: -0.06
  }
];

function saturationCurve(amount) {
  const n = 1024;
  const curve = new Float32Array(n);
  const k = 1 + amount * 6;
  const t = 0.55;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    const a = Math.abs(x);
    let y;
    if (a <= t) y = a;
    else y = t + (1 - t) * Math.tanh(((a - t) / (1 - t)) * k);
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

/* soft odd-harmonic saturation for the dream pad */
function dreamCurve() {
  const n = 1024;
  const curve = new Float32Array(n);
  const drive = 2.8;
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = Math.tanh(x * drive) / norm;
  }
  return curve;
}

/* final safety net: transparent below 0.9, softly bounded above it */
function safetyCurve() {
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    const a = Math.abs(x);
    const y = a <= 0.9 ? a : 0.9 + 0.098 * Math.tanh((a - 0.9) / 0.098);
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

function makeImpulse(ctx, seconds, decay) {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * 0.6;
    }
    for (let r = 0; r < 4; r++) {
      const idx = Math.floor(rate * (0.011 + r * 0.019 + Math.random() * 0.008));
      if (idx < len) d[idx] += (Math.random() < 0.5 ? -1 : 1) * 0.35 * Math.pow(1 - idx / len, 1.5);
    }
  }
  return buf;
}

function makeNoise(ctx, seconds) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(1, len, rate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/* quiet brown-noise room bed */
function makeRoomTone(ctx, seconds) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(1, len, rate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.018 * white) / 1.018;
    d[i] = last * 3.2;
  }
  return buf;
}

/* Vinyl surface: a barely-there noise floor with a few dust ticks per
   second, crossfade-looped. The recorded loops sit on top of it. */
function makeVinylFloor(ctx, seconds) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const xfade = Math.min(Math.floor(rate * 0.8), len >> 2);
  const warmup = Math.floor(rate * 0.75);
  const buf = ctx.createBuffer(1, len, rate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0;
  const next = () => {
    const white = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.0990460;
    b1 = 0.96300 * b1 + white * 0.2965164;
    b2 = 0.57000 * b2 + white * 1.0526913;
    return (b0 + b1 + b2 + white * 0.1848) * 0.22;
  };
  /* let the pink filter settle before recording so the loop head is stationary */
  for (let i = 0; i < warmup; i++) next();
  const raw = new Float32Array(len + xfade);
  for (let i = 0; i < raw.length; i++) raw[i] = next() * 0.003;
  /* fold the tail into the head with equal-power weights, as in makeRain */
  for (let i = 0; i < xfade; i++) {
    const w = (i / xfade) * Math.PI / 2;
    d[i] = raw[len + i] * Math.cos(w) + raw[i] * Math.sin(w);
  }
  for (let i = xfade; i < len; i++) d[i] = raw[i];
  /* a couple of tiny dust ticks a second; keep them away from the loop seam */
  const ticks = Math.round(seconds * 1.5);
  const edge = Math.floor(rate * 0.012);
  for (let p = 0; p < ticks; p++) {
    const at = edge + ((Math.random() * (len - edge * 2)) | 0);
    const amp = Math.pow(Math.random(), 2) * 0.018;
    const width = randInt(1, 3);
    for (let i = 0; i < width && at + i < len - edge; i++) {
      d[at + i] += amp * (i === 0 ? 1 : -1) * (1 - i / width);
    }
  }
  return buf;
}

/* soft pink-noise rain bed — stereo, and crossfade-looped so the seam is inaudible */
function makeRain(ctx, seconds) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const xfade = Math.min(Math.floor(rate * 0.8), len >> 2);
  const warmup = Math.floor(rate * 0.75);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let b0 = 0, b1 = 0, b2 = 0;
    const next = () => {
      const white = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + white * 0.0990460;
      b1 = 0.96300 * b1 + white * 0.2965164;
      b2 = 0.57000 * b2 + white * 1.0526913;
      return (b0 + b1 + b2 + white * 0.1848) * 0.22;
    };
    /* let the filter settle before recording so the head is stationary */
    for (let i = 0; i < warmup; i++) next();
    const raw = new Float32Array(len + xfade);
    let peak = 0;
    for (let i = 0; i < raw.length; i++) {
      const v = next();
      raw[i] = v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    /* fold the tail into the head with equal-power weights: two uncorrelated
       noise streams keep a constant RMS through the fade, so the loop never
       audibly dips */
    for (let i = 0; i < xfade; i++) {
      const w = (i / xfade) * Math.PI / 2;
      d[i] = raw[len + i] * Math.cos(w) + raw[i] * Math.sin(w);
    }
    for (let i = xfade; i < len; i++) d[i] = raw[i];
    if (peak > 0) {
      const g = 0.66 / peak;
      for (let i = 0; i < len; i++) d[i] *= g;
    }
  }
  return buf;
}

/* ============================================================
   melodic composition — motifs, not random walks
   ============================================================ */

/* Neutral fallback cells. Hosts usually supply their own bank per style. */
const DEFAULT_MELODY_RHYTHMS = [
  [[0, 3], [4, 3], [8, 4], [12, 4]],
  [[0, 4], [6, 2], [8, 2], [12, 4]],
  [[0, 2], [3, 3], [6, 2], [10, 4], [14, 2]],
  [[2, 2], [4, 3], [8, 3], [12, 4]],
  [[0, 6], [6, 2], [10, 4], [14, 2]],
  [[0, 4], [5, 2], [8, 4], [13, 3]],
  [[0, 3], [6, 3], [10, 2], [12, 4]],
  [[0, 8], [8, 8]],
  [[0, 12], [12, 4]],
  [[0, 4], [6, 4], [12, 4]],
  [[2, 3], [8, 6], [14, 2]],
  [[0, 6], [8, 6]],
  [[0, 3], [6, 5], [12, 4]]
];

/* Long, asymmetric phrases for piano-led songs: fewer downbeat starts,
   more suspensions and notes that carry over the bar line. */
const DEFAULT_WANDER_RHYTHMS = [
  [[0, 4], [5, 2], [8, 3], [12, 4]],
  [[0, 3], [3, 2], [6, 4], [11, 2], [14, 2]],
  [[2, 3], [5, 2], [8, 5], [13, 3]],
  [[0, 5], [6, 2], [9, 3], [13, 4]],
  [[0, 2], [3, 2], [7, 3], [10, 2], [13, 3]],
  [[0, 4], [6, 4], [10, 2], [13, 4]],
  [[0, 6], [7, 2], [10, 3], [13, 3]],
  [[3, 2], [6, 3], [9, 2], [12, 4]],
  /* long-tone cells: two or three notes with air between them */
  [[0, 6], [8, 5]],
  [[2, 4], [9, 6]]
];

const MOTIF_CONTOURS = [
  [0, 1, 2, 1, 0, -1],
  [0, -1, 0, 2, 1, 0],
  [0, 2, 3, 2, 0, -1],
  [0, 1, 0, -2, -1, 0],
  [0, -2, -1, 1, 2, 0],
  [0, 3, 2, 1, -1, -2],
  [0, 1, 3, 2, 0, -2],
  [0, -1, -2, 0, 1, 2],
  [0, 2, 1, -1, -2, 0],
  [0, 4, 3, 2, 1, 0],
  [0, 1, 1, 0, -1, -1],
  [0, -1, -1, 0, 1, 1],
  [0, 1, 0, 1, 1, 0],
  [0, 2, 1, 0, -1, 0],
  [0, -2, -1, 0, 1, 0]
];

/* Deterministic extra contours so adjacent songs have more shapes to
   choose from without leaving the seeded stream. */
function generatedContour(seed) {
  const r = mulberry32(seed);
  const out = [0];
  let dir = 0;
  let run = 0;
  for (let i = 1; i < 6; i++) {
    let step = Math.floor(r() * 5) - 2;
    if (step === dir) {
      run++;
      if (run >= 2) step = step === 0 ? 1 : -step;
    } else {
      run = 0;
    }
    dir = step;
    out.push(clamp(out[out.length - 1] + step, -4, 4));
  }
  return out;
}

const MOTIF_CONTOURS_ALL = MOTIF_CONTOURS.concat(
  [0, 1, 2, 3].map((i) => generatedContour(0xC0FFEE + i * 7919))
);

const DEFAULT_MELODY_PLANS = {
  dense:  [0, 0.5, null, 1, null, 0.5, 1, null],
  full:   [0, null, 0.5, null, 1, null, 0.5, null],
  medium: [0, null, null, 1, null, null, 0.5, null],
  sparse: [0, null, null, null, 1, null, null, null]
};

/* Motif variants: inversion, retrograde, rhythm scaling, lift/drop. */
function shapeMotif(motif, op) {
  const rhythm = motif.rhythm.map((r) => r.slice());
  let contour = motif.contour.slice();

  if (op === 'invert') {
    contour = contour.map((d) => -d);
  } else if (op === 'lift' || op === 'answer') {
    contour = contour.map((d) => d + 2);
  } else if (op === 'drop') {
    contour = contour.map((d) => d - 2);
  } else if (op === 'retro') {
    contour.reverse();
    const mirrored = rhythm.map((r) => [clamp(16 - r[0] - r[1], 0, 15), r[1]]);
    return { rhythm: mirrored.sort((a, b) => a[0] - b[0]), contour };
  } else if (op === 'augment') {
    const stretched = rhythm
      .map((r) => [Math.round(r[0] * 1.5), Math.max(1, Math.round(r[1] * 1.5))])
      .filter((r) => r[0] < 16);
    return { rhythm: stretched.sort((a, b) => a[0] - b[0]), contour };
  } else if (op === 'diminish') {
    const squeezed = rhythm
      .map((r) => [Math.round(r[0] * 0.5), Math.max(1, Math.round(r[1] * 0.5))]);
    return { rhythm: squeezed.sort((a, b) => a[0] - b[0]), contour };
  }
  return { rhythm, contour };
}

function motifVariants(motif) {
  const variants = { prime: motif };
  for (const op of ['invert', 'retro', 'augment', 'diminish', 'lift', 'drop', 'answer']) {
    const v = shapeMotif(motif, op);
    if (v.rhythm.length >= 2) variants[op] = v;
  }
  return variants;
}

function makeMotifPair(rhythms, avoid) {
  const bank = rhythms || DEFAULT_MELODY_RHYTHMS;
  const contours = MOTIF_CONTOURS_ALL;
  const avoidSet = new Set(avoid || []);

  let pairs = [];
  for (let ri = 0; ri < rhythms.length; ri++) {
    for (let ci = 0; ci < contours.length; ci++) {
      if (!avoidSet.has(ri + ':' + ci)) pairs.push([ri, ci]);
    }
  }
  if (pairs.length < 2) {
    pairs = [];
    for (let ri = 0; ri < rhythms.length; ri++) {
      for (let ci = 0; ci < contours.length; ci++) pairs.push([ri, ci]);
    }
  }

  const a = pairs[(_rng() * pairs.length) | 0];
  let b = pairs[(_rng() * pairs.length) | 0];
  let guard = 0;
  while (b[0] === a[0] && b[1] === a[1] && pairs.length > 1 && guard++ < 50) {
    b = pairs[(_rng() * pairs.length) | 0];
  }

  const build = (rhythm, contour, ri, ci) => {
    const m = { rhythm: rhythm.map((x) => x.slice()), contour: contour.slice() };
    m.varContour = contour.map((d) => d + 2);
    m.fingerprint = ri + ':' + ci;
    m.variants = motifVariants(m);
    return m;
  };
  return [build(rhythms[a[0]], contours[a[1]], a[0], a[1]), build(rhythms[b[0]], contours[b[1]], b[0], b[1])];
}

function snapToChord(midi, chordPcs, maxDist) {
  const max = maxDist === undefined ? 2 : maxDist;
  for (let d = 0; d <= max; d++) {
    for (const dir of [0, 1, -1]) {
      if (d === 0 && dir !== 0) continue;
      const m = midi + dir * d;
      if (chordPcs.indexOf(mod12(m)) !== -1) return m;
    }
  }
  return midi;
}

/* Add a small pickup or ghost to a drum lane. */
function varyDrumPattern(pattern, kind) {
  if (!pattern || !chance(0.38)) return pattern;
  const at = kind === 'kick'
    ? pick([6, 7, 11, 15])
    : kind === 'snare'
      ? pick([7, 15])
      : pick([1, 3, 5, 7, 9, 11, 13, 15]);
  if (pattern[at] !== '.') return pattern;
  const chars = pattern.split('');
  chars[at] = kind === 'kick' ? 'x' : 'o';
  return chars.join('');
}

/* ============================================================
   song planner — form, energy arc, harmony, motif family
   ============================================================ */
const HARMONY_SUBS = {
  m7: ['m9', 'm11'], m9: ['m11', 'm7'], m11: ['m9'],
  maj7: ['maj9', '6/9'], maj9: ['6/9', 'maj7'],
  '6/9': ['maj9'], '7': ['9', '13'], '9': ['13', '7b9'],
  '13': ['9', '7b9'], '7b9': ['13'], '7sus4': ['9'],
  m7b5: ['dim7'], dim7: ['m7b5']
};

function sectionArchetype(mood, kind) {
  return mood.sections.find((s) => s.kind === kind);
}

const FORM_ARCHETYPES = [
  { id: 'cyclic', w: 3, roles: ['intro', 'a', 'b', 'a', 'b', 'break', 'a2', 'outro'] },
  { id: 'aaba', w: 2, roles: ['intro', 'a', 'a', 'b', 'a2', 'outro'] },
  { id: 'build', w: 2, roles: ['intro', 'a', 'a', 'b', 'b', 'a2', 'outro'] },
  { id: 'vamp', w: 1, roles: ['intro', 'a', 'b', 'a2', 'outro'] },
  { id: 'through', w: 1, roles: ['intro', 'a', 'b', 'c', 'a2', 'outro'] },
  { id: 'doubleBreak', w: 1, roles: ['intro', 'a', 'b', 'break', 'a', 'break', 'a2', 'outro'] },
  { id: 'headSolos', w: 1, jazz: true, roles: ['intro', 'a', 'solo', 'b', 'break', 'a2', 'outro'] }
];

const SECTION_BAR_OPTIONS = {
  intro: [2, 4, 6, 8],
  a: [8, 12, 16],
  b: [8, 12],
  c: [8, 12],
  break: [2, 4, 8],
  a2: [8, 12],
  outro: [4, 6, 8, 10],
  solo: [8, 16]
};

const ARC_SHAPES = {
  arch: [0.35, 0.62, 0.85, 1, 0.78, 0.52],
  wave: [0.4, 0.8, 0.55, 0.92, 0.6, 0.45],
  rising: [0.3, 0.45, 0.6, 0.75, 0.9, 0.7],
  late: [0.4, 0.5, 0.62, 0.8, 1, 0.66],
  flat: [0.6, 0.62, 0.58, 0.64, 0.6, 0.55]
};

function arcValue(shape, i, n) {
  if (n <= 1) return shape[Math.floor(shape.length / 2)];
  const p = (i / (n - 1)) * (shape.length - 1);
  const k = Math.floor(p);
  const f = p - k;
  const a = shape[k];
  const b = shape[Math.min(shape.length - 1, k + 1)];
  return a + (b - a) * f;
}

function sectionArchetypeFor(mood, kind) {
  const intro = sectionArchetype(mood, 'intro') || mood.sections[0];
  const a = sectionArchetype(mood, 'a') || mood.sections[1] || intro;
  const b = sectionArchetype(mood, 'b') || mood.sections[2] || a;
  const brk = sectionArchetype(mood, 'break') || a;
  const a2 = sectionArchetype(mood, 'a2') || a;

  if (kind === 'outro') {
    return Object.assign({}, intro, {
      kind: 'outro',
      energy: clamp((intro.energy || 0.2) * 0.9, 0.05, 0.3),
      drums: Math.min(intro.drums || 0, 0.16),
      bass: Math.min(1, Math.max(0.55, intro.bass || 0.6)),
      melody: Math.min(intro.melody || 0.3, 0.32),
      arp: Math.min(intro.arp || 0.2, 0.18),
      perc: 0,
      bright: (intro.bright || 1) * 0.95,
      wet: (intro.wet || 1) * 1.08
    });
  }
  if (kind === 'c') {
    return Object.assign({}, b, {
      kind: 'c',
      energy: clamp((b.energy || 0.5) - 0.12, 0.05, 1),
      arp: clamp((b.arp || 0) + 0.1, 0, 1),
      pad: clamp((b.pad || 0) + 0.2, 0, 1),
      melody: clamp((b.melody || 0) * 0.8, 0, 1)
    });
  }
  if (kind === 'solo') {
    return Object.assign({}, a, {
      kind: 'solo',
      energy: clamp((a.energy || 0.5) + 0.08, 0.05, 1),
      pad: Math.min(a.pad || 0, 0.2)
    });
  }
  if (kind === 'intro') return intro;
  if (kind === 'a') return a;
  if (kind === 'b') return b;
  if (kind === 'break') return brk;
  if (kind === 'a2') return a2;
  return a;
}

function formSectionLabel(kind, seen) {
  const n = (seen[kind] = (seen[kind] || 0) + 1);
  if (kind === 'intro') return 'Intro';
  if (kind === 'outro') return 'Outro';
  if (kind === 'break') return 'Break';
  if (kind === 'solo') return 'Solo';
  if (kind === 'a2') return 'A′';
  const letter = kind === 'a' ? 'A' : kind === 'b' ? 'B' : 'C';
  return letter + (n > 1 ? String(n) : '');
}

function formMinBars(form) {
  return form.roles.reduce((sum, kind) => sum + (SECTION_BAR_OPTIONS[kind] || [8])[0], 0);
}

function reconcileFormBars(sections, targetBars) {
  let total = sections.reduce((s, x) => s + x.bars, 0);

  /* Pick the option change that moves the total closest to the target,
     so section lengths stay musical instead of accumulating odd chunks. */
  for (let iter = 0; iter < 40; iter++) {
    const currentDist = Math.abs(total - targetBars);
    if (currentDist <= 2) break;
    let best = null;
    for (const sec of sections) {
      const opts = sec.barOptions || SECTION_BAR_OPTIONS[sec.kind] || [sec.bars];
      for (const bars of opts) {
        if (bars === sec.bars) continue;
        const nextTotal = total - sec.bars + bars;
        const dist = Math.abs(nextTotal - targetBars);
        if (dist < currentDist && (!best || dist < best.dist)) {
          best = { sec, bars, total: nextTotal, dist };
        }
      }
    }
    if (!best) break;
    total = best.total;
    best.sec.bars = best.bars;
  }
  return total;
}

/* Build the form and its energy arc for a target song length. When `rubato`
   is set the intro/outro are kept long enough for a free-time opening. */
function planForm(mood, bpm, rubato) {
  const calm = isCalm(mood);
  const targetSec = mood.targetSec || 150;
  const barSec = 240 / bpm;
  const targetBars = clamp(Math.round(targetSec / barSec), 40, 120);
  const pool = FORM_ARCHETYPES.filter(
    (f) => (!f.jazz || mood.jazz) && formMinBars(f) <= targetBars + 4
  );
  const form = weightedPick(pool, pool.map((f) => f.w));
  const shapeKey = pick(Object.keys(ARC_SHAPES));
  const shape = ARC_SHAPES[shapeKey];
  const seen = {};

  const sections = form.roles.map((kind) => {
    const arche = sectionArchetypeFor(mood, kind);
    const baseOpts = SECTION_BAR_OPTIONS[kind] || [8];
    const isRubato = !!(rubato && (kind === 'intro' || kind === 'outro'));
    const opts = isRubato ? baseOpts.filter((b) => b >= 4) : baseOpts;
    const usable = opts.length ? opts : baseOpts;
    return Object.assign({}, arche, {
      kind,
      name: formSectionLabel(kind, seen),
      bars: pick(usable),
      barOptions: usable,
      rubato: isRubato,
      orderOffset: randInt(0, 3),
      registerOffset: pick([0, 0, -5, 5])
    });
  });

  reconcileFormBars(sections, targetBars);

  const n = sections.length;
  for (let i = 0; i < n; i++) {
    const sec = sections[i];
    const base = sec.energy === undefined ? 0.5 : sec.energy;
    const baseDrums = sec.drums || 0;
    let e = base + (arcValue(shape, i, n) - 0.5) * (calm ? 0.16 : 0.3);
    if (calm) e = clamp(e, Math.max(0.04, base - 0.12), Math.min(1, base + 0.12));
    sec.energy = clamp(e, 0.04, 1);
    if (calm) sec.drums = Math.min(sec.drums || 0, baseDrums);
  }

  const hookSec = sections.slice().reverse().find((s) => s.kind === 'a2');
  if (hookSec) {
    hookSec.hook = true;
    hookSec.energy = clamp(hookSec.energy + 0.04, 0.04, 1);
  }

  let start = 0;
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    sec.start = start;
    sec.end = start + sec.bars;
    sec.idx = i;
    start += sec.bars;
  }
  for (let i = 0; i < sections.length; i++) {
    const next = sections[i + 1];
    sections[i].transition = next ? next.energy - sections[i].energy : 0;
  }
  sections.formId = form.id;
  sections.arcShape = shapeKey;
  return sections;
}

const DEGREE_CHORDS = {
  minor: { 0: ['m9', 'm11', 'm7'], 2: ['m7b5'], 3: ['maj9', 'maj7'], 5: ['m9', 'm11'], 7: ['m9', '7'], 8: ['maj9', 'maj7'], 10: ['9', '13', 'maj9'] },
  dorian: { 0: ['m9', 'm11'], 2: ['m7', 'm9'], 3: ['maj9', 'maj7'], 5: ['9', '13', 'maj9'], 7: ['m9', 'm7'], 9: ['m7b5'], 10: ['maj9', '9'] },
  major: { 0: ['maj9', '6/9', 'maj7'], 2: ['m9', 'm7'], 4: ['m9', 'm7'], 5: ['maj9', 'maj7'], 7: ['9', '13', '7b9'], 9: ['m9', 'm7'], 11: ['m7b5', 'dim7'] },
  lydian: { 0: ['maj9', 'maj7'], 2: ['9', '13'], 4: ['m9'], 6: ['m7b5'], 7: ['maj9', '9'], 9: ['m9'], 11: ['m7b5'] },
  mixolydian: { 0: ['9', '13', '7sus4'], 2: ['m9', 'm7'], 4: ['m7b5'], 5: ['maj9'], 7: ['m9', 'm7'], 9: ['m9'], 10: ['maj9', 'maj7'] },
  harmonicMinor: { 0: ['m9', 'm11'], 2: ['m7b5'], 3: ['maj7', 'maj9'], 5: ['m9'], 7: ['7', '13'], 8: ['maj9'], 11: ['dim7'] }
};

/* borrowed colours from the parallel modes — used sparingly */
const MODAL_COLORS = {
  minor: [[5, 'maj9'], [1, 'maj9'], [10, '9'], [7, '7'], [2, 'maj9']],
  dorian: [[3, 'maj9'], [7, '7'], [5, 'm9'], [10, 'maj9']],
  major: [[5, 'm9'], [8, 'maj9'], [10, '9'], [3, 'maj9']],
  lydian: [[2, 'm9'], [10, 'maj9']],
  mixolydian: [[0, 'maj9'], [2, 'm9'], [5, 'm9']],
  harmonicMinor: [[7, '7'], [5, 'maj9']]
};

const CADENCE_STYLES = [['v7', 5], ['tritone', 2], ['backdoor', 2], ['iiV', 3]];

function generateCycle(scale, len, calm, gentle) {
  const map = DEGREE_CHORDS[scale] || DEGREE_CHORDS.minor;
  const options = (d) => {
    let opts = map[d];
    if (gentle) {
      let soft = opts.filter((t) => t !== '7b9' && t !== 'dim7');
      if (calm) soft = soft.filter((t) => t !== 'm7b5');
      if (soft.length) opts = soft;
    }
    return opts;
  };
  const degrees = Object.keys(map).map(Number).filter((d) => {
    if (gentle && d === 11) return false;
    if (calm && options(d).every((t) => t === 'm7b5')) return false;
    return true;
  });
  const weights = degrees.map((d) => (d === 0 ? 3 : d === 5 ? 2.4 : d === 7 ? 2 : d === 10 ? 1.8 : 1));
  const color = (d) => pick(options(d));
  const out = [];
  let prev = null;
  for (let i = 0; i < len; i++) {
    if (i === len - 1) {
      out.push([0, color(0)]);
      continue;
    }
    if (i === len - 2 && map[7] && chance(calm ? 0.3 : 0.8)) {
      out.push([7, color(7)]);
      continue;
    }
    let d = weightedPick(degrees, weights);
    if (d === prev) {
      const alt = degrees.filter((x) => x !== d);
      if (alt.length) d = alt[(_rng() * alt.length) | 0];
    }
    out.push([d, color(d)]);
    prev = d;
  }
  return out;
}

function sectionScaleFor(songScale, kind, calm, mood) {
  if (kind !== 'b' && kind !== 'c' && kind !== 'solo') return songScale;
  if (calm) return songScale === 'minor' ? 'dorian' : songScale;
  /* The lyrical jazz presets keep their contrasting sections close to the
     home mode, and only occasionally move to a bright parallel colour. */
  if (mood && mood.jazz) {
    if (chance(0.42)) return songScale;
    const modes = {
      minor: ['dorian', 'major'],
      dorian: ['minor', 'major'],
      major: ['lydian', 'mixolydian', 'major'],
      lydian: ['major'],
      mixolydian: ['major'],
      harmonicMinor: ['minor']
    };
    return pick(modes[songScale] || [songScale]);
  }
  const modes = {
    minor: ['dorian', 'harmonicMinor'],
    dorian: ['minor', 'mixolydian'],
    major: ['lydian', 'mixolydian'],
    lydian: ['major'],
    mixolydian: ['major'],
    harmonicMinor: ['minor']
  };
  return pick(modes[songScale] || [songScale]);
}

/* One chord per bar with substitutions and cadences into the next section. */
function planHarmony(sections, totalBars, prog, mood) {
  const calm = isCalm(mood);
  const spice = spiceFor(mood);
  const h = mood.harmony || {};
  const scale = prog.scale;
  const template = prog.chords;
  const genCycleChance = h.generatedCycle !== undefined ? h.generatedCycle : 0.6;
  const templateShare = h.templateShare !== undefined ? h.templateShare : 0.85;
  const len = chance(genCycleChance) ? pick([4, 8]) : Math.max(4, template.length);
  let cycle = len === template.length && chance(templateShare)
    ? template
    : generateCycle(scale, len, calm, calm || !!mood.jazz);
  if (!cycle.length) cycle = template;

  const secondaryChance = h.secondary !== undefined ? h.secondary : (mood.jazz ? 0.2 : calm ? 0.05 : 0.09);
  const borrowChance = h.borrow !== undefined ? h.borrow : (mood.jazz ? 0.1 : calm ? 0.03 : 0.06);
  const substitutionChance = h.substitutions !== undefined ? h.substitutions : (calm ? 0.3 : 0.42);
  const cadenceChance = h.cadence !== undefined ? h.cadence : 0.75;
  const cadencePool = h.cadences || CADENCE_STYLES;

  const chords = new Array(totalBars);
  for (const sec of sections) {
    const span = sec.end - sec.start;
    const offset = sec.orderOffset || 0;
    const secScale = sectionScaleFor(scale, sec.kind, calm, mood);
    sec.scale = secScale;

    for (let i = 0; i < span; i++) {
      const src = cycle[(i + offset) % cycle.length];
      let deg = src[0];
      let type = src[1];

      if (i >= cycle.length && chance(substitutionChance)) {
        let subs = HARMONY_SUBS[type];
        if (subs && spice < 0.6) {
          subs = subs.filter((s) => s !== '7b9' && s !== 'dim7' && s !== 'm7b5');
        }
        if (subs && subs.length) type = pick(subs);
      }

      const interior = i > 0 && i < span - 1 &&
        sec.kind !== 'intro' && sec.kind !== 'break' && sec.kind !== 'outro';
      if (interior) {
        const nextDeg = cycle[(i + 1 + offset) % cycle.length][0];
        if (chance(secondaryChance)) {
          deg = mod12(nextDeg + 7);
          type = pickDom(['9', '13', '7b9'], spice);
        } else if (chance(borrowChance)) {
          let colors = MODAL_COLORS[secScale] || BORROWED_COLORS;
          if (calm) {
            colors = colors.filter((c) => c[0] !== 1 && c[1] !== 'dim7' && c[1] !== 'm7b5');
          }
          if (colors.length) {
            const c = pick(colors);
            deg = c[0];
            type = c[1];
          }
        }
      }

      const cadential = i === span - 1 &&
        sec.kind !== 'intro' && sec.kind !== 'break' && sec.kind !== 'outro';
      if (cadential) {
        if (chance(cadenceChance)) {
          const nextSec = sections[sec.idx + 1];
          const nextOffset = nextSec ? (nextSec.orderOffset || 0) : 0;
          const target = cycle[nextOffset % cycle.length][0];
          const style = weightedPick(cadencePool.map((c) => c[0]), cadencePool.map((c) => c[1]));
          if (style === 'iiV' && span >= 3) {
            chords[sec.start + i - 1] = [mod12(target + 2), 'm9'];
            deg = mod12(target + 7);
            type = pickDom(['13', '7b9'], spice);
          } else if (style === 'tritone') {
            deg = mod12(target + 1);
            type = pickDom(['13', '7b9'], spice);
          } else if (style === 'backdoor') {
            deg = mod12(target + 10);
            type = pick(['9', '13']);
          } else {
            deg = mod12(target + 7);
            type = pickDom(['13', '7b9'], spice);
          }
        }
      } else if (i === span - 2 && interior && chance(calm ? 0.12 : 0.4)) {
        let colors = MODAL_COLORS[secScale] || [];
        if (calm) colors = colors.filter((c) => c[0] !== 1 && c[1] !== 'dim7' && c[1] !== 'm7b5');
        if (colors.length) {
          const c = pick(colors);
          deg = c[0];
          type = c[1];
        }
      }

      chords[sec.start + i] = [deg, type];
    }
  }
  return chords;
}

const ARR_CURVES = {
  rise: [0.35, 0.6, 0.85, 1],
  fall: [1, 0.82, 0.55, 0.35],
  arch: [0.5, 0.88, 1, 0.65],
  wave: [0.6, 1, 0.5, 0.9],
  late: [0.4, 0.55, 0.8, 1],
  flat: [0.8, 0.8, 0.8, 0.8]
};

function curveAt(shape, i, n) {
  if (n <= 1) return shape[shape.length - 1];
  const p = (i / (n - 1)) * (shape.length - 1);
  const k = Math.floor(p);
  const f = p - k;
  const a = shape[k];
  const b = shape[Math.min(shape.length - 1, k + 1)];
  return a + (b - a) * f;
}

/* Per-bar layer map. Phrase lengths vary per section (2–8 bars), layers
   enter progressively, and pad/melody follow a continuous swell curve
   instead of the old fixed four-bar duck/return. */
function planArrangement(sections, mood) {
  const calm = isCalm(mood);

  for (const sec of sections) {
    const span = Math.max(1, sec.end - sec.start);
    const beatFirst = sec.beatFirst || null;
    const phraseLen = pick(calm ? [4, 4, 6, 8] : [2, 3, 4, 4, 6, 8]);
    const phase = randInt(0, phraseLen - 1);
    const shapeKey = pick(calm ? ['arch', 'flat', 'rise'] : ['arch', 'wave', 'rise', 'fall', 'late']);
    const shape = ARR_CURVES[shapeKey];

    const entry = {
      drums: sec.drums > 0.05 ? randInt(0, Math.min(2, span - 1)) : 0,
      melody: randInt(0, Math.min(4, span - 1)),
      arp: randInt(0, Math.min(2, span - 1)),
      perc: randInt(Math.min(2, span - 1), Math.min(6, Math.max(2, span - 1)))
    };

    const boundaries = [];
    for (let i = phraseLen - 1; i < span - 1; i += phraseLen) boundaries.push(i);
    const dropAt = [];
    const drops = calm ? (chance(0.5) ? 1 : 0) : randInt(0, 2);
    for (let d = 0; d < drops; d++) {
      if (boundaries.length) dropAt.push(boundaries[(_rng() * boundaries.length) | 0]);
      else if (span > 2) dropAt.push(span - 2);
    }

    const fillEvery = phraseLen >= 4 ? phraseLen : 4;
    const fills = [];
    for (let i = fillEvery - 1; i < span; i += fillEvery) fills.push(i);
    fills.push(span - 1);
    sec.fills = [...new Set(fills)].filter((i) => i >= 0 && i < span).sort((a, b) => a - b);
    sec.phraseLen = phraseLen;
    sec.arrCurve = shapeKey;

    sec.arrange = [];
    for (let i = 0; i < span; i++) {
      const a = { drums: 1, hat: 1, keys: 1, bass: 1, melody: 1, arp: 1, perc: 1, pad: 1, padSwell: 1, swell: 1 };
      if (i < entry.drums) a.drums = 0;
      if (i < entry.melody) a.melody = 0;
      if (i < entry.arp) a.arp = 0;
      if (i < entry.perc) a.perc = 0;

      /* Drums-first intro: the kit carries the first bar or two alone, then
         the band comes in together on the next bar line. */
      if (beatFirst && i < beatFirst.bars) {
        a.keys = 0;
        a.bass = 0;
        a.melody = 0;
        a.arp = 0;
        a.perc = 0;
        a.pad = 0;
      }

      const curve = curveAt(shape, i, span);
      a.padSwell = 0.6 + curve * 0.4;
      a.swell = 0.78 + curve * 0.22;
      a.pad *= 0.75 + curve * 0.25;
      a.keys *= 0.82 + curve * 0.18;
      a.melody *= 0.82 + curve * 0.18;

      const phrase = Math.floor(i / phraseLen);
      if (sec.perc > 0.08) a.perc *= (phrase + phase) % 2 === 0 ? 1 : (calm ? 0.45 : 0.2);
      if (sec.arp > 0.08) a.arp *= (phrase + phase) % 2 === 0 ? 1 : (calm ? 0.55 : 0.3);

      if (dropAt.indexOf(i) !== -1) {
        if (sec.kind === 'a' || sec.kind === 'solo' || sec.kind === 'break' || sec.kind === 'outro') {
          a.drums = 0;
        } else if (sec.kind === 'b' || sec.kind === 'c') {
          a.hat *= 0.2;
        }
        if (calm) {
          a.keys = Math.max(a.keys, 0.5);
          a.bass = Math.max(a.bass, 0.75);
        }
      }
      if (sec.kind === 'a' && !sec.hook && i > 0 && i < span - 1 && chance(calm ? 0.08 : 0.18)) {
        a.keys *= 0.4;
      }
      if (sec.kind === 'outro') {
        const t = i / Math.max(1, span - 1);
        a.drums *= 1 - t;
        a.arp *= 1 - t * 0.7;
        a.padSwell *= 1 - t * 0.35;
      }
      if (span > 4 && i === span - 2 && chance(calm ? 0.18 : 0.32)) a.bass = 0.0001;

      if (a.drums === 0) {
        a.padSwell = Math.max(a.padSwell, 1.15);
        a.pad *= 1.2;
        a.melody = Math.min(1.3, a.melody + 0.1);
      }
      sec.arrange.push(a);
    }
    /* The intro archetype has no drums by default; only now let the planned
       drums-first opening make them audible. */
    if (beatFirst) sec.drums = beatFirst.drums;
  }
}

/* ============================================================
   engine
   ============================================================ */

/* A no-op provider so the engine works with synth instruments only. */
class NullSampleBank {
  constructor() {
    this.ready = Promise.resolve(false);
    this.status = 'unavailable';
    this._vinylSink = null;
  }
  isReady() { return false; }
  has() { return false; }
  pick() { return null; }
  pickChain() { return null; }
  drum() { return null; }
  drumVariant() { return null; }
  trimFor() { return 1; }
  requestBank() { return Promise.resolve(false); }
  vinyl() { return null; }
  onVinyl(fn) { this._vinylSink = fn; }
  static brushCymbal(name) {
    if (name === 'ride') return 'brushRide';
    if (name === 'hat') return 'brushHat';
    if (name === 'hatOpen') return 'brushHatOpen';
    return null;
  }
}

const brushCymbal = NullSampleBank.brushCymbal;

class SongEngine {
  constructor(ctx, config) {
    const cfg = config || {};
    this.config = cfg;
    this.ctx = ctx;
    this.styles = cfg.styles || {};
    this.moodKey = cfg.defaultStyle || Object.keys(this.styles)[0] || 'style';
    this.defaultStyle = this.moodKey;
    this.mixKey = cfg.mixKey || null;
    this.pendingMood = null;
    this.mixQueue = [];
    this.playing = false;
    this.timer = null;
    this.ticker = null;
    this.songStartTime = undefined;
    this.onSong = null;
    this.onStep = null;
    this.onBeat = null;
    this.onBar = null;
    this.onSection = null;
    this.onState = null;
    this.volume = cfg.volume === undefined ? 0.8 : cfg.volume;
    this.song = null;
    this.songStep = 0;
    this.nextTime = 0;
    this.prevVoicing = null;
    this.lastMelody = 76;
    this.lastMelodyBar = -99;
    this.cur = null;
    this.melodyEvents = [];
    this.melodySteps = null;
    this.arpEvents = [];
    this.rubatoEvents = null;
    this.bassEvents = null;
    this.baseSeed = (Math.random() * 0xFFFFFFFF) >>> 0;
    this.directSeed = false;
    this.songIndex = 0;
    this.levels = null;
    this.stepDur = 0.2;
    this.visibleLookahead = cfg.lookahead === undefined ? 0.3 : cfg.lookahead;
    this.hiddenLookahead = cfg.hiddenLookahead === undefined ? 10 : cfg.hiddenLookahead;
    this.maxHiddenLookahead = cfg.maxHiddenLookahead === undefined ? 30 : cfg.maxHiddenLookahead;
    this.lookahead = this.visibleLookahead;
    this.isHidden = typeof cfg.isHidden === 'function' ? cfg.isHidden : () => false;
    this.debug = !!cfg.debug;
    this.instrumentSpecs = cfg.instrumentSpecs || {};
    this.instrumentChains = cfg.instrumentChains || {};
    this.pianoPacks = cfg.pianoPacks || [];
    this.epPacks = cfg.epPacks || [];
    this.epBank = cfg.epBank || null;
    this.bankOverride = cfg.bankOverride || null;
    this.mixPool = cfg.mixPool || [];
    this.mixOrder = cfg.mixOrder || [];
    this.mixOpening = cfg.mixOpening || null;
    this.melodyPlans = cfg.melodyPlans || DEFAULT_MELODY_PLANS;
    this.wanderRhythms = cfg.wanderRhythms || DEFAULT_WANDER_RHYTHMS;
    this.defaultMelodyRhythms = DEFAULT_MELODY_RHYTHMS;
    this.trioPersonalities = cfg.trioPersonalities || DEFAULT_TRIO_PERSONALITIES;
    this.vinylRecordGain = cfg.vinylRecordGain === undefined ? 0.2 : cfg.vinylRecordGain;
    this._titleTemplate = cfg.title || null;
    this.onSong = cfg.onSong || null;
    this.onStep = cfg.onStep || null;
    this.onBeat = cfg.onBeat || null;
    this.onBar = cfg.onBar || null;
    this.onSection = cfg.onSection || null;
    this.onState = cfg.onState || null;
    this.voices = new Set();
    this.motifMemory = [];
    this.registerMemory = null;
    this.lastPianoBank = null;
    this._sampleSerial = 0;
    this._waveCache = {};
    this._capture = null;
    this._retired = [];
    this._tailUntil = 0;
    this.samples = cfg.samples || new NullSampleBank();
    this._buildGraph();
    this._trackNodes();
    /* If the OS or browser interrupts the context (device change, app nap,
       background suspension), bring it back as soon as it reports the change
       instead of waiting for the tab to become visible again. */
    if (this.ctx.addEventListener) {
      this.ctx.addEventListener('statechange', () => {
        if (this.playing && this.ctx.state !== 'running') {
          try {
            const resumed = this.ctx.resume();
            if (resumed && typeof resumed.catch === 'function') resumed.catch(() => {});
          } catch (err) {}
        }
      });
    }
    this.samples.ready.then(() => this._initVinyl());
  }

  loadSamples() { return this.samples.ready; }

  /* ---------- audio graph ---------- */
  _buildGraph() {
    const ac = this.ctx;

    this.masterIn = ac.createGain();
    this.masterIn.gain.value = 1;

    this.tape = ac.createDelay(0.2);
    this.tape.delayTime.value = 0.02;
    const wow = ac.createOscillator();
    wow.frequency.value = 0.33;
    const wowAmt = ac.createGain();
    wowAmt.gain.value = 0.0011;
    this.wowAmt = wowAmt;
    wow.connect(wowAmt).connect(this.tape.delayTime);
    wow.start();
    const flutter = ac.createOscillator();
    flutter.frequency.value = 5.3;
    const flutterAmt = ac.createGain();
    flutterAmt.gain.value = 0.00005;
    this.flutterAmt = flutterAmt;
    flutter.connect(flutterAmt).connect(this.tape.delayTime);
    flutter.start();

    this.sat = ac.createWaveShaper();
    this.sat.curve = saturationCurve(0.14);
    this.sat.oversample = '2x';

    this.tone = ac.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 8800;
    this.tone.Q.value = 0.4;

    this.hp = ac.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 28;

    this.masterIn.connect(this.tape).connect(this.sat).connect(this.tone).connect(this.hp);

    this.dry = ac.createGain();
    this.dry.gain.value = 0.92;
    this.wet = ac.createGain();
    this.wet.gain.value = 0.3;
    this.conv = ac.createConvolver();
    this.conv.buffer = makeImpulse(ac, 2.9, 2.4);
    this.hp.connect(this.dry);
    this.hp.connect(this.conv);
    this.wetLp = ac.createBiquadFilter();
    this.wetLp.type = 'lowpass';
    this.wetLp.frequency.value = 4200;
    this.conv.connect(this.wetLp);
    this.wetLp.connect(this.wet);

    this.comp = ac.createDynamicsCompressor();
    this.comp.threshold.value = -20;
    this.comp.knee.value = 18;
    this.comp.ratio.value = 2.2;
    this.comp.attack.value = 0.02;
    this.comp.release.value = 0.3;
    this.dry.connect(this.comp);
    this.wet.connect(this.comp);

    /* The mix was sitting a few dB below the limiter ceiling. A fixed drive
       into the limiter raises every layer together without moving that
       ceiling: the limiter still catches the peaks, and the safety curve
       after the volume control still catches anything that slips past it. */
    this.masterDrive = ac.createGain();
    this.masterDrive.gain.value = 1.4;
    this.comp.connect(this.masterDrive);

    /* brick-wall-ish safety limiter: output can never clip */
    this.limiter = ac.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.07;
    this.masterDrive.connect(this.limiter);

    this.master = ac.createGain();
    this.master.gain.value = 0;
    this.safety = ac.createWaveShaper();
    this.safety.curve = safetyCurve();
    this.safety.oversample = '2x';
    this.limiter.connect(this.master);
    this.master.connect(this.safety).connect(ac.destination);

    /* everything harmonic goes through one bus so the kick can duck it */
    this.musicDuck = ac.createGain();
    this.musicDuck.gain.value = 1;
    this.musicDuck.connect(this.masterIn);

    const bus = (v, dest) => {
      const g = ac.createGain();
      g.gain.value = v;
      g.connect(dest || this.musicDuck);
      return g;
    };
    this.keysBus = bus(0.46);
    this.bassBus = bus(0.50);
    this.padBus = bus(0.30);
    this.drumBus = bus(0.72, this.masterIn);
    this.melBus = bus(0.40);
    this.arpBus = bus(0.18);
    this.percBus = bus(0.55, this.drumBus);

    this.keysTone = ac.createBiquadFilter();
    this.keysTone.type = 'lowpass';
    this.keysTone.frequency.value = 2800;
    this.keysTone.Q.value = 0.3;
    this.chorusKeys = this._makeChorus(this.keysBus);
    this.keysTone.connect(this.chorusKeys.input);

    this.melTone = ac.createBiquadFilter();
    this.melTone.type = 'lowpass';
    this.melTone.frequency.value = 5200;
    this.melTone.Q.value = 0.3;
    this.chorusMel = this._makeChorus(this.melBus);
    this.melTone.connect(this.chorusMel.input);

    this.arpTone = ac.createBiquadFilter();
    this.arpTone.type = 'lowpass';
    this.arpTone.frequency.value = 3600;
    this.arpTone.Q.value = 0.3;
    this.arpTone.connect(this.arpBus);

    this.bassTone = ac.createBiquadFilter();
    this.bassTone.type = 'lowpass';
    this.bassTone.frequency.value = 1500;
    this.bassTone.Q.value = 0.2;
    this.bassTone.connect(this.bassBus);

    /* dedicated sub path: low-passed so the extra weight stays clean */
    this.subGain = ac.createGain();
    this.subGain.gain.value = 0.55;
    this.subGain.connect(this.musicDuck);
    this.subTone = ac.createBiquadFilter();
    this.subTone.type = 'lowpass';
    this.subTone.frequency.value = 120;
    this.subTone.Q.value = 0.25;
    this.subTone.connect(this.subGain);

    /* dotted-eighth echo */
    this.delay = ac.createDelay(2);
    this.delay.delayTime.value = 0.6;
    this.delayFb = ac.createGain();
    this.delayFb.gain.value = 0.24;
    this.delayLp = ac.createBiquadFilter();
    this.delayLp.type = 'lowpass';
    this.delayLp.frequency.value = 2100;
    this.delaySend = ac.createGain();
    this.delaySend.gain.value = 0.1;
    this.delay.connect(this.delayLp);
    this.delayLp.connect(this.delayFb);
    this.delayFb.connect(this.delay);
    this.delayLp.connect(this.comp);
    this.keysBus.connect(this.delaySend);
    this.melBus.connect(this.delaySend);
    this.arpBus.connect(this.delaySend);
    this.delaySend.connect(this.delay);

    this.noise = makeNoise(ac, 4);

    /* vinyl surface noise: a recorded loop when one is available, under a
       faint procedural floor */
    this.crackleGain = ac.createGain();
    this.crackleGain.gain.value = 0;
    this.crackleGain.connect(this.masterIn);

    /* rain bed */
    this.rainSrc = ac.createBufferSource();
    this.rainSrc.buffer = makeRain(ac, 7);
    this.rainSrc.loop = true;
    this.rainGain = ac.createGain();
    this.rainGain.gain.value = 0;
    this.rainLpBase = 2600;
    this.rainLp = ac.createBiquadFilter();
    this.rainLp.type = 'lowpass';
    this.rainLp.frequency.value = this.rainLpBase;
    this.rainLp.Q.value = 0.5;
    const rainHp = ac.createBiquadFilter();
    rainHp.type = 'highpass';
    rainHp.frequency.value = 240;
    rainHp.Q.value = 0.4;
    const rainLfo = ac.createOscillator();
    rainLfo.frequency.value = 0.07;
    const rainLfoAmt = ac.createGain();
    rainLfoAmt.gain.value = 0.0025;
    rainLfo.connect(rainLfoAmt).connect(this.rainGain.gain);
    rainLfo.start();
    this.rainSrc.connect(rainHp).connect(this.rainLp).connect(this.rainGain).connect(this.masterIn);
    this.rainSrc.start();

    /* room tone */
    this.textureGain = ac.createGain();
    this.textureGain.gain.value = 0;
    this.textureGain.connect(this.masterIn);
    const textureSrc = ac.createBufferSource();
    textureSrc.buffer = makeRoomTone(ac, 8);
    textureSrc.loop = true;
    this.textureLpBase = 1100;
    this.textureLp = ac.createBiquadFilter();
    this.textureLp.type = 'lowpass';
    this.textureLp.frequency.value = this.textureLpBase;
    this.textureLp.Q.value = 0.35;
    const textureHp = ac.createBiquadFilter();
    textureHp.type = 'highpass';
    textureHp.frequency.value = 55;
    textureHp.Q.value = 0.4;
    textureSrc.connect(textureHp).connect(this.textureLp).connect(this.textureGain);
    try { textureSrc.start(); } catch (e) {}
    this.textureSrc = textureSrc;

    /* tape hiss */
    this.hissGain = ac.createGain();
    this.hissGain.gain.value = 0;
    this.hissGain.connect(this.masterIn);
    const hissSrc = ac.createBufferSource();
    hissSrc.buffer = makeNoise(ac, 5);
    hissSrc.loop = true;
    const hissHp = ac.createBiquadFilter();
    hissHp.type = 'highpass';
    hissHp.frequency.value = 3200;
    const hissLp = ac.createBiquadFilter();
    hissLp.type = 'lowpass';
    hissLp.frequency.value = 8200;
    hissSrc.connect(hissHp).connect(hissLp).connect(this.hissGain);
    try { hissSrc.start(); } catch (e) {}
    this.hissSrc = hissSrc;
  }

  /* Audio nodes created for a note are only referenced from the buses they
     feed, so unless they are disconnected they stay in the graph forever.
     Track every node a scheduling step creates and sweep the finished ones
     out a few seconds later; without this, WebKit's render graph grows all
     session and Safari starts dropping buffers (static/pops) after ~20 min. */
  _trackNodes() {
    const ac = this.ctx;
    const factories = [
      'createGain', 'createBiquadFilter', 'createStereoPanner', 'createDelay',
      'createOscillator', 'createBufferSource', 'createWaveShaper',
      'createDynamicsCompressor'
    ];
    for (const name of factories) {
      const original = ac[name];
      if (typeof original !== 'function') continue;
      ac[name] = (...args) => {
        const node = original.apply(ac, args);
        if (this._capture) this._capture.push(node);
        return node;
      };
    }
  }

  /* two-tap modulated delay: a dusty chorus for keys and lead, lowpassed
     so it widens the tape rather than adding a clean shimmer */
  _makeChorus(dest) {
    const ac = this.ctx;
    const input = ac.createGain();
    const dry = ac.createGain();
    dry.gain.value = 1;
    input.connect(dry).connect(dest);

    const wet = ac.createGain();
    wet.gain.value = 0;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4500;
    lp.Q.value = 0.3;
    lp.connect(wet).connect(dest);

    const taps = [
      { delay: 0.012, rate: 0.21, depth: 0.0022, pan: -0.6 },
      { delay: 0.019, rate: 0.53, depth: 0.0013, pan: 0.6 }
    ];
    for (const tap of taps) {
      const d = ac.createDelay(0.05);
      d.delayTime.value = tap.delay;
      const lfo = ac.createOscillator();
      lfo.frequency.value = tap.rate;
      const amt = ac.createGain();
      amt.gain.value = tap.depth;
      lfo.connect(amt).connect(d.delayTime);
      lfo.start();
      input.connect(d);
      if (ac.createStereoPanner) {
        const p = ac.createStereoPanner();
        p.pan.value = tap.pan;
        d.connect(p).connect(lp);
      } else {
        d.connect(lp);
      }
    }
    return { input, wet };
  }

  _initVinyl() {
    if (this.crackleSrc) return;
    const ac = this.ctx;
    /* The recorded loop carries the surface noise; the floor only adds a
       faint hiss and a few ticks so quiet passages still read as vinyl. */
    const floor = makeVinylFloor(ac, 22);
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 240;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 6800;
    hp.connect(lp).connect(this.crackleGain);
    const floorSrc = ac.createBufferSource();
    floorSrc.buffer = floor;
    floorSrc.loop = true;
    const floorGain = ac.createGain();
    /* the floor is generated near the old bed level; keep it far under the
       record instead of proportional to it */
    floorGain.gain.value = 0.2;
    floorSrc.connect(floorGain).connect(hp);
    /* The record source loops for the whole session, so the crackle never
       restarts between songs. Its buffer arrives from the sample provider
       once decoded. */
    const recSrc = ac.createBufferSource();
    recSrc.loop = true;
    const recGain = ac.createGain();
    const sink = (buf) => {
      if (!buf) return;
      const now = ac.currentTime + 0.02;
      recGain.gain.cancelScheduledValues(now);
      recGain.gain.setValueAtTime(recGain.gain.value, now);
      /* a short swell eases the loop in without a click */
      recGain.gain.linearRampToValueAtTime(0, now + 0.06);
      const next = ac.createBufferSource();
      next.buffer = buf;
      next.loop = true;
      next.connect(recGain);
      next.start(now + 0.06);
      recGain.gain.linearRampToValueAtTime(this.vinylRecordGain, now + 0.20);
      const old = this.crackleSrc;
      if (old && old !== next) {
        try { old.stop(now + 0.07); } catch (e) {}
      }
      this.crackleSrc = next;
    };
    this.samples.onVinyl(sink);
    recSrc.connect(recGain).connect(hp);
    recGain.gain.value = 0;
    try {
      floorSrc.start();
      recSrc.start();
    } catch (e) {}
    this.crackleSrc = recSrc;
    this.crackleRecordGain = recGain;
    this.crackleFloorSrc = floorSrc;
    const record = this.samples.vinyl();
    if (record) sink(record);
  }

  /* ---------- transport ---------- */
  /* Background tabs throttle page timers, so the scheduler is driven from a
     small worker instead. If workers are unavailable, fall back to a timer. */
  _startTicker() {
    if (this.ticker) {
      try {
        this.ticker.postMessage('start');
        return;
      } catch (e) {
        this.ticker = null;
      }
    }
    if (typeof Worker !== 'undefined' && typeof Blob !== 'undefined' &&
        typeof URL !== 'undefined' && URL.createObjectURL) {
      try {
        const src = 'let timer=null;onmessage=(e)=>{if(e.data==="start"){if(timer)clearInterval(timer);timer=setInterval(()=>postMessage("tick"),25)}else if(e.data==="stop"){if(timer)clearInterval(timer);timer=null}};';
        const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        const worker = new Worker(url);
        worker.onmessage = () => { if (this.playing) this._tick(); };
        worker.onerror = () => {
          try { worker.terminate(); } catch (e) {}
          this.ticker = null;
          if (this.playing && !this.timer) this.timer = setInterval(() => this._tick(), 25);
        };
        this.ticker = worker;
        worker.postMessage('start');
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return;
      } catch (e) {
        this.ticker = null;
      }
    }
    if (!this.timer) this.timer = setInterval(() => this._tick(), 25);
  }

  _stopTicker() {
    if (this.ticker) {
      try { this.ticker.postMessage('stop'); } catch (e) {}
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  start(moodKey) {
    if (moodKey) this.moodKey = moodKey;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const samePreview = this._previewSong && this.song && (
      this.song.moodKey === this.moodKey ||
      (this.moodKey === this.mixKey && this.mixPool.indexOf(this.song.moodKey) !== -1)
    );
    if (!samePreview) this._newSong();
    this._previewSong = false;
    this.pendingMood = null;
    this.songStep = 0;
    this.nextTime = this.ctx.currentTime + 0.12;
    this.songStartTime = this.nextTime;
    this.lookahead = this.isHidden() ? this.hiddenLookahead : this.visibleLookahead;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(Math.max(0.0001, this.master.gain.value), t);
    this.master.gain.linearRampToValueAtTime(this._outputGain(), t + 0.9);
    this.playing = true;
    this._startTicker();
    this._tick();
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    this._stopTicker();
    this._tailUntil = 0;
    const t = this.ctx.currentTime;
    this.musicDuck.gain.cancelScheduledValues(t);
    this.musicDuck.gain.setValueAtTime(1, t);
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.linearRampToValueAtTime(0.0001, t + 0.5);
    /* release this song's voices */
    const doomed = Array.from(this.voices);
    setTimeout(() => {
      for (const src of doomed) {
        try { src.disconnect(); } catch (e) {}
        try { src.stop(); } catch (e) {}
        this.voices.delete(src);
      }
    }, 620);
    /* let the reverb/echo tails die before sleeping the context */
    setTimeout(() => {
      if (!this.playing && this.ctx.state === 'running') this.ctx.suspend();
    }, 3600);
  }

  setMood(key) {
    if (!this.styles[key]) return;
    if (!this.playing) {
      this.moodKey = key;
      this.pendingMood = null;
      return;
    }
    this.pendingMood = key;
  }

  /* The limiter leaves a little headroom above the old 0..1 output range, so
     the slider's top end now uses it instead of stopping short. The safety
     curve after the volume control still bounds the final output. */
  _outputGain() {
    return this.volume * 1.1;
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.playing) {
      this.master.gain.setTargetAtTime(this._outputGain(), this.ctx.currentTime, 0.06);
    }
  }

  setSeed(value) {
    this.songIndex = 0;
    this.mixQueue = [];
    this.directSeed = false;
    if (typeof value === 'string' && value.indexOf('s:') === 0) {
      /* a shared song seed: play this exact song first */
      const n = parseInt(value.slice(2), 36);
      this.baseSeed = Number.isFinite(n) ? (n >>> 0) : ((Math.random() * 0xFFFFFFFF) >>> 0);
      this.directSeed = true;
    } else {
      this.baseSeed = value === null || value === undefined || value === ''
        ? ((Math.random() * 0xFFFFFFFF) >>> 0)
        : hashSeed(value);
    }
  }

  replay() {
    if (!this.song) return;
    const seed = this.song.seed;
    const moodKey = this.song.moodKey;
    const wasPlaying = this.playing;
    this._previewSong = !wasPlaying;
    this._newSong(seed, moodKey);
    this.songStep = 0;
    this.prevVoicing = null;
    this.melodyEvents = [];
    this.lastMelodyBar = -99;
    if (wasPlaying) {
      this.nextTime = this.ctx.currentTime + 0.1;
      this.songStartTime = this.nextTime;
      this.lookahead = this.isHidden() ? this.hiddenLookahead : this.visibleLookahead;
      this._tick();
    }
  }

  next() {
    const wasPlaying = this.playing;
    this._previewSong = !wasPlaying;
    this._newSong();
    this.songStep = 0;
    this.songStartTime = this.nextTime;
    this.prevVoicing = null;
    this.melodyEvents = [];
    this.lastMelodyBar = -99;
    if (wasPlaying) {
      this.nextTime = this.ctx.currentTime + 0.1;
      this.songStartTime = this.nextTime;
      this.lookahead = this.isHidden() ? this.hiddenLookahead : this.visibleLookahead;
      this._tick();
    }
  }

  /* ---------- song construction ---------- */
  /* Titles come from their own seeded stream so the same seed and style
     always give the same title. Deriving it from the planning RNG made it
     depend on how many draws the plan happened to consume. Hosts usually
     supply a title callback so naming stays with the app. */
  _title(moodKey, seed) {
    if (typeof this._titleTemplate === 'function') {
      return this._titleTemplate(seed >>> 0, moodKey, this.styles[moodKey]);
    }
    const style = this.styles[moodKey] || {};
    const word = style.label || style.name || 'song';
    return word + ' ' + (seed >>> 0).toString(36);
  }

  /* Mix cycles through the caller's pool in a shuffled bag. A fresh session
     can open on a preferred style, then the rest of the bag follows. Shared
     seeds keep the same seeded order so an existing link plays the same
     songs. */
  _nextMixMood() {
    if (!this.mixQueue.length) {
      const pool = this.mixPool.length ? this.mixPool : this.mixOrder;
      this.mixQueue = pool.filter(
        (k) => !this.mixOrder.length || this.mixOrder.indexOf(k) !== -1
      );
      for (let i = this.mixQueue.length - 1; i > 0; i--) {
        const j = randInt(0, i);
        const tmp = this.mixQueue[i];
        this.mixQueue[i] = this.mixQueue[j];
        this.mixQueue[j] = tmp;
      }
      if (this.mixOpening && this.songIndex === 1 && !this.directSeed) {
        const at = this.mixQueue.indexOf(this.mixOpening);
        if (at > 0) this.mixQueue.unshift(this.mixQueue.splice(at, 1)[0]);
      }
    }
    return this.mixQueue.shift();
  }

  _newSong(seedOverride, moodOverride, at) {
    const replaying = seedOverride !== undefined && seedOverride !== null;
    let seed;
    let shareLocked = replaying;
    if (replaying) {
      seed = seedOverride >>> 0;
    } else {
      this.songIndex += 1;
      if (this.songIndex === 1 && this.directSeed) {
        seed = this.baseSeed;
        shareLocked = true;
      } else {
        seed = (this.baseSeed ^ Math.imul(this.songIndex, 0x9E3779B9)) >>> 0;
      }
    }

    const song = this._planSong(seed, moodOverride || this.moodKey, shareLocked);
    if (!shareLocked) {
      if (song.motifFingerprints) {
        for (const fp of song.motifFingerprints) this.motifMemory.push(fp);
        while (this.motifMemory.length > 6) this.motifMemory.shift();
      }
      this.registerMemory = song.melodyShift;
      this.lastPianoBank = song.pianoBank;
    }
    this._tailUntil = 0;
    this._applySong(song, at);
  }

  /* Pure planning: uses the seeded RNG and never touches the audio graph,
     so plans can be generated and inspected (or shared) without playing. */
  _planSong(seed, moodKeyIn, shareLocked) {
    const prevRng = _rng;
    _rng = mulberry32(seed);
    try {
      const moodKey = moodKeyIn === this.mixKey ? this._nextMixMood() : moodKeyIn;
      const mood = this.styles[moodKey] || this.styles[this.defaultStyle] || Object.values(this.styles)[0];
      const traits = mood.traits || {};
      const lofi = !!mood.lofi;
      const lofiHuman = lofi ? 1 : 0;
      /* A trio personality is drawn first, from the top of the seeded stream.
         Drawing it after the progression/tempo/root picks skewed the shares
         badly (47/22/19/12 instead of the intended 40/20/25/15) because those
         three draws land on a correlated part of the mulberry32 stream. */
      const trioPersona = mood.jazz
        ? weightedPick(this.trioPersonalities, this.trioPersonalities.map((x) => x.w))
        : null;
      const prog = pick(mood.progressions);
      const bpm = randInt(mood.bpm[0], mood.bpm[1]);
      const root = pick(mood.roots);

      /* Plan form, energy arc and harmony. Some songs get a free-time
         intro/outro, which is planned before the form so it can reserve
         enough bars for the piano to breathe. Piano-led jazz leans into
         that space more often, and jazz-lite songs take the same free time
         in small doses. The roll is drawn up front so the RNG stream stays
         put whether or not a style is active. */
      const lite = mood.jazzLite || null;
      const liteRoll = lite ? _rng() : 1;
      const liteDrums = !!(lite && lite.drums && liteRoll < lite.drums);
      const liteComp = !!(lite && lite.comp && !liteDrums && liteRoll < lite.drums + lite.comp);
      const liteRubato = !!(lite && lite.rubato && !liteDrums && !liteComp &&
        liteRoll < lite.drums + lite.comp + lite.rubato);
      const wanderMelody = mood.jazz
        ? (trioPersona
          ? chance(trioPersona.wander)
          : chance(mood.wanderLead || 0))
        : chance(mood.wanderLead || 0);
      const rubatoChance = trioPersona
        ? trioPersona.rubato
        : clamp((mood.rubato ? mood.rubato.chance : 0) + (wanderMelody ? 0.36 : 0), 0, 1);
      const rubatoOn = !!(mood.rubato && (liteRubato || chance(rubatoChance)));
      /* A few songs open on the groove alone and let the keys, bass and pad
         arrive a bar or two later. The roll comes from its own hash so this
         choice does not reshuffle the seeded planning stream of songs that
         already have shared links. Free-time intros keep their piano. */
      const beatFirstCfg = mood.beatFirst;
      const beatFirstRoll = beatFirstCfg
        ? mulberry32(hashSeed(seed + ':' + moodKey + ':beatfirst'))()
        : 1;
      const beatFirstOn = !!(beatFirstCfg && !rubatoOn && beatFirstRoll < beatFirstCfg.chance);
      const sections = planForm(mood, bpm, rubatoOn);
      if (beatFirstOn && sections[0].kind === 'intro') {
        const intro = sections[0];
        /* Leave at least one intro bar for the band to state the harmony, so
           the drums never hand straight over to the first main section. */
        intro.beatFirst = {
          bars: clamp(Math.min(intro.bars - 1, 2), 1, intro.bars - 1),
          drums: beatFirstCfg.drums
        };
      }
      const totalBars = sections[sections.length - 1].end;
      const chords = planHarmony(sections, totalBars, prog, mood);
      planArrangement(sections, mood);
      const evolve = clamp(mood.evolve || 0, 0, 1);
      const texture = evolve > 0 ? this._planTexture(evolve, totalBars) : null;

      /* Instrumentation plan; some jazz songs are a piano trio. */
      const palette = Object.assign({}, mood.palette);
      palette.leads = mood.palette.leads.slice();
      /* Trio is its own 80% draw; a wandering melody no longer forces one,
         since that coupling silently pushed the rate to ~87%. */
      const trio = !!mood.jazz && chance(mood.trio || 0.8);
      const backbeat = mood.backbeat && chance(mood.backbeat.chance) ? mood.backbeat : null;
      if (trio) {
        palette.keys = 'pianoNatural';
        palette.bass = 'ubass';
        palette.leads = ['pianoNatural'];
      } else if (traits.warm) {
        if (chance(0.78)) palette.keys = 'pianoNatural';
        if (chance(0.22)) palette.bass = 'ubass';
        if (chance(0.24) && palette.leads.indexOf('flute') === -1) palette.leads.push('flute');
      } else if (mood.jazz && chance(0.38)) {
        palette.leads = palette.leads.filter((n) => n !== 'vibes');
      }
      if (traits.ambient && chance(0.38)) palette.keys = 'pianoNatural';
      if (traits.calm && chance(0.32)) palette.keys = 'pianoNatural';
      if (traits.bright && chance(0.30)) palette.keys = 'pianoNatural';
      if (lofi) {
        if (chance(0.35)) palette.bass = 'ubass';
        if (chance(0.2) && palette.leads.indexOf('guitar') === -1) palette.leads.push('guitar');
      }
      /* Ambient songs get an upright bass a little more often, and a few are
         mixed a touch more open so the music can be dreamy without being
         uniformly dark. */
      if (traits.ambient && palette.bass === 'ebass' && chance(0.2)) {
        palette.bass = 'ubass';
      }
      const airyRain = !!traits.ambient && chance(0.35);
      const dreamy = !!(!trio && traits.warm && chance(palette.keys === 'ep' ? 0.8 : 0.65));
      const rawKeyLp = palette.keys === 'pianoNatural'
        ? Math.max(mood.tone.keyLp, 5200)
        : palette.keys === 'piano'
          ? Math.max(mood.tone.keyLp, 4000)
          : mood.tone.keyLp;
      let keyLp = (lofi || traits.calm) ? Math.min(rawKeyLp, 3000) : rawKeyLp;
      if (airyRain) keyLp = Math.max(keyLp, 2200);

      const drum = mood.drums;
      const sleepyJazz = (liteDrums && traits.calm && drum.jazz) || false;

      let kickSeeds = drum.kick;
      let snareSeeds = drum.snare;
      let hatSeeds = drum.hat;
      if (sleepyJazz) {
        kickSeeds = [drum.kick3 || drum.kick[0], drum.kick[drum.kick.length - 1]];
        snareSeeds = [drum.snare3 || drum.snare[0]];
        hatSeeds = [drum.hat3 || drum.hat[0], drum.hat[drum.hat.length - 1]];
      }
      const kickSeedA = pick(kickSeeds);
      let kickSeedB = pick(kickSeeds);
      if (kickSeeds.length > 1 && kickSeedB === kickSeedA) kickSeedB = kickSeeds[(kickSeeds.indexOf(kickSeedA) + 1) % kickSeeds.length];
      const snareSeedA = pick(snareSeeds);
      let snareSeedB = pick(snareSeeds);
      if (snareSeeds.length > 1 && snareSeedB === snareSeedA) snareSeedB = snareSeeds[(snareSeeds.indexOf(snareSeedA) + 1) % snareSeeds.length];
      const hatSeedA = pick(hatSeeds);
      let hatSeedB = pick(hatSeeds);
      if (hatSeeds.length > 1 && hatSeedB === hatSeedA) hatSeedB = hatSeeds[(hatSeeds.indexOf(hatSeedA) + 1) % hatSeeds.length];
      const kickA = varyDrumPattern(kickSeedA, 'kick');
      const kickB = varyDrumPattern(kickSeedB, 'kick');
      const snareA = varyDrumPattern(snareSeedA, 'snare');
      const snareB = varyDrumPattern(snareSeedB, 'snare');
      const hatA = varyDrumPattern(hatSeedA, 'hat');
      const hatB = varyDrumPattern(hatSeedB, 'hat');
      const drumSwitchBars = pick([2, 4, 4, 8]);
      const hatVel = drum.hatVel * rand(0.88, 1.12);
      const ghostChance = clamp((lofi ? 0.56 : 0.42) + rand(-0.16, 0.20), 0.12, 0.8);
      const swing = clamp((mood.swing || 0.12) + (trioPersona ? trioPersona.swing : 0) + rand(-0.02, 0.02), 0.03, 0.30);
      const rideAccents = pick([[0, 6, 8], [0, 8], [0, 4, 8, 12], [0, 6, 8, 14]]);
      /* A jazz ride leaves a little space in the skip beat instead of
         running straight eighths every bar. */
      const rideSteps = pick([
        [0, 4, 6, 8, 12, 14],
        [0, 4, 6, 8, 10, 12, 14],
        [0, 4, 6, 8, 12, 14],
        [0, 4, 6, 8, 12, 14]
      ]);
      const brushSteps = pick([[4, 12], [4, 12], [2, 10], [6, 14]]);
      const hatAccent = chance(mood.jazz ? 0.50 : traits.ambient ? 0.22 : 0.36);

      /* Pick the drum feel before the patterns so brushed songs can soften
         the kick and keep the cymbals out of the way. */
      const drumStyles = drum.styles;
      let drumStyle = drumStyles
        ? weightedPick(drumStyles, drumStyles.map((s) => s.w || 1))
        : null;
      if (wanderMelody && drumStyles) {
        const brushed = drumStyles.filter((s) => s.swirl || s.snareBrush);
        if (brushed.length && chance(0.62)) {
          drumStyle = weightedPick(brushed, brushed.map((s) => s.w || 1));
        }
      }
      if (liteDrums) {
        if (sleepyJazz) {
          drumStyle = {
            id: 'waltz',
            hat: !!drum.jazz.hat,
            brush: true,
            snareBrush: true,
            ghost: drum.jazz.ghost,
            softKick: drum.jazz.softKick
          };
        } else if (drum.drumStyles) {
          drumStyle = drum.drumStyles.filter((s) => s.snareBrush || s.brush)[0] || drum.drumStyles[0];
        } else {
          drumStyle = { id: 'brushed', hat: true, brush: true, snareBrush: true, ghost: 0.1, softKick: 0.9 };
        }
      }
      const drumRide = drumStyle ? !!drumStyle.ride : !!drum.ride;
      const drumHat = drumStyle ? !!drumStyle.hat : !drum.ride;
      const drumSwirl = !!(drumStyle && drumStyle.swirl);
      const drumSnareBrush = !!(drumStyle && (drumStyle.snareBrush || drumSwirl));
      const drumBrush = drumStyle ? !!drumStyle.brush : !!drum.brush;
      const drumGhost = drumStyle && drumStyle.ghost !== undefined ? drumStyle.ghost : drum.ghost;
      const drumKickVel = drumStyle && drumStyle.softKick !== undefined ? drumStyle.softKick : 1;
      const drumStyleId = drumStyle ? drumStyle.id : 'kit';
      const drumPlan = {
        id: drumStyleId,
        ride: drumRide,
        hat: drumHat,
        brush: drumBrush,
        swirl: drumSwirl,
        snareBrush: drumSnareBrush,
        ghost: drumGhost,
        kickVel: drumKickVel
      };

      /* Some songs get a piano counter-line instead of the usual guitar or
         vibes arpeggio; the rest keep the simpler riff-based backing. */
      const wanderPiano = !trio && chance(mood.wanderPiano || 0);
      const hangPiano = !trio
        ? (wanderPiano || chance(traits.warm ? 0.7 : lofi ? 0.55 : mood.jazz ? 0.75 : traits.ambient ? 0.30 : 0.44))
        : (wanderMelody && chance(0.4));

      const guitarSong = trio ? false : chance(mood.guitarChance || 0.65);
      let leads = palette.leads.slice();
      if (trio) {
        leads = ['pianoNatural'];
      } else if (liteComp) {
        /* a jazz-lite comp song hands the lead line to the piano */
        leads = ['pianoNatural'];
      } else if (!guitarSong) {
        const without = leads.filter((n) => n !== 'guitar');
        if (without.length) leads = without;
      } else if (chance(0.38)) {
        leads = ['guitar'].concat(leads.filter((n) => n !== 'guitar'));
      }
      if (!leads.length) leads = ['vibes'];
      const leadOffset = randInt(0, Math.max(0, leads.length - 1));
      const leadBySection = sections.map((s, i) => leads[(i + leadOffset) % leads.length]);
      const labelFor = (n) => (this.instrumentSpecs[n] && this.instrumentSpecs[n].label) || n;
      const leadLabels = [...new Set(leadBySection)].map(labelFor);
      const orderedLeadLabels = guitarSong
        ? ['guitar'].concat(leadLabels.filter((n) => n !== 'guitar'))
        : leadLabels;

      const instruments = {
        keys: labelFor(palette.keys),
        bass: labelFor(palette.bass),
        lead: leadLabels.join(' / ')
      };

      let arpInst = trio ? 'pianoNatural' : (mood.arpInst || (leads.indexOf('guitar') !== -1 ? 'guitar' : 'vibes'));
      if (wanderPiano) arpInst = 'pianoNatural';
      if (!guitarSong && arpInst === 'guitar') {
        arpInst = palette.keys === 'pianoNatural'
          ? 'pianoNatural'
          : palette.keys === 'piano'
            ? 'piano'
            : 'vibes';
      }

      const L = Object.assign({}, mood.levels, {
        drums: mood.levels.drums * (mood.drumBoost || 1) * (trioPersona ? trioPersona.drumScale : 1)
      });

      /* Rhythm piano: strength and feel vary from song to song so the comp
         never settles into the same weight every time. */
      const compCfg = mood.comping || {};
      let compStyle = null;
      let keyPat;
      let keyPatB = null;
      if (mood.jazz && compCfg.styles) {
        /* A trio personality narrows the comp choices so the feel stays
           coherent; outside a personality the full weighted set applies. */
        let pool = compCfg.styles;
        if (trioPersona && trioPersona.comps) {
          const allowed = compCfg.styles.filter((s) => trioPersona.comps.indexOf(s.id) !== -1);
          if (allowed.length) pool = allowed;
        }
        compStyle = weightedPick(pool, pool.map((s) => s.w));
        if (wanderMelody) {
          const rolled = pool.filter((s) => s.roll);
          if (rolled.length && chance(0.2)) compStyle = weightedPick(rolled, rolled.map((s) => s.w));
        }
        keyPat = compStyle.pat;
        keyPatB = compStyle.patB || null;
      } else {
        keyPat = pick(mood.keys.patterns);
        if (keyPat.length > 2 && chance(0.18)) keyPat = keyPat.slice(0, 2);
        if (chance(traits.ambient ? 0.55 : 0.3)) keyPatB = pick(mood.keys.patterns);
      }
      const compPlan = {
        id: compStyle ? compStyle.id : 'pattern',
        intensity: compCfg.intensity ? rand(compCfg.intensity[0], compCfg.intensity[1]) : 0.9,
        drop: (compCfg.drop || 0.1) * rand(0.6, 1.3),
        underMelody: compCfg.underMelody || 0.85,
        vel: compStyle ? compStyle.vel : 1,
        short: !!(compStyle && compStyle.short),
        split: !!(compStyle && compStyle.split),
        roll: !!(compStyle && compStyle.roll),
        syncopated: !!(compStyle && compStyle.syncopated)
      };
      if (wanderMelody) compPlan.underMelody = Math.min(compPlan.underMelody, 0.64);
      /* Rain keeps its long ambient chords, but a soft mid-bar re-voice and
         the occasional rolled attack stop the same four bars from feeling
         like a loop. */
      if (traits.ambient) {
        compPlan.revoice = chance(0.55);
        compPlan.rainLift = chance(0.5);
        if (chance(0.28)) compPlan.roll = true;
      }
      /* jazz-lite comp: a light swung piano comp of two or three long chords
         in place of the looped keys, still quieter than the hand-tuned level */
      if (liteComp) {
        keyPat = [[0, 4], [6, 3], [11, 4]];
        keyPatB = null;
        compPlan.id = 'jazzLite-light';
        compPlan.vel = 0.8;
        compPlan.intensity = Math.min(compPlan.intensity, 0.82);
        compPlan.drop = Math.max(compPlan.drop, 0.15);
      }

      /* Bass: jazz walks most songs, but a few keep a sparse root-fifth line
         and the approach note is usually diatonic. Lofi moods only walk the
         occasional phrase turnaround. */
      const walkCfg = mood.walking || {};
      const walkOn = !!mood.walking && (mood.jazz || chance(walkCfg.chance || 0));
      const walkRoll = _rng();
      const walkStyle = !walkOn
        ? null
        : walkRoll < (walkCfg.diatonic || 0.7) ? 'diatonic'
          : walkRoll < 0.9 ? 'mixed'
            : 'chromatic';
      const bassPlan = {
        walk: walkOn,
        sparse: walkOn && mood.jazz && chance(walkCfg.sparse || 0),
        style: walkStyle,
        scope: mood.jazz ? 'always' : 'turnaround'
      };

      const rubato = rubatoOn ? {
        intro: !!sections[0].rubato,
        outro: !!sections[sections.length - 1].rubato,
        gain: lofi ? rand(0.76, 0.9) : rand(0.84, 1.0)
      } : null;

      const regPool = [-5, -2, 0, 0, 2, 5].filter((v) => v !== this.registerMemory);
      const melodyShift = (mood.melodyShift || 0) +
        (!shareLocked ? pick(regPool) : 0);
      const motifPair = makeMotifPair(mood.melodyRhythms || this.defaultMelodyRhythms, shareLocked ? [] : this.motifMemory);

      const bankChoices = (mood.pianoBanks || ['salamander']).filter(
        (b) => b === 'salamander' || this.pianoPacks.indexOf(b) !== -1
      );
      const usableBanks = bankChoices.length ? bankChoices : ['salamander'];
      let bankPool = usableBanks;
      if (!shareLocked && this.lastPianoBank && usableBanks.length > 1) {
        bankPool = usableBanks.filter((b) => b !== this.lastPianoBank);
        if (!bankPool.length) bankPool = usableBanks;
      }
      const pianoBank = this.bankOverride || pick(bankPool);

      return {
        moodKey,
        mood,
        bpm,
        root,
        scale: prog.scale,
        chords,
        sections,
        totalBars,
        title: this._title(moodKey, seed),
        palette,
        dreamy,
        swing,
        keyLp,
        age: mood.age || 0,
        trio,
        persona: trio ? (trioPersona ? trioPersona.id : null) : null,
        lofi,
        wanderMelody,
        leadBySection,
        arpInst,
        guitarSong,
        hangPiano,
        wanderPiano,
        rootlessVoicings: !!mood.rootless,
        hatAccent,
        backbeat,
        instruments,
        instrumentLine: trio
          ? instruments.keys + ' · ' + instruments.bass + ' · drums'
          : instruments.keys + ' · ' + instruments.bass + ' · ' + orderedLeadLabels.join(' / '),
        keyPat,
        keyPatB,
        compPlan,
        bassPlan,
        rubato,
        bassPat: pick(mood.bass.patterns),
        drumPats: { kickA, kickB, snareA, snareB, hatA, hatB, switchBars: drumSwitchBars, hatVel, ghostChance, rideAccents, rideSteps, brushSteps },
        drumStyle: drumPlan,
        waltz: sleepyJazz,
        motifs: motifPair,
        motifFingerprints: motifPair.map((m) => m.fingerprint),
        motifFingerprint: motifPair.map((m) => m.fingerprint).join(','),
        melodyShift,
        formId: sections.formId || 'legacy',
        pianoBank,
        seed,
        seedString: seed.toString(36),
        levels: L,
        texture,
        human: {
          timing: lofi ? 0.018 : mood.jazz ? 0.012 : 0.008,
          dynamics: lofi ? 0.9 : mood.jazz ? 1.12 : 1,
          velocity: lofi ? 0.96 : mood.jazz ? 1.05 : 1
        }
      };
    } finally {
      _rng = prevRng;
    }
  }

  _applySong(song, at) {
    const mood = song.mood;
    const L = song.levels;
    this.song = song;
    this.prevVoicing = null;
    this.melodyEvents = [];
    this.melodySteps = null;
    this.arpEvents = [];
    this.rubatoEvents = null;
    this.bassEvents = null;
    this.cur = null;
    this.lastMelodyBar = -99;
    this.lastMelody = 76 + (song.melodyShift || 0);
    this.stepDur = 60 / song.bpm / 4;
    this.baseStepDur = this.stepDur;
    this._sampleSerial = 0;
    this._brushPan = 0;
    this._brushLean = null;

    const t = at === undefined ? this.ctx.currentTime : at;
    /* Cancel anything already queued at or after the new song's first beat so
       a pending ending fade can't leak into it, and so automation does not
       accumulate over a long session. When the change is immediate, pin the
       current value first so cancelling a fade in progress does not jump. */
    const immediate = t <= this.ctx.currentTime + 0.001;
    const set = (param, v) => {
      const current = immediate ? param.value : 0;
      param.cancelScheduledValues(t);
      if (immediate) param.setValueAtTime(current, t);
      param.setTargetAtTime(v, t, 0.25);
    };
    set(this.keysBus.gain, L.keys);
    set(this.bassBus.gain, L.bass);
    set(this.padBus.gain, L.pad);
    set(this.drumBus.gain, L.drums);
    set(this.melBus.gain, L.melody);
    set(this.arpBus.gain, L.arp);
    set(this.percBus.gain, L.perc);
    set(this.crackleGain.gain, mood.vinyl);
    set(this.rainGain.gain, mood.rain);
    set(this.textureGain.gain, mood.texture);
    set(this.hissGain.gain, mood.hiss || 0);
    set(this.dry.gain, 1 - mood.space.reverb * 0.35);
    set(this.wet.gain, mood.space.reverb);
    set(this.wetLp.frequency, mood.space.wetLp || 4200);
    set(this.delaySend.gain, mood.space.delay);
    set(this.tone.frequency, mood.tone.highLp);
    set(this.keysTone.frequency, song.keyLp);
    set(this.subTone.frequency, mood.subLp || 120);
    set(this.bassTone.frequency, song.lofi ? 950 : 1500);
    set(this.melTone.frequency, Math.min(5600, mood.tone.highLp * 0.62));
    set(this.arpTone.frequency, song.arpInst === 'pianoNatural' ? 7000 : Math.min(4600, mood.tone.highLp * 0.55));
    if (this.chorusKeys) set(this.chorusKeys.wet.gain, mood.chorus || 0);
    if (this.chorusMel) set(this.chorusMel.wet.gain, mood.chorus || 0);
    this._wowBase = 0.0011 * (1 + song.age * 0.9);
    this._flutterBase = 0.00005 * (1 + song.age * 0.7);
    this.wowAmt.gain.setTargetAtTime(this._wowBase, t, 0.4);
    this.flutterAmt.gain.setTargetAtTime(this._flutterBase, t, 0.4);
    this.rainLp.frequency.setTargetAtTime(this.rainLpBase, t, 0.8);
    this.textureLp.frequency.setTargetAtTime(this.textureLpBase, t, 0.8);
    this.musicDuck.gain.cancelScheduledValues(t);
    this.musicDuck.gain.setValueAtTime(1, t);
    this._duckTime = -10;
    this._duckBase = mood.duck || 0.18;
    this.sat.curve = saturationCurve(mood.tone.drive);
    this.delay.delayTime.setTargetAtTime(this.stepDur * 4 * mood.space.delayBeats, t, 0.8);
    if (this.epPacks.indexOf(song.pianoBank) !== -1) this.samples.requestBank('salamander');
    else this.samples.requestBank(song.pianoBank);
    if (this.epBank) this.samples.requestBank(this.epBank);

    if (this.debug) {
      console.info(
        '[jazz-song-engine]',
        song.formId || song.sections.map((s) => s.name).join('/'),
        song.totalBars + ' bars',
        song.title,
        '· ' + song.chords.map((c) => NOTE_NAMES[mod12(song.root + c[0])] + c[1]).join(' '),
        '· motifs ' + song.motifFingerprint,
        '· persona ' + (song.persona || 'none') +
          ' · comp ' + (song.compPlan ? song.compPlan.id : 'pattern') +
          ' · bass ' + (song.bassPlan && song.bassPlan.walk
            ? (song.bassPlan.sparse ? 'sparse' : song.bassPlan.style)
            : 'pattern') +
          ' · drums ' + (song.drumStyle ? song.drumStyle.id : 'kit') +
          ' · melody ' + (song.wanderMelody ? 'wander' : 'motif') +
          (song.rubato
            ? ' · rubato ' + (song.rubato.intro ? 'in' : '') +
              (song.rubato.intro && song.rubato.outro ? '+' : '') +
              (song.rubato.outro ? 'out' : '')
            : ''),
          (song.sections[0].beatFirst
            ? ' · beat-first ' + song.sections[0].beatFirst.bars + ' bars'
            : ''),
        '· seed ' + song.seedString + ' (' + song.seed + ' / 0x' + song.seed.toString(16).toUpperCase() + ')',
        '· bank ' + song.pianoBank
      );
    }
    if (this.onSong) this.onSong(song);
  }

  _section(bar) {
    const secs = this.song.sections;
    for (const s of secs) if (bar >= s.start && bar < s.end) return s;
    return secs[secs.length - 1];
  }

  _prepareBar(bar) {
    const song = this.song;
    const sec = this._section(bar);
    /* Free-time sections ease away from the click: a touch slower at the top
       of the intro, drifting back as the groove locks in, and again on the
       way out. */
    const span = Math.max(1, sec.end - sec.start - 1);
    const pos = clamp((bar - sec.start) / span, 0, 1);
    const tempoEase = sec.rubato
      ? (sec.kind === 'outro' ? 1 - 0.10 * pos : 1 + 0.10 * (1 - pos))
      : 1;
    this.stepDur = (this.baseStepDur || this.stepDur) * tempoEase;

    /* Per-bar deterministic stream. */
    const prevRng = _rng;
    _rng = mulberry32(hashSeed(song.seedString + ':' + bar));
    try {
      const chord = song.chords[bar];
      const rootPc = mod12(song.root + chord[0]);
      const voicing = buildVoicing(
        rootPc, chord[1], this.prevVoicing, spiceFor(song.mood), song.rootlessVoicings
      );
      this.prevVoicing = voicing;

      this.cur = {
        sec,
        chord,
        rootPc,
        voicing,
        chordPcs: (CHORDS[chord[1]] || CHORDS.m7).map((iv) => mod12(rootPc + iv))
      };
      /* The next bar's chord lets sustained melody notes resolve into the
         change instead of being caught out by it. */
      const nextChord = song.chords[(bar + 1) % song.chords.length];
      const nextRootPc = mod12(song.root + nextChord[0]);
      this.cur.nextChordPcs = (CHORDS[nextChord[1]] || CHORDS.m7).map((iv) => mod12(nextRootPc + iv));
      this.cur.nextRootPc = nextRootPc;
      /* Per-bar variation of the comp rhythm. The preset patterns are fixed
         arrays, so without this every bar played the same five hits and the
         comp read as a loop no matter how the harmony moved. Nudge a hit or
         two now and then instead of replaying the identical shape. */
      this.cur.keyPat = this._varyCompPat(sec, bar);

      this.isFillBar = sec.fills
        ? sec.fills.indexOf(bar - sec.start) !== -1
        : bar === sec.end - 1;
      this.isSectionEnd = bar === sec.end - 1;
      /* Look ahead to the section lift so the fill step can leave the bar
         alone when _transitionInto is about to add its own pickup. */
      const upcoming = song.sections[sec.idx + 1];
      this.isTransitionBar = !!(this.isSectionEnd && upcoming && !song.lofi && sec.energy > 0.3
        && upcoming.energy - sec.energy > 0.1);
      this.melodyEvents = this._makeMelody(bar, sec, this.cur);
      this.arpEvents = this._makeArp(bar, sec, this.cur);
      this.melodySteps = this.melodyEvents.length
        ? new Set(this.melodyEvents.map((e) => e.step))
        : null;

      /* Rubato bars replace the measured layers with free-time piano. */
      this.rubatoEvents = null;
      this.bassEvents = null;
      if (sec.rubato) {
        this.melodyEvents = [];
        this.melodySteps = null;
        this.arpEvents = [];
        this.rubatoEvents = this._makeRubato(bar, sec, this.cur);
      } else {
        this.bassEvents = this._makeBass(bar, sec, this.cur);
      }
      if (this.melodyEvents.length) this._lastMelodyBar = bar;

      if (bar === sec.start) this._sectionColor(sec);
      this._evolveTexture(bar);
      if (bar === sec.start && sec.idx > 0) {
        if (song.lofi) {
          if (sec.drums > 0.3 && chance(0.4)) {
            this._crash(this.nextTime, 0.14 * Math.min(1, sec.drums));
          }
        } else {
          if (sec.drums > 0.25) {
            this._crash(this.nextTime, 0.32 * Math.min(1, sec.drums));
          }
          const prev = song.sections[sec.idx - 1];
          if (prev && sec.energy - prev.energy > 0.18) {
            this._kick(this.nextTime + this.stepDur * 0.5, 0.62);
            this._crash(this.nextTime + this.stepDur * 0.5, 0.24);
          }
        }
      }

      /* Section transitions. */
      const next = song.sections[sec.idx + 1];
      if (!song.lofi && this.isSectionEnd && next && sec.energy > 0.3) {
        const rise = next.energy - sec.energy;
        const at = this.nextTime + this.stepDur * 8;
        if (rise > 0.1) {
          this._transitionInto(at, this.stepDur * 8, rise);
        } else if (rise < -0.18) this._dropout(at, this.stepDur * 6, 0.5);
      }
    } finally {
      _rng = prevRng;
    }
  }

  _sectionColor(sec) {
    const t = this.ctx.currentTime;
    const mood = this.song.mood;
    const lofi = this.song.lofi;
    const bright = 1 + ((sec.bright || 1) - 1) * (lofi ? 0.4 : 1);
    const wet = 1 + ((sec.wet || 1) - 1) * (lofi ? 0.55 : 1);
    const keyBase = this.song.keyLp || mood.tone.keyLp;
    const arpBase = this.song.arpInst === 'pianoNatural'
      ? 7000
      : Math.min(4600, mood.tone.highLp * 0.55);
    this.tone.frequency.setTargetAtTime(mood.tone.highLp * bright, t + 0.05, 1.1);
    this.keysTone.frequency.setTargetAtTime(keyBase * (0.9 + 0.1 * bright), t + 0.05, 1.2);
    this.melTone.frequency.setTargetAtTime(Math.min(5600, mood.tone.highLp * 0.62 * bright), t + 0.05, 1.2);
    this.arpTone.frequency.setTargetAtTime(Math.min(arpBase, arpBase * (0.9 + 0.1 * bright)), t + 0.05, 1.1);
    this.wet.gain.setTargetAtTime(mood.space.reverb * wet, t + 0.05, 1.4);
    this.wetLp.frequency.setTargetAtTime(
      (mood.space.wetLp || 4200) * (0.92 + 0.08 * bright), t + 0.05, 1.4
    );
  }

  _planTexture(depth, totalBars) {
    const layers = {};
    for (const key of Object.keys(TEXTURE_DRIFT)) {
      layers[key] = {
        cycles: rand(0.5, 1.6),
        cycles2: rand(0.3, 0.9),
        phase: rand(0, 1),
        phase2: rand(0, 1)
      };
    }
    return { depth, totalBars, layers };
  }

  _evolveTexture(bar) {
    const song = this.song;
    const plan = song && song.texture;
    if (!plan) return;
    const mood = song.mood;
    const p = plan.totalBars > 1 ? bar / (plan.totalBars - 1) : 0;
    const time = this.nextTime;
    const tau = Math.max(2.5, this.stepDur * 18);
    const drift = (l) =>
      0.68 * Math.sin(Math.PI * 2 * (l.cycles * p + l.phase)) +
      0.32 * Math.sin(Math.PI * 2 * (l.cycles2 * p + l.phase2));
    const factor = (key) => 1 + plan.depth * TEXTURE_DRIFT[key] * drift(plan.layers[key]);
    /* replace, don't queue: a new target per bar would otherwise stack
       automation on the same params for the whole session */
    const driftTo = (param, value) => {
      param.cancelScheduledValues(time);
      param.setTargetAtTime(value, time, tau);
    };

    if (mood.rain > 0) {
      driftTo(this.rainGain.gain, mood.rain * factor('rain'));
      driftTo(this.rainLp.frequency, this.rainLpBase * factor('rainLp'));
    }
    if (mood.texture > 0) {
      driftTo(this.textureGain.gain, mood.texture * factor('room'));
      driftTo(this.textureLp.frequency, this.textureLpBase * factor('roomLp'));
    }
    if (mood.hiss > 0) {
      driftTo(this.hissGain.gain, mood.hiss * factor('hiss'));
    }
    if (mood.vinyl > 0) {
      driftTo(this.crackleGain.gain, mood.vinyl * factor('vinyl'));
    }
    if (this._wowBase) {
      const f = factor('wow');
      driftTo(this.wowAmt.gain, this._wowBase * f);
      driftTo(this.flutterAmt.gain, this._flutterBase * f);
    }
  }

  /* Pick this bar's comp pattern and loosen it a little. Most bars keep the
     preset shape exactly; some shift one hit by a step, and a few drop a hit.
     The per-bar seeded RNG keeps it reproducible for a given song. */
  _varyCompPat(sec, bar) {
    const song = this.song;
    const phrase = Math.max(2, sec.phraseLen || 8);
    const useB = !!(song.keyPatB && Math.floor((bar - sec.start) / phrase) % 2 === 1);
    const base = useB ? song.keyPatB : song.keyPat;
    if (!base || !base.length) return base;
    /* Lofi loops stay steady; jazz comping loosens up. */
    const loose = song.lofi ? 0.12 : 0.30;
    const out = base.map((p) => [p[0], p[1]]);
    if (!chance(loose)) return out;
    /* Only the non-downbeat hits may move, so pick from those. */
    const movable = [];
    for (let k = 0; k < out.length; k++) if (out[k][0] !== 0) movable.push(k);
    if (!movable.length) return out;
    const i = movable[randInt(0, movable.length - 1)];
    if (chance(0.5) && out.length > 3) {
      /* drop one hit so the bar breathes */
      out.splice(i, 1);
    } else {
      /* nudge one hit a step, avoiding collisions */
      const dir = chance(0.5) ? 1 : -1;
      const to = out[i][0] + dir;
      const slots = out.map((p) => p[0]);
      if (to >= 0 && to < 16 && slots.indexOf(to) === -1) out[i][0] = to;
    }
    return out;
  }

  _makeArp(bar, sec, cur) {
    if (!sec.arp || sec.arp < 0.02) return [];
    const song = this.song;
    /* Build a two-octave pool: the chord tones in the low octave and the same
       tones repeated an octave up. A single narrow octave meant every bar was
       the same few pitches reordered, which is what made successive phrases
       sound alike even once the rhythm varied. */
    const chordPool = [];
    for (const n of cur.voicing) {
      /* Keep the original octave placement (voices sit above middle C) and
         additionally carry each tone up an octave, so lines can travel two
         octaves instead of circling one narrow band. */
      const base = n + 12 >= 58 && n + 12 <= 74 ? n + 12 : n;
      if (base >= 58 && base <= 74) chordPool.push(base);
    }
    if (chordPool.length < 3) return [];
    chordPool.sort((a, b) => a - b);
    const pool = chordPool.slice();
    for (const n of chordPool) {
      if (n + 12 <= 88) pool.push(n + 12);
    }
    const scalePcs = (SCALES[sec.scale || song.scale] || SCALES.major)
      .map((i) => mod12(song.root + i));
    const shapes = [
      [[2, 0], [6, 1], [10, 2], [14, 1]],
      [[0, 1], [4, 2], [8, 1], [12, 0]],
      [[2, 2], [7, 1], [10, 0], [14, 2]],
      [[3, 0], [6, 2], [11, 1], [14, 1]],
      [[0, 2], [3, 1], [7, 2], [10, 0], [13, 1]],
      [[2, 1], [5, 0], [9, 2], [12, 1], [15, 2]],
      [[4, 0], [8, 2], [12, 1]],
      [[1, 2], [6, 0], [9, 1], [13, 2]]
    ];
    /* Draw a shape rather than cycling a fixed formula, and never play the
       same shape two bars running: a modulo cycle made every fourth bar an
       exact copy of the last. */
    const prevShape = this._arpShape;
    let shapeIdx = randInt(0, shapes.length - 1);
    if (shapeIdx === prevShape) shapeIdx = (shapeIdx + 1 + randInt(0, shapes.length - 2)) % shapes.length;
    this._arpShape = shapeIdx;
    const shape = shapes[shapeIdx];
    /* Walk through the chord tones instead of toggling two neighbouring notes
       on a bar%2 wobble, which left the line stuck on three or four pitches. */
    const offset = randInt(0, chordPool.length - 1);
    const out = [];
    for (const [step, pickIdx] of shape) {
      if (chance(song.lofi ? 0.32 : 0.12)) continue;
      let midi = pool[Math.min(pool.length - 1, offset + pickIdx)];
      /* Passing tone: sometimes approach the note by a scale step so a phrase
         reads as melody rather than an arpeggio of the same three or four
         notes. Jazz chords are often 9ths and 13ths that already cover most
         of the scale, so this steps to any neighbouring scale tone rather
         than filtering for non-chord tones (which almost never qualified). */
      if (chance(song.lofi ? 0.16 : 0.38)) {
        const cand = midi + (chance(0.5) ? 1 : -1);
        if (cand >= 58 && cand <= 88 && scalePcs.indexOf(mod12(cand)) !== -1) {
          midi = cand;
        }
      }
      out.push({
        step,
        midi,
        dur: step === 0 ? 5 : 3,
        vel: rand(song.lofi ? 0.1 : 0.14, song.lofi ? 0.18 : 0.24) * (step === 0 ? 1.15 : 1)
      });
    }

    /* Call-and-response when the lead rests. */
    if (!this.melodyEvents.length && this._lastMelodyBar === bar - 1 && sec.energy > 0.25) {
      const answerBase = song.motifs[1];
      const answer = (answerBase.variants && answerBase.variants.diminish) || answerBase;
      const count = Math.min(song.lofi ? 2 : 3, answer.rhythm.length);
      const offset = bar % 2 === 0 ? 0 : 2;
      for (let i = 0; i < count; i++) {
        const at = 6 + i * 3 + offset;
        if (at > 14) break;
        const midi = snapToChord(pool[(i + 1) % pool.length] + offset, cur.chordPcs, 2);
        out.push({
          step: at,
          midi,
          dur: 2,
          vel: rand(0.09, 0.15) * (0.8 + sec.energy * 0.4)
        });
      }
    }
    return out;
  }

  /* ---------- free-time piano ---------- */
  /* A few wide, soft events placed off the grid. Lofi moods stay low and
     pedal-heavy; jazz gets one extra note of movement. */
  _makeRubato(bar, sec, cur) {
    const song = this.song;
    const lofi = song.lofi;
    const lyrical = !!song.wanderMelody;
    const beat = this.stepDur * 4;
    const pos = bar - sec.start;
    const gain = song.rubato ? song.rubato.gain : 1;
    const rootMidi = 36 + mod12(cur.rootPc - 36);
    const notes = cur.voicing.slice();
    const out = [];
    const count = lofi ? (pos === 0 ? 2 : randInt(2, 3)) : lyrical ? randInt(3, 5) : randInt(2, 4);
    let cursor = rand(-0.05, 0.08);

    for (let i = 0; i < count; i++) {
      if (i > 0) cursor += rand(0.9, 1.7);
      if (cursor > 3.3) break;
      let eventNotes;
      let vel;
      let dur;
      if (i === 0) {
        eventNotes = (chance(0.55) ? [rootMidi] : []).concat(notes);
        vel = 0.50;
        dur = beat * rand(1.8, 2.6);
      } else if (i === 1) {
        eventNotes = notes.slice(-2);
        vel = 0.34;
        dur = beat * rand(1.2, 2.0);
      } else {
        const top = notes[notes.length - 1] + (chance(0.4) ? 12 : 0);
        if (lyrical && chance(0.6)) {
          eventNotes = [top + pick([2, 5, 7, 9])];
        } else {
          eventNotes = chance(0.5) ? [top] : [top, top - 7];
        }
        vel = 0.22;
        dur = beat * rand(1.0, 1.6);
      }
      eventNotes = eventNotes
        .map((n) => {
          let m = n;
          while (m < 33) m += 12;
          while (m > 86) m -= 12;
          return m;
        })
        .filter((n, idx, arr) => arr.indexOf(n) === idx);
      out.push({
        at: Math.max(0, cursor) * beat + rand(-0.02, 0.03),
        notes: eventNotes,
        dur,
        vel: vel * gain * rand(0.9, 1.05)
      });
    }
    return out;
  }

  /* ---------- bass line ---------- */
  /* Walking lines are precomputed per bar. Jazz walks most songs; lofi moods
     only walk the bar before a phrase turns. */
  _makeBass(bar, sec, cur) {
    const song = this.song;
    const plan = song.bassPlan;
    if (!plan || !plan.walk) return null;
    if (plan.scope !== 'always') {
      const phraseLen = Math.max(2, sec.phraseLen || 8);
      const pos = bar - sec.start;
      if (pos % phraseLen !== phraseLen - 1) return null;
    }
    const rootMidi = 36 + mod12(cur.rootPc - 36);
    const nextChord = song.chords[(bar + 1) % song.chords.length];
    const nextRootPc = mod12(song.root + nextChord[0]);
    /* the approach always resolves to the next root in the same register,
       so the seam between bars stays stepwise */
    const target = 36 + mod12(nextRootPc - 36);
    const scalePcs = SCALES[sec.scale || song.scale].map((i) => mod12(song.root + i));
    const ivs = CHORDS[cur.chord[1]] || CHORDS.m7;
    const third = chordThird(cur.chord[1]);
    const thirdTone = bassChordTone(rootMidi, third);
    const fifthTone = rootMidi + 7;
    const seventh = ivs.indexOf(11) !== -1 ? 11 : 10;
    const level = plan.scope === 'always' ? 0.82 : 0.68;
    const out = [];

    if (plan.sparse) {
      out.push({ beat: 0, midi: rootMidi, dur: 3.8, vel: level });
      out.push({
        beat: 2,
        midi: chance(0.6) ? fifthTone : thirdTone,
        dur: 2.6,
        vel: level * 0.8
      });
      return out;
    }

    const first = chance(0.16) ? fifthTone : rootMidi;
    out.push({ beat: 0, midi: first, dur: 3.6, vel: level });

    let second;
    const r1 = _rng();
    if (r1 < 0.58) second = thirdTone;
    else if (r1 < 0.84) second = fifthTone;
    else second = bassChordTone(rootMidi, seventh);
    if (second === first) second = thirdTone === first ? fifthTone : thirdTone;
    out.push({ beat: 1, midi: second, dur: 3.4, vel: level * 0.94 });

    let inner;
    const r2 = _rng();
    if (r2 < 0.50) inner = fifthTone;
    else if (r2 < 0.72) inner = bassChordTone(rootMidi, seventh);
    else inner = scaleNeighbor(fifthTone, scalePcs, chance(0.5) ? -1 : 1);
    if (inner === second) inner = inner === fifthTone ? thirdTone : fifthTone;
    out.push({ beat: 2, midi: inner, dur: 3.4, vel: level * 0.92 });

    out.push({
      beat: 3,
      midi: bassApproach(target, inner, scalePcs, plan.style || 'diatonic'),
      dur: 3.2,
      vel: level * 0.98
    });

    for (const ev of out) {
      while (ev.midi < 33) ev.midi += 12;
      while (ev.midi > 55) ev.midi -= 12;
    }
    return out;
  }

  /* ---------- melody ---------- */
  _phraseDynamics(bar, sec) {
    const span = Math.max(1, sec.end - sec.start);
    const p = clamp((bar - sec.start) / span, 0, 1);
    const human = this.song.human ? this.song.human.dynamics : 1;
    return (0.9 + 0.2 * Math.sin(Math.PI * Math.min(1, p * 1.12))) * human;
  }

  _makeMelody(bar, sec, cur) {
    if (!sec.melody) return [];
    if (this.song.wanderMelody) return this._makeWanderingMelody(bar, sec, cur);
    const lb = (bar - sec.start) % 8;
    const lofi = this.song.lofi;
    const key = sec.hook
      ? (lofi ? 'medium' : 'full')
      : lofi
        ? (sec.melody >= 0.7 ? 'medium' : 'sparse')
        : sec.melody >= 0.8 ? 'full' : sec.melody >= 0.45 ? 'medium' : 'sparse';
    const plan = (this.song.mood.melodyPlans || this.melodyPlans)[key];
    const code = plan[lb];
    if (code === null || code === undefined) return [];

    const pair = this.song.motifs;
    const isAnswer = code >= 1;
    const base = isAnswer ? pair[1] : pair[0];
    const variants = base.variants || { prime: base };
    const phrase = Math.floor((bar - sec.start) / 8);
    let op = 'prime';

    if (lofi) {
      if (sec.hook) op = isAnswer ? 'lift' : 'prime';
      else if (isAnswer) op = chance(0.2) ? 'answer' : 'prime';
      else if (code === 0.5) op = chance(0.25) ? 'diminish' : 'prime';
    } else if (sec.hook) {
      op = isAnswer ? 'lift' : 'prime';
    } else if (code === 0.5) {
      op = pick(['invert', 'retro', 'diminish', 'augment', 'drop']);
    } else if (isAnswer) {
      op = chance(sec.energy > 0.7 ? 0.5 : 0.25) ? 'lift' : 'prime';
    } else if (phrase % 2 === 1) {
      op = chance(sec.energy > 0.6 ? 0.55 : 0.3) ? 'invert' : 'prime';
    }

    const motif = variants[op] || base;
    const inst = this.song.leadBySection[sec.idx] || (this.song.trio ? 'pianoNatural' : 'vibes');
    return this._realizeMotif(motif, sec, cur, inst, isAnswer, this._phraseDynamics(bar, sec));
  }

  /* Through-composed piano lines: longer notes, wider arcs, chromatic
     pickups and a little air between phrases. */
  _makeWanderingMelody(bar, sec, cur) {
    const song = this.song;
    const lofi = song.lofi;
    if (!sec.melody || sec.melody < 0.28) return [];
    /* the very first phrase of the song sets the line, so keep it audible
       rather than letting the arrangement intro mute it */
    if (bar === sec.start && bar === 0) {
      const first = sec.arrange && sec.arrange[0];
      if (first && first.melody < 0.3) return [];
    }
    const lb = (bar - sec.start) % 8;
    const firstBar = bar === sec.start;
    const restChance = sec.kind === 'break' ? 0.58 : (lb === 4 || lb === 6 ? 0.34 : 0.16);
    if (!firstBar && chance(restChance)) return [];

    const shift = clamp((song.melodyShift || 0) + (sec.registerOffset || 0), -7, 7);
    const scalePcs = SCALES[sec.scale || song.scale].map((i) => mod12(song.root + i));
    const ladder = [];
    for (let m = 56 + shift; m <= 87 + shift; m++) {
      if (scalePcs.indexOf(mod12(m)) !== -1) ladder.push(m);
    }
    if (ladder.length < 10) return [];

    let prevMidi = clamp(this.lastMelody || 73 + shift, ladder[2], ladder[ladder.length - 3]);
    let idx = 0;
    let best = Infinity;
    for (let i = 0; i < ladder.length; i++) {
      const d = Math.abs(ladder[i] - prevMidi);
      if (d < best) { best = d; idx = i; }
    }
    /* Give each phrase a gentle destination so the line has an arc instead
       of wandering until it falls off the ladder. */
    const phraseIdx = Math.floor((bar - sec.start) / 8);
    const phraseTarget = [0, 2, -1, 3, -2, 1][phraseIdx % 6];
    const targetIdx = clamp(idx + phraseTarget, 2, ladder.length - 3);

    const rhythm = pick(this.song.mood.wanderRhythms || this.wanderRhythms).map((r) => r.slice());
    const out = [];
    let dir = chance(0.55) ? 1 : -1;
    let run = 0;
    const lastNote = rhythm.length - 1;
    const dyn = this._phraseDynamics(bar, sec);
    const human = song.human ? song.human.velocity : 1;
    const energy = 0.85 + (sec.energy || 0.5) * (lofi ? 0.18 : 0.25);

    for (let i = 0; i < rhythm.length; i++) {
      const step = rhythm[i][0];
      const dur = clamp(rhythm[i][1], 1, Math.max(1, 15 - step));
      if (i > 0) {
        const roll = _rng();
        let move;
        if (roll < 0.30) move = dir;
        else if (roll < 0.52) move = -dir;
        else if (roll < 0.72) move = dir * 2;
        else if (roll < 0.88) move = dir * 3;
        else {
          move = -dir * (chance(0.35) ? 2 : 1);
          dir = -dir;
          run = 0;
        }
        if (run >= 3) {
          move = -dir * 2;
          dir = -dir;
          run = 0;
        }
        /* if the line has drifted away from the phrase target, steer it
           back with a stepwise move instead of a sudden leap */
        const pull = targetIdx - idx;
        if (Math.abs(pull) > 4) move = Math.sign(pull) * Math.min(3, Math.abs(pull));
        run = Math.sign(move) === dir ? run + 1 : 1;
        idx = clamp(idx + move, 1, ladder.length - 2);
        if (idx > targetIdx + 5) dir = -1;
        else if (idx < targetIdx - 5) dir = 1;
      }
      let midi = ladder[idx];
      const strong = step === 0 || step === 4 || step === 8 || step === 12 || i === lastNote;
      /* notes that ring over the bar line resolve into the next chord */
      const carry = step + dur >= 15 || (i === lastNote && step >= 8);
      const pcs = carry && cur.nextChordPcs ? cur.nextChordPcs : cur.chordPcs;
      if (strong || carry) {
        const snapped = snapToChord(midi, pcs, 2);
        /* chord tones win on a change, even when they are a colour tone
           outside the scale (a 13th or a flat ninth, for example) */
        if (carry || scalePcs.indexOf(mod12(snapped)) !== -1) midi = snapped;
      }
      if (out.length && out[out.length - 1].midi === midi) {
        idx = clamp(idx + (prevMidi >= midi ? 1 : -1), 1, ladder.length - 2);
        midi = ladder[idx];
      }
      /* keep the line from jumping a whole octave and then recovering */
      let guard = 0;
      while (out.length && Math.abs(midi - prevMidi) > 9 && guard++ < 12) {
        idx += midi > prevMidi ? -1 : 1;
        idx = clamp(idx, 1, ladder.length - 2);
        midi = ladder[idx];
      }
      /* the register guard must not undo a resolution into the next chord */
      if (carry) midi = snapToChord(midi, pcs, 2);

      const base = i === 0 ? 0.80 : i === lastNote ? 0.66 : strong ? 0.72 : 0.62;
      const reach = midi >= prevMidi ? 1.03 : 0.97;
      const vel = clamp(base * reach * rand(0.92, 1.06) * dyn * energy * human, 0.12, 1.12);

      /* a chromatic pickup into a strong beat, used sparingly */
      if (i > 0 && strong && step > 0 && chance(0.12) && out[out.length - 1].step < step - 1) {
        const approach = midi + (dir > 0 ? -1 : 1);
        if (approach !== prevMidi) {
          out.push({
            step: step - 1,
            midi: approach,
            dur: 1,
            vel: vel * 0.45
          });
        }
      }
      out.push({ step, midi, dur, vel });
      prevMidi = midi;
    }
    if (out.length) this.lastMelody = out[out.length - 1].midi;
    return out;
  }

  _realizeMotif(motif, sec, cur, inst, isAnswer, dyn) {
    const song = this.song;
    const mood = song.mood;
    const shift = clamp(
      (song.melodyShift || mood.melodyShift || 0) + (sec.registerOffset || 0),
      -7, 7
    ) + (inst === 'guitar' ? -12 : 0);
    const scalePcs = SCALES[sec.scale || song.scale].map((i) => mod12(song.root + i));
    const ladder = [];
    for (let m = 57 + shift; m <= 88 + shift; m++) if (scalePcs.indexOf(mod12(m)) !== -1) ladder.push(m);
    if (ladder.length < 8) return [];

    const contour = motif.contour;
    let cmin = 0, cmax = 0;
    for (let i = 0; i < motif.rhythm.length; i++) {
      const d = contour[i] || 0;
      if (d < cmin) cmin = d;
      if (d > cmax) cmax = d;
    }

    let startIdx = 0;
    let bestD = Infinity;
    for (let i = 0; i < ladder.length; i++) {
      const d = Math.abs(ladder[i] - this.lastMelody);
      if (d < bestD) { bestD = d; startIdx = i; }
    }
    /* keep the whole phrase inside the ladder and in a comfortable register */
    startIdx = clamp(startIdx, 1 - cmin, ladder.length - 2 - cmax);
    startIdx = clamp(startIdx, 4, ladder.length - 4);

    const accent = sec.hook
      ? (song.lofi ? (isAnswer ? 1.08 : 1.03) : (isAnswer ? 1.16 : 1.08))
      : isAnswer ? 1.04 : 1;
    const energy = 0.85 + (sec.energy || 0.5) * (song.lofi ? 0.18 : 0.25);
    const human = song.human ? song.human.velocity : 1;
    const velDyn = clamp((dyn || 1) * accent * energy * human, 0.2, 1.15);

    const out = [];
    const lastI = motif.rhythm.length - 1;
    let prevIdx = startIdx;
    for (let i = 0; i < motif.rhythm.length; i++) {
      const rh = motif.rhythm[i];
      let idx = clamp(startIdx + (contour[i] || 0), 1, ladder.length - 2);
      /* Keep the line within a comfortable interval of the note we just
         played. Contours still shape the phrase, but a lift or inversion
         can no longer throw it up or down an octave. */
      if (i === 0) idx = clamp(idx, prevIdx - 2, prevIdx + 3);
      else idx = clamp(idx, prevIdx - 4, prevIdx + 4);
      let midi = ladder[idx];
      const dur = clamp(rh[1], 1, 16 - rh[0]);
      const strong = rh[0] === 0 || rh[0] === 8 || i === lastI;
      /* A note that rings over the bar line, or ends the phrase, leans into
         the next chord rather than colliding with it. */
      const carry = rh[0] + dur >= 15 || (i === lastI && rh[0] >= 8);
      const pcs = carry && cur.nextChordPcs ? cur.nextChordPcs : cur.chordPcs;
      if (rh[0] === 0 || i === lastI || carry) midi = snapToChord(midi, pcs, 2);
      else if (rh[0] === 8) midi = snapToChord(midi, pcs, 1);

      if (out.length >= 2 && out[out.length - 1].midi === midi && out[out.length - 2].midi === midi) {
        midi = ladder[clamp(idx + (idx < ladder.length - 2 ? 1 : -1), 1, ladder.length - 2)];
      }
      /* If snapping still produced a leap larger than a sixth, pull it back
         toward the previous note instead of letting the register jump. */
      if (out.length && Math.abs(midi - out[out.length - 1].midi) > 9) {
        const prev = out[out.length - 1].midi;
        midi = snapToChord(prev + Math.sign(midi - prev) * 7, pcs, 2);
      }
      if (carry) midi = snapToChord(midi, pcs, 2);

      /* a short chromatic pickup into a strong beat, used sparingly */
      const prior = out[out.length - 1];
      if (i > 0 && strong && rh[0] > 1 && (!prior || prior.step < rh[0] - 1) && chance(0.16)) {
        const approach = midi + (midi >= prior.midi ? -1 : 1);
        out.push({ step: rh[0] - 1, midi: approach, dur: 1, vel: velDyn * 0.42 });
      }

      out.push({
        step: rh[0],
        midi,
        dur,
        vel: (rh[0] === 0 ? 0.82 : rh[0] === 8 ? 0.72 : 0.62) * rand(0.92, 1.05) * velDyn
      });

      let nextIdx = prevIdx;
      for (let j = 0; j < ladder.length; j++) if (ladder[j] <= midi) nextIdx = j;
      prevIdx = nextIdx;
    }
    if (out.length) this.lastMelody = out[out.length - 1].midi;
    return out;
  }

  /* ---------- scheduler ---------- */
  setLookahead(seconds) {
    this.lookahead = Math.max(0.18, seconds);
    if (this.playing) this._tick();
  }

  _tick() {
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    if (this.nextTime < now - 0.2) {
      /* The queued music ran out. In a hidden tab that usually means the
         timer callback was held back for several seconds; widen the hidden
         buffer so the next late callback cannot cut another hole. */
      if (this.isHidden()) {
        this.hiddenLookahead = Math.min(
          this.maxHiddenLookahead,
          Math.max(this.hiddenLookahead, this.hiddenLookahead + 5)
        );
        this.lookahead = this.hiddenLookahead;
        if (this.debug) {
          console.info(
            '[jazz-song-engine] scheduler late by ' + (now - this.nextTime).toFixed(2) +
            's; hidden lookahead now ' + this.hiddenLookahead + 's'
          );
        }
      }
      this.nextTime = now + 0.05;
    }
    const ahead = this.lookahead || this.visibleLookahead;
    while (this.nextTime < now + ahead) {
      if (this._advanceIfNeeded()) continue;
      /* every node a step creates is retired once it has certainly finished,
         so the graph cannot grow for the whole session */
      this._capture = [];
      try {
        this._scheduleStep(this.songStep, this.nextTime);
      } finally {
        this._retireNodes();
      }
      this.nextTime += this.stepDur;
      this.songStep++;
    }
    this._sweepNodes(now);
  }

  /* Returns true when the scheduler should not emit a step at nextTime
     (the song just jumped to the end of a ringing tail). */
  _advanceIfNeeded() {
    if (this.pendingMood && this.songStep % 16 === 0) {
      this.moodKey = this.pendingMood;
      this.pendingMood = null;
      this._newSong(undefined, undefined, this.nextTime);
      this.songStep = 0;
      this.songStartTime = this.nextTime;
      return false;
    }
    if (this.songStep >= this.song.totalBars * 16) {
      if (this._tailUntil) {
        if (this.nextTime < this._tailUntil) {
          this.nextTime = this._tailUntil;
          return true;
        }
        this._tailUntil = 0;
      } else {
        this._capture = [];
        let tail = 0;
        try {
          tail = this._holdEnding(this.nextTime);
        } finally {
          this._retireNodes();
        }
        if (tail > 0) {
          this._tailUntil = this.nextTime + tail;
          this.nextTime = this._tailUntil;
          return true;
        }
      }
      this._newSong(undefined, undefined, this.nextTime);
      this.songStep = 0;
      this.songStartTime = this.nextTime;
    }
    return false;
  }

  /* Some songs end on a chord left to ring while the band fades away. The
     ambience (rain, vinyl, room tone) keeps running through the fade, so the
     next song rises out of it instead of starting on a hard cut. */
  _holdEnding(time) {
    const song = this.song;
    const mood = song.mood;
    const cur = this.cur;
    const roll = mood.endingHold || 0;
    if (!cur || !cur.voicing || !cur.voicing.length || !roll || !chance(roll)) return 0;

    const tail = rand(3.0, 4.4);
    const hold = tail * 0.45;
    const release = Math.max(1.0, tail - hold);
    const notes = cur.voicing;
    const inst = (song.palette && song.palette.keys) || 'ep';
    const natural = inst === 'pianoNatural' || inst === 'piano';
    let played = false;

    if (this.samples.isReady()) {
      for (let i = 0; i < notes.length; i++) {
        const pan = notes.length > 1 ? (i / (notes.length - 1) - 0.5) * 0.12 : 0;
        if (this._sample(inst, notes[i], time + i * 0.012, hold,
          0.30 * (1 - i * 0.05), this.keysTone, {
            pan,
            detune: rand(-2, 2),
            attack: natural ? 0.0025 : 0.012,
            release,
            haas: natural ? 0.008 : undefined,
            haasGain: 0.18
          })) played = true;
      }
      const bassInst = song.palette && song.palette.bass;
      if (bassInst) {
        const rootMidi = 36 + mod12(cur.rootPc - 36);
        this._sample(bassInst, rootMidi, time, hold, 0.34, this.bassTone, {
          attack: 0.008, release
        });
      }
    }
    if (!played) this._keys(notes, time, hold, 0.30);

    /* fade the band out under the ringing chord, finishing a little before
       the next song so its levels rise back up smoothly */
    const fadeStart = time + hold * 0.8;
    const fadeEnd = time + Math.max(1.0, tail - 0.5);
    const buses = [
      this.keysBus, this.bassBus, this.padBus, this.drumBus,
      this.melBus, this.arpBus, this.percBus
    ];
    for (const bus of buses) {
      const gain = bus.gain;
      const level = Math.max(0.0001, gain.value);
      gain.cancelScheduledValues(time);
      gain.setValueAtTime(level, time);
      gain.setValueAtTime(level, fadeStart);
      gain.exponentialRampToValueAtTime(0.0001, fadeEnd);
    }
    return tail;
  }

  _retireNodes() {
    const nodes = this._capture;
    this._capture = null;
    if (!nodes || !nodes.length) return;
    const at = Math.max(this.ctx.currentTime, this.nextTime) + 9;
    this._retired.push({ at, nodes });
  }

  _sweepNodes(now) {
    const list = this._retired;
    let i = 0;
    while (i < list.length && list[i].at <= now) {
      const nodes = list[i++].nodes;
      for (let j = 0; j < nodes.length; j++) {
        const node = nodes[j];
        try { node.disconnect(); } catch (e) {}
        if (typeof node.stop === 'function') {
          try { node.stop(); } catch (e) {}
        }
        this.voices.delete(node);
      }
    }
    if (i) list.splice(0, i);
  }

  _scheduleStep(step, time) {
    const song = this.song;
    const mood = song.mood;
    const bar = Math.floor(step / 16);
    const s = step % 16;
    if (s === 0) this._prepareBar(bar);
    const cur = this.cur;
    if (!cur) return;

    const sec = cur.sec;
    const human = song.human || { timing: 0.006 };
    const dyn = this._phraseDynamics(bar, sec);
    const t = time + (s % 2 ? this.stepDur * song.swing : 0);
    /* the per-bar arrangement decides which layers are present right now */
    const arr = sec.arrange && sec.arrange[bar - sec.start] ? sec.arrange[bar - sec.start] : null;
    const aHat = arr ? arr.hat : 1;
    const aPerc = arr ? arr.perc : 1;
    const aKeys = arr ? arr.keys : 1;
    const aBass = arr ? arr.bass : 1;
    const aMel = arr ? arr.melody : 1;
    const aArp = arr ? arr.arp : 1;
    const aPad = arr ? arr.pad : 1;
    const aPadSwell = arr && arr.padSwell !== undefined ? arr.padSwell : 1;
    const aSwell = arr && arr.swell !== undefined ? arr.swell : 1;
    const dp = sec.rubato ? 0 : sec.drums * (arr ? arr.drums : 1);
    const dv = dp * dyn;

    /* ---- drums ---- */
    if (dp > 0.02) {
      const ds = song.drumStyle || {};
      const second = Math.floor(bar / song.drumPats.switchBars) % 2 === 1;
      const kp = second ? song.drumPats.kickB : song.drumPats.kickA;
      const sp = second ? song.drumPats.snareB : song.drumPats.snareA;
      const hp = second ? song.drumPats.hatB : song.drumPats.hatA;
      const kickLevel = ds.kickVel === undefined ? 1 : ds.kickVel;
      /* a slow 3/4 feel: the bar turns on beats 1, 2 and 3 */
      const waltz = !!song.waltz;
      const snareHere = waltz ? (s > 0 && s % 6 === 4) : !!(sp[s] && sp[s] !== '.');

      if (kp[s] === 'x' || (waltz && s === 0)) {
        this._kick(t + rand(-0.002, 0.003), 0.95 * kickLevel * dv * rand(0.92, 1.04));
      }

      /* Does a brush dig occupy this step? The brush lanes and the backbeat
         are planned independently, so on brushBackbeat and waltz kits a dig
         and a backbeat dig fired together, 3 ms apart, from the same samples.
         Two of those read as one harder, doubled scrape. The dig is the fuller
         gesture, so it carries the step and the snare yields to it. The brush
         block below uses the same flag, so the two can never disagree. */
      const digOwnsStep = !!ds.brush && song.drumPats.brushSteps.indexOf(s) !== -1
        && (!(sp[s] && sp[s] !== '.') || !ds.snareBrush);

      if (snareHere) {
        const snareAt = t + rand(-0.003, 0.004);
        if (!digOwnsStep) {
          /* On a brush transition, don't put a stick backbeat under the
             brush pickup. From the transition step on, a non-brushed kit
             plays the same brush dig as its regular brush lane. */
          const brushTransition = !!this.isTransitionBar && s >= 8
            && !!ds.brush && !ds.snareBrush;
          if (brushTransition) {
            this._brush(snareAt, 0.44 * dv * 0.9, true, false);
          } else {
            this._snare(
              snareAt,
              (waltz ? 0.45 : sp[s] === 'x' ? 0.88 : 0.45) * dv * rand(0.92, 1.04),
              !!ds.snareBrush
            );
          }
        }
      }

      if (ds.ride) {
        const rideSteps = song.drumPats.rideSteps || [0, 2, 4, 6, 8, 10, 12, 14];
        if (rideSteps.indexOf(s) !== -1) {
          const accent = song.drumPats.rideAccents.indexOf(s) !== -1 ? 0.72 : 0.42;
          this._ride(t + rand(-0.002, 0.004), accent * dv * rand(0.9, 1.08));
        } else if (s % 2 === 1 && sec.energy > 0.55 && chance(0.25 + sec.energy * 0.25)) {
          /* jazz keeps a little more motion on the offbeats when the band lifts */
          this._ride(t + rand(-0.003, 0.005), 0.3 * dv * rand(0.85, 1.05));
        }
        /* some songs get a sampled open-hat lift at the end of a phrase */
        if (song.hatAccent && s === 14 && bar % 8 === 7 && chance(0.72)) {
          this._hat(t + rand(-0.003, 0.004), 0.19 * dv * aHat * rand(0.9, 1.1), true, {
            gain: 0.32, pan: 0.22, rate: rand(0.95, 1.05), lp: 9800, fade: 0.46
          });
        }
      } else if (ds.hat) {
        if (waltz) {
          if (s % 3 === 0) this._hat(t + rand(-0.003, 0.004), 0.2 * dv * aHat * rand(0.85, 1.05), false);
        } else {
          const mark = hp[s];
          if (mark && mark !== '.') {
            const hv = (mark === 'x' ? song.drumPats.hatVel : song.drumPats.hatVel * 0.45) * dv * aHat * rand(0.78, 1.05);
            if (hv > 0.01) this._hat(t + rand(-0.003, 0.004), hv, false);
          }
        }
        if (song.hatAccent && s === 14 && bar % 8 === 7 && chance(0.72)) {
          this._hat(t + rand(-0.002, 0.004), 0.18 * dv * aHat * rand(0.9, 1.1), true, {
            gain: 0.30, pan: 0.2, rate: rand(0.95, 1.05), lp: 9800, fade: 0.42
          });
        }
      }

      /* Brushes: a few accented strokes over the swing, or a continuous
         swirl that blurs the eighths into one soft wash. */
      if (digOwnsStep) {
        this._brush(t + rand(-0.004, 0.005), 0.44 * dv, true, false);
      }
      if (ds.swirl && s % 2 === 0 && !(sp[s] && sp[s] !== '.')) {
        /* A brush swirl is one continuous circular stroke, not eight separate
           hits: offsetting every even eighth by a fixed swing gave identical
           337 ms gaps at 89 BPM, which read as a metronome. Each stroke now
           leans with a short deterministic drift, rides a bar-sized pressure
           arc, and picks its own take, so the back and forth breathes. The
           lean is shared by every bar of the same step (playing a song again
           gives back the same looseness) but always lands a little late, never
           early, so the drums never run ahead of the comp. */
        const plan = this._brushStroke(s, bar);
        /* the swirl sits ~4 dB back so it reads as motion under the kit */
        this._brush(
          t + plan.late + rand(-0.002, 0.002),
          0.22 * dv * plan.accent * rand(0.9, 1.1),
          plan.dig,
          true,
          plan.opts
        );
      }

      /* ghost notes sit under the beat and give it a human push */
      if (!ds.ride && ds.ghost > 0 && !snareHere && (s === 7 || s === 15) && chance(song.drumPats.ghostChance)) {
        this._ghost(t + rand(-0.006, 0.005), ds.ghost * dv * rand(0.7, 1.15));
      }

      /* a little percussion layer: shaker on the offbeats, rim on the turnarounds */
      if (sec.perc * aPerc > 0.02 && s % 4 === 2 && chance(0.72)) {
        this._shaker(t + rand(-0.005, 0.006), sec.perc * aPerc * dv * rand(0.55, 0.9));
      }
      if (sec.perc * aPerc > 0.2 && s === 7 && bar % 2 === 1 && chance(0.3)) {
        this._rim(t + rand(-0.004, 0.004), sec.perc * aPerc * dv * 0.4);
      }

      /* A bar that also carries a section pickup is already busy; adding the
         regular fill on top doubles the tom hits and sounds like a roll. */
      if (this.isFillBar && !this.isTransitionBar && sec.energy > (song.lofi ? 0.4 : 0.3) && s >= 12) {
        const fv = (0.16 + (s - 12) * 0.08) * dv * (song.lofi ? 0.7 : 1);
        if (s === 12) this._tom(t, fv * 0.9, false);
        else if (s === 14) this._tom(t, fv * 0.85, true);
        /* The swirl is already stroking on the offbeat steps; a fill stroke
           there would land 40 ms after one and bunch the wash into a burst. */
        else if (ds.swirl) { /* the swirl carries this step */ }
        else if (ds.snareBrush || ds.brush) this._brush(t, fv, true);
        else this._snare(t, fv, false);
      }

      /* dusty, slightly late backbeat under the main kit */
      if (song.backbeat && dp > 0.3) {
        const bb = song.backbeat;
        const bt = t + this.stepDur * 0.035;
        /* the dusty doubled layer gets its own small weight change so it
           never lands as an identical copy of the main hit */
        const bg = bb.gain * dv * rand(0.94, 1.06);
        if (bb.kick[s] === 'x') {
          if (!this._drumSample('kick', bt + rand(-0.003, 0.002), bg, { gain: 0.7, lp: 3200 })) {
            this._kick(bt, bg * 0.6);
          }
        }
        if (bb.snare[s] === 'x') {
          if (!this._drumSample('snare', bt + rand(-0.004, 0.003), bg, { gain: 0.6, lp: 6000 })) {
            this._snare(bt, bg * 0.55, false);
          }
        } else if (bb.snare[s] === 'o') {
          this._ghost(bt, bg * 0.55);
        }
        if (bb.hat[s] === 'x') {
          const hv = bg * aHat;
          if (!this._drumSample('hat', bt + rand(-0.003, 0.003), hv, { gain: 0.34, lp: 8000, rate: 0.94 })) {
            this._hat(bt, hv * 0.5, false, { rate: 0.94, lp: 8000 });
          }
        }
      }
    }

    /* ---- chord comping ---- */
    const keysAmt = sec.keys * aKeys;
    if (keysAmt > 0.001 && !sec.rubato) {
      const plan = song.compPlan || {};
      const phrase = Math.max(2, sec.phraseLen || 8);
      const useB = song.keyPatB && Math.floor((bar - sec.start) / phrase) % 2 === 1;
      const pat = (cur.keyPat && cur.keyPat.length) ? cur.keyPat
        : useB ? song.keyPatB : song.keyPat;
      const kt = t + rand(0, human.timing);
      /* Under a through-composed piano line the comp yields: no full chord
         lands with a melody attack, a held note only gets the top pair, and
         a skipped hit answers a step later where the bar is free. */
      const melOn = new Set();
      if (song.wanderMelody) {
        for (const ev of this.melodyEvents) {
          for (let k = 0; k < ev.dur; k++) melOn.add((ev.step + k) % 16);
        }
      }
      const singing = song.wanderMelody && melOn.size > 0;
      const melodyAt = (step) => !!(this.melodySteps && this.melodySteps.has(step));
      const patSteps = pat.map((p) => p[0]);
      for (let i = 0; i < pat.length; i++) {
        const at = pat[i][0];
        if (at !== s) continue;
        /* thin out the weaker hits so the comp breathes; syncopated styles
           keep more of their offbeat answers */
        if (at !== 0 && plan.drop && chance(plan.drop * (plan.syncopated ? 0.55 : 1))) continue;
        const accent = at === 0 ? 1.0 : (plan.syncopated ? 0.86 : 0.55);
        const under = melodyAt(s) ? (plan.underMelody || 1) : 1;
        const vel = accent * keysAmt * rand(0.9, 1.03) * dyn *
          (plan.intensity || 1) * (plan.vel || 1) * under;
        const dur = this.stepDur * pat[i][1] * (plan.short ? 0.8 : 1);
        let notes = mood.jazz && !song.rootlessVoicings ? cur.voicing.slice(1) : cur.voicing;
        /* Rain's long chords get a softer upper-structure answer on later
           hits so the harmony changes colour without changing chord. */
        if (plan.revoice && i > 0 && notes.length > 3) notes = notes.slice(-3);
        if (singing && at !== 0 && melOn.has(at)) {
          if (melodyAt(at)) {
            const answerAt = at + 1;
            const free = answerAt < 16 && !melOn.has(answerAt) && patSteps.indexOf(answerAt) === -1;
            if (free && notes.length >= 2) {
              this._keys(notes.slice(-2), kt + this.stepDur, this.stepDur * 2, vel * 0.7);
            }
            continue;
          }
          this._keys(notes.slice(-2), kt, dur, vel * 0.72);
          continue;
        }
        if (plan.roll && notes.length >= 2) {
          /* let the chord bloom from the bottom up instead of landing as a block */
          const spread = this.stepDur * rand(0.02, 0.06);
          for (let j = 0; j < notes.length; j++) {
            this._keys([notes[j]], kt + j * spread, dur, vel * (j === 0 ? 0.95 : 0.82));
          }
        } else if (plan.split && notes.length >= 3) {
          /* two-hand comping: a soft low pair answered by the upper voicing */
          this._keys(notes.slice(0, 2), kt, dur, vel * 0.88);
          this._keys(notes.slice(2), kt + this.stepDur * 0.11, dur, vel * 0.84);
        } else {
          this._keys(notes, kt, dur, vel);
        }
      }
      /* a quiet mid-bar answer keeps a long rain chord alive */
      if (plan.rainLift && s === 8 && !melodyAt(8) && patSteps.indexOf(8) === -1) {
        const lift = cur.voicing.slice(-3);
        if (lift.length) {
          this._keys(lift, kt, this.stepDur * 3, keysAmt * 0.38 * dyn * (plan.intensity || 1));
        }
      }
    }

    /* ---- free-time piano ---- */
    if (sec.rubato && this.rubatoEvents && s === 0) {
      for (let i = 0; i < this.rubatoEvents.length; i++) {
        const ev = this.rubatoEvents[i];
        this._keys(ev.notes, time + ev.at, ev.dur, ev.vel * dyn);
      }
    }

    /* ---- pad ---- */
    const padAmt = sec.pad * aPad * (sec.rubato ? 0.55 : 1);
    if (s === 0 && padAmt > 0.001) {
      this._pad(cur.voicing, t, this.stepDur * 16, 0.8 * padAmt * aPadSwell, song.dreamy);
    }

    /* ---- occasional hanging natural piano note ---- */
    if (song.hangPiano && !sec.rubato && keysAmt > 0.25 && s === 0 && bar % 2 === 0 && chance(0.26)) {
      const nextChord = song.chords[(bar + 1) % song.chords.length];
      const nextPcs = (CHORDS[nextChord[1]] || CHORDS.m7)
        .map((iv) => mod12(song.root + nextChord[0] + iv));
      this._hangPiano(cur.voicing, nextPcs, t + rand(0.008, 0.02), keysAmt);
    }

    /* ---- bass ---- */
    const bassAmt = sec.bass * aBass;
    if (bassAmt > 0.001) {
      const bt = t + rand(-human.timing * 0.6, human.timing * 0.7);
      if (sec.rubato) {
        /* a soft root leans in under the last intro bar */
        if (sec.kind === 'intro' && bar === sec.end - 1 && s === 0) {
          const rootMidi = 36 + mod12(cur.rootPc - 36);
          this._bass(rootMidi, bt, this.stepDur * 7, 0.34 * bassAmt * dyn);
        }
      } else if (this.bassEvents) {
        const beat = s / 4;
        for (let i = 0; i < this.bassEvents.length; i++) {
          const ev = this.bassEvents[i];
          if (ev.beat !== beat) continue;
          this._bass(ev.midi, bt, this.stepDur * ev.dur, ev.vel * bassAmt * rand(0.94, 1.04) * dyn);
        }
      } else {
        const marks = [];
        for (let i = 0; i < 16; i++) if (song.bassPat[i] === 'x') marks.push(i);
        const idx = marks.indexOf(s);
        if (idx !== -1) {
          const nextMark = idx + 1 < marks.length ? marks[idx + 1] : 16;
          let dur = clamp(nextMark - s, 2, 8);
          if (idx === marks.length - 1) dur = Math.min(dur, 16 - s);
          let midi = 36 + mod12(cur.rootPc - 36);
          if (idx === 1 && marks.length > 2) midi = 36 + mod12(cur.rootPc + 7 - 36);
          if (idx >= 2 && idx === marks.length - 1 && s >= 10) {
            const nextChord = song.chords[(bar + 1) % song.chords.length];
            const target = 36 + mod12(song.root + nextChord[0] - 36);
            midi = target + (bar % 2 === 0 ? -1 : 1);
            if (Math.abs(midi - (36 + mod12(cur.rootPc - 36))) > 7) midi = target - 1;
          }
          this._bass(midi, bt, this.stepDur * dur, 0.85 * bassAmt * rand(0.92, 1.05) * dyn);
        }
      }
    }

    /* ---- melody ---- */
    let melodyHere = false;
    const melAmt = sec.melody * aMel;
    for (let i = 0; i < this.melodyEvents.length; i++) {
      const ev = this.melodyEvents[i];
      if (ev.step !== s) continue;
      melodyHere = true;
      /* A muted melody layer (drums-first intro, layer entry) should stay
         silent instead of slipping through at the voices' minimum gain. */
      if (melAmt <= 0.001) continue;
      const inst = song.leadBySection[sec.idx] || 'vibes';
      this._lead(ev.midi, t + rand(0, human.timing * 1.3), this.stepDur * ev.dur, ev.vel * melAmt * aSwell, inst);
    }

    /* ---- counter-melody / guitar arpeggio ---- */
    const arpAmt = sec.arp * aArp;
    if (!melodyHere && arpAmt > 0.02) {
      for (let i = 0; i < this.arpEvents.length; i++) {
        const ev = this.arpEvents[i];
        if (ev.step !== s) continue;
        const inst = song.arpInst || 'guitar';
        const natural = inst === 'pianoNatural' || inst === 'piano';
        const opts = natural
          ? { pan: -0.20, detune: rand(-2.5, 2.5), release: 0.32 }
          : { pan: -0.24 };
        const at = t + rand(-human.timing, human.timing);
        this._sample(inst, ev.midi, at, this.stepDur * ev.dur, ev.vel * arpAmt * dyn, this.arpTone, opts);
      }
    }

    /* ---- a little rain on the glass ---- */
    if (s === 0 && mood.rain > 0 && chance(0.65)) {
      const n = randInt(1, 2);
      for (let i = 0; i < n; i++) this._droplet(time + rand(0, this.stepDur * 16));
    }
  }

  /* ---------- voices ---------- */
  _voice(src) {
    this.voices.add(src);
    src.addEventListener('ended', () => this.voices.delete(src));
    return src;
  }

  _noise() {
    const src = this._voice(this.ctx.createBufferSource());
    src.buffer = this.noise;
    src.loop = true;
    return src;
  }

  _sample(name, midi, time, dur, vel, dest, opts) {
    const o = opts || {};
    const chain = o.chain === false ? [name] : (this.instrumentChains[name] || [name]);
    const picked = this.samples.pickChain(chain, midi);
    if (!picked) return false;
    const ac = this.ctx;
    const resolved = picked.name || name;
    const def = this.instrumentSpecs[resolved] || this.instrumentSpecs[name] || { gain: 0.45, attack: 0.004, release: 0.2 };

    const serial = this._sampleSerial;
    this._sampleSerial = (serial + 1) & 0x7fffffff;

    let buffer = picked.buffer;
    if (picked.layers && picked.layers.length) {
      let bestLayer = picked.layers[0];
      let bestDist = Infinity;
      for (const layer of picked.layers) {
        const mid = (layer.min + layer.max) / 2;
        const d = Math.abs(vel - mid);
        if (d < bestDist) { bestDist = d; bestLayer = layer; }
      }
      buffer = bestLayer.takes && bestLayer.takes.length
        ? bestLayer.takes[serial % bestLayer.takes.length]
        : bestLayer.buffer;
    } else if (picked.takes && picked.takes.length > 1) {
      buffer = picked.takes[serial % picked.takes.length];
    }

    const src = this._voice(ac.createBufferSource());
    src.buffer = buffer;
    src.playbackRate.value = Math.pow(2, (midi - picked.root) / 12);
    /* round-robin variation: each take sits a hair off the last one */
    src.detune.value = o.detune === undefined ? rand(-2.5, 2.5) : o.detune;

    /* three virtual velocity layers: soft notes bloom darker and slower,
       hard notes open the top end, like a real multisample */
    const layer = clamp(vel, 0.04, 1.1);
    const peak = Math.max(0.0003, (o.gain === undefined ? def.gain : o.gain) * this.samples.trimFor(resolved) * Math.max(0.02, vel));
    const attack = (o.attack === undefined ? def.attack : o.attack) * (1.35 - 0.35 * Math.min(1, layer));
    const release = o.release === undefined ? def.release : o.release;
    const end = time + Math.max(dur, 0.12) + release;

    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(peak, time + attack);
    const hold = Math.max(time + attack + 0.01, end - release);
    g.gain.setValueAtTime(peak, hold);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    src.connect(g);

    let node = g;
    if (def.velCut && o.velTone !== false) {
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = clamp(def.velCut * (0.55 + 0.95 * Math.min(1, layer)), 420, 12000);
      lp.Q.value = 0.22;
      node.connect(lp);
      node = lp;
    }

    const pan = o.pan === undefined ? 0 : clamp(o.pan, -1, 1);
    if (ac.createStereoPanner && (pan || o.haas)) {
      const panner = ac.createStereoPanner();
      panner.pan.value = pan;
      node.connect(panner).connect(dest);
      if (o.haas) {
        /* Haas: a few ms of delay on the opposite side widens a mono sample
           without smearing the centre of the mix */
        const delay = ac.createDelay(0.06);
        delay.delayTime.value = o.haas;
        const hg = ac.createGain();
        hg.gain.value = clamp(o.haasGain === undefined ? 0.35 : o.haasGain, 0, 1);
        const hp = ac.createStereoPanner();
        hp.pan.value = pan === 0 ? 0.3 : clamp(-pan * 1.6, -1, 1);
        node.connect(delay).connect(hg).connect(hp).connect(dest);
      }
    } else {
      node.connect(dest);
    }
    src.start(time);
    src.stop(end + 0.05);
    return resolved;
  }

  _keys(notes, time, dur, vel) {
    if (this.samples.isReady() && this.song.palette.keys) {
      const name = this.song.palette.keys;
      const natural = name === 'pianoNatural' || name === 'piano';
      const spread = natural ? 0.08 : 0.12;
      let any = false;
      for (let i = 0; i < notes.length; i++) {
        const ring = natural ? dur + this.stepDur * 1.4 : dur;
        const pan = notes.length > 1
          ? (i / (notes.length - 1) - 0.5) * 2 * spread
          : rand(-0.05, 0.05);
        const opts = natural
          ? { pan, detune: rand(-3, 3), attack: 0.0015, release: 0.38, haas: 0.008, haasGain: 0.18 }
          : { pan };
        const touch = natural ? 0.93 + rand(0, 0.14) : 1;
        const played = this._sample(
          name, notes[i], time + i * 0.008 + rand(0, 0.003), ring,
          vel * (1 - i * 0.03) * touch, this.keysTone, opts
        );
        if (played) any = true;
      }
      if (any) {
        const layerAmt = this.song.mood.pianoLayer || 0;
        if (natural && layerAmt > 0) {
          for (let i = 0; i < notes.length; i++) {
            this._sample('ep', notes[i], time + i * 0.008, dur, vel * layerAmt, this.keysTone, {
              chain: false, pan: 0, gain: 0.28, attack: 0.03, release: 0.4
            });
          }
        }
        if (natural) {
          this._releaseTail(
            time + Math.max(dur, 0.12), spread * 0.5, vel * 0.5,
            name, this.keysTone, notes[notes.length - 1]
          );
        }
        return;
      }
    }
    this._keysSynth(notes, time, dur, vel);
  }

  /* the little mechanical key-up/damper noise after a sampled note */
  _releaseTail(time, pan, vel, inst, dest, midi) {
    const v = Math.max(0.01, vel);
    if (v < 0.03) return;
    const ac = this.ctx;
    const piano = inst === 'pianoNatural' || inst === 'piano' || inst === 'ep';
    const n = this._noise();
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = piano ? rand(700, 1500) : rand(1200, 2800);
    bp.Q.value = piano ? 1.1 : 0.8;
    const g = ac.createGain();
    const dec = rand(0.045, 0.10);
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(0.022 * v * rand(0.6, 1.1), time + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dec);
    n.connect(bp).connect(g);
    if (ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      p.pan.value = clamp(pan || 0, -1, 1);
      g.connect(p).connect(dest);
    } else {
      g.connect(dest);
    }
    n.start(time, Math.random() * 2.6);
    n.stop(time + dec + 0.02);

    /* a brief body resonance so sampled notes don't stop dead */
    if (midi && inst !== 'ep') {
      const o = this._voice(ac.createOscillator());
      o.type = 'sine';
      o.frequency.value = mtof(midi);
      const og = ac.createGain();
      og.gain.setValueAtTime(0.012 * v, time);
      og.gain.exponentialRampToValueAtTime(0.0001, time + 0.11);
      o.connect(og);
      if (ac.createStereoPanner) {
        const p = ac.createStereoPanner();
        p.pan.value = clamp(pan || 0, -1, 1);
        og.connect(p).connect(dest);
      } else {
        og.connect(dest);
      }
      o.start(time);
      o.stop(time + 0.13);
    }
  }

  /* a single natural piano note left to ring across the bar line */
  _hangPiano(notes, nextPcs, time, amount) {
    if (!this.samples.isReady() || !notes || !notes.length) return;
    let pool = nextPcs && nextPcs.length
      ? notes.filter((n) => nextPcs.indexOf(mod12(n)) !== -1)
      : [];
    if (!pool.length) pool = notes;
    let midi = pool[randInt(0, pool.length - 1)];
    while (midi < 60) midi += 12;
    while (midi > 79) midi -= 12;
    this._sample('pianoNatural', midi, time, this.stepDur * 10,
      0.19 * Math.max(0.2, amount) * rand(0.85, 1.08), this.keysTone, {
        gain: 0.68,
        pan: rand(-0.18, 0.14),
        detune: rand(-1.8, 1.8),
        attack: 0.002,
        release: 1.8
      });
  }

  _bass(midi, time, dur, vel) {
    this._sub(midi, time, dur, vel);
    if (this.samples.isReady() && this.song.palette.bass) {
      if (this._sample(this.song.palette.bass, midi, time, dur, vel, this.bassTone)) return;
    }
    this._bassSynth(midi, time, dur, vel);
  }

  _sub(midi, time, dur, vel) {
    const amount = this.song.mood.sub || 0;
    if (amount <= 0) return;
    const ac = this.ctx;
    const f = mtof(midi - 12);
    if (f < 24 || f > 90) return;
    const o = this._voice(ac.createOscillator());
    o.type = 'sine';
    o.frequency.setValueAtTime(f, time);
    /* a quiet triangle harmonic gives the sub some shape on small speakers */
    const o2 = this._voice(ac.createOscillator());
    o2.type = 'triangle';
    o2.frequency.setValueAtTime(f, time);
    const harmonic = ac.createGain();
    harmonic.gain.value = 0.12;
    const g = ac.createGain();
    const end = time + Math.max(dur, 0.2) + 0.2;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(amount * Math.max(0.1, vel), time + 0.02);
    g.gain.setValueAtTime(amount * Math.max(0.1, vel), time + Math.max(dur, 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    o.connect(g);
    o2.connect(harmonic).connect(g);
    g.connect(this.subTone);
    o.start(time);
    o2.start(time);
    o.stop(end + 0.03);
    o2.stop(end + 0.03);
  }

  _lead(midi, time, dur, vel, inst) {
    const name = inst || 'vibes';
    /* higher notes lean right, lower notes left, plus a few ms of Haas
       delay on the far side for a soft, wide lead */
    const pan = clamp((midi - 74) / 90, -0.2, 0.2);
    const played = this.samples.isReady() && this._sample(name, midi, time, dur, vel, this.melTone, {
      pan, haas: 0.012, haasGain: 0.32
    });
    if (played) {
      this._releaseTail(time + Math.max(dur, 0.12), pan, vel * 0.5, played, this.melTone, midi);
      return;
    }
    this._leadSynth(midi, time, dur, vel);
  }

  _pad(notes, time, dur, vel, dreamy) {
    const ac = this.ctx;
    const v = Math.max(0.02, vel);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = dreamy ? 900 : 780;
    lp.Q.value = dreamy ? 0.35 : 0.25;
    lp.connect(this.padBus);

    const out = ac.createGain();
    const end = time + Math.max(dur, 0.6) + (dreamy ? 2.8 : 1.5);
    const peak = (dreamy ? 0.043 : 0.058) * v;
    out.gain.setValueAtTime(0.0001, time);
    out.gain.linearRampToValueAtTime(peak, time + (dreamy ? 0.95 : 0.5));
    out.gain.setValueAtTime(peak, time + Math.max(dur, 0.7));
    out.gain.exponentialRampToValueAtTime(0.0001, end);

    if (dreamy) {
      /* dream pad */
      const pre = ac.createGain();
      pre.gain.value = 5;
      const shaper = ac.createWaveShaper();
      shaper.curve = dreamCurve();
      shaper.oversample = '2x';
      const post = ac.createGain();
      post.gain.value = 0.071;
      out.connect(pre).connect(shaper).connect(post).connect(lp);
    } else {
      out.connect(lp);
    }

    const drift = dreamy ? this._voice(ac.createOscillator()) : null;
    let driftAmt = null;
    if (drift) {
      drift.frequency.value = rand(0.05, 0.09);
      driftAmt = ac.createGain();
      driftAmt.gain.value = 3.8;
      drift.connect(driftAmt);
      drift.start(time);
    }

    const step = dreamy ? 1 : 2;
    const detunes = dreamy ? [-9, 0, 7] : [-6, 6];
    const pans = dreamy ? [-0.4, 0, 0.4] : [-0.3, 0.3];
    for (let i = 0; i < notes.length; i += step) {
      const f = mtof(notes[i]);
      for (let j = 0; j < detunes.length; j++) {
        const o = this._voice(ac.createOscillator());
        o.type = 'triangle';
        o.frequency.value = f;
        o.detune.value = detunes[j];
        if (driftAmt) driftAmt.connect(o.detune);
        const g = ac.createGain();
        g.gain.value = dreamy ? 0.27 : 0.42;
        o.connect(g);
        /* spread the detuned voices across the field; the right side gets a
           few ms of delay so the pad breathes instead of sitting in mono */
        if (ac.createStereoPanner) {
          let tail = g;
          if (pans[j] > 0) {
            const d = ac.createDelay(0.04);
            d.delayTime.value = dreamy ? 0.016 : 0.011;
            tail = g.connect(d);
          }
          const p = ac.createStereoPanner();
          p.pan.value = pans[j];
          tail.connect(p).connect(out);
        } else {
          g.connect(out);
        }
        o.start(time);
        o.stop(end + 0.05);
      }
    }

    if (drift) drift.stop(end + 0.1);
  }

  /* ---------- synth fallbacks ---------- */
  /* mellow harmonic series: fewer upper partials than a triangle or saw,
     so a missing sample still sounds like an instrument, not a test tone. */
  _wave(kind) {
    if (this._waveCache[kind]) return this._waveCache[kind];
    const ac = this.ctx;
    const amps = kind === 'lead'
      ? [0, 1, 0.18, 0.32, 0.06, 0.04]
      : kind === 'bass'
        ? [0, 1, 0.12, 0.05]
        : [0, 1, 0.45, 0.22, 0.10, 0.05];
    const real = new Float32Array(amps.length);
    const imag = new Float32Array(amps.length);
    for (let i = 0; i < amps.length; i++) imag[i] = amps[i];
    const wave = ac.createPeriodicWave(real, imag, { disableNormalization: false });
    this._waveCache[kind] = wave;
    return wave;
  }

  /* two-rate vibrato: 0.5 Hz drift plus 7 Hz shimmer, faded in after the
     attack so the note starts steady. */
  _vibrato(param, slowCents, fastCents, time) {
    const ac = this.ctx;
    const slow = this._voice(ac.createOscillator());
    slow.frequency.value = 0.5;
    const fast = this._voice(ac.createOscillator());
    fast.frequency.value = 7;
    const sg = ac.createGain();
    sg.gain.setValueAtTime(0, time);
    sg.gain.linearRampToValueAtTime(slowCents, time + 0.22);
    const fg = ac.createGain();
    fg.gain.setValueAtTime(0, time);
    fg.gain.linearRampToValueAtTime(fastCents, time + 0.22);
    slow.connect(sg).connect(param);
    fast.connect(fg).connect(param);
    slow.start(time);
    fast.start(time);
    return [slow, fast];
  }

  _keysSynth(notes, time, dur, vel) {
    const ac = this.ctx;
    const v = Math.max(0.02, vel);
    const mood = this.song.mood;
    const cut = this.song.keyLp || mood.tone.keyLp;
    const group = ac.createGain();
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(12000, cut * 1.8), time);
    lp.frequency.exponentialRampToValueAtTime(Math.max(300, cut * 0.7), time + 0.35);
    lp.Q.value = 0.35;
    group.connect(lp);
    lp.connect(this.chorusKeys ? this.chorusKeys.input : this.keysBus);

    for (let i = 0; i < notes.length; i++) {
      const t = time + i * 0.007 + rand(0, 0.003);
      const f = mtof(notes[i]);
      const rel = t + Math.max(dur, 0.45) + 0.5;

      const car = this._voice(ac.createOscillator());
      car.setPeriodicWave(this._wave('keys'));
      car.frequency.value = f;
      const mod = this._voice(ac.createOscillator());
      mod.type = 'sine';
      mod.frequency.value = f * 2.002;
      const mg = ac.createGain();
      mg.gain.setValueAtTime(f * 0.32 * v, t);
      mg.gain.exponentialRampToValueAtTime(Math.max(1, f * 0.012), t + 0.4);
      mod.connect(mg);
      mg.connect(car.frequency);

      const out = ac.createGain();
      out.gain.setValueAtTime(0.0001, t);
      out.gain.linearRampToValueAtTime(0.13 * v, t + 0.008);
      out.gain.exponentialRampToValueAtTime(0.05 * v, t + 0.22);
      out.gain.exponentialRampToValueAtTime(0.0001, rel);

      car.connect(out);
      out.connect(group);
      car.start(t); mod.start(t);
      car.stop(rel + 0.05); mod.stop(rel + 0.05);

      const n = this._noise();
      const bp = ac.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = clamp(f * 2, 700, 3200);
      bp.Q.value = 1.4;
      const ng = ac.createGain();
      ng.gain.setValueAtTime(0.012 * v, t);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
      n.connect(bp).connect(ng).connect(group);
      n.start(t, Math.random() * 2.6);
      n.stop(t + 0.02);
    }
  }

  _bassSynth(midi, time, dur, vel) {
    const ac = this.ctx;
    const f = mtof(midi);
    const v = Math.max(0.02, vel);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, time);
    lp.frequency.exponentialRampToValueAtTime(380, time + 0.18);
    lp.Q.value = 0.3;
    lp.connect(this.bassBus);

    const out = ac.createGain();
    out.gain.setValueAtTime(0.0001, time);
    out.gain.linearRampToValueAtTime(0.34 * v, time + 0.016);
    out.gain.exponentialRampToValueAtTime(0.19 * v, time + 0.2);
    out.gain.exponentialRampToValueAtTime(0.0001, time + Math.max(dur, 0.2) + 0.35);
    out.connect(lp);

    const o1 = this._voice(ac.createOscillator());
    o1.setPeriodicWave(this._wave('bass'));
    o1.frequency.value = f;
    const o2 = this._voice(ac.createOscillator());
    o2.type = 'sine';
    o2.frequency.value = f * 1.002;
    const o2g = ac.createGain();
    o2g.gain.value = 0.45;
    o1.connect(out);
    o2.connect(o2g);
    o2g.connect(out);

    const end = time + Math.max(dur, 0.2) + 0.4;
    o1.start(time); o2.start(time);
    o1.stop(end); o2.stop(end);
  }

  _leadSynth(midi, time, dur, vel) {
    const ac = this.ctx;
    const f = mtof(midi);
    const v = Math.max(0.05, vel);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3200;
    lp.Q.value = 0.3;
    lp.connect(this.chorusMel ? this.chorusMel.input : this.melBus);

    const out = ac.createGain();
    const rel = time + Math.max(dur, 0.2) + 0.35;
    out.gain.setValueAtTime(0.0001, time);
    out.gain.linearRampToValueAtTime(0.14 * v, time + 0.03);
    out.gain.exponentialRampToValueAtTime(0.08 * v, time + 0.2);
    out.gain.setValueAtTime(0.08 * v, time + Math.max(dur, 0.25));
    out.gain.exponentialRampToValueAtTime(0.0001, rel);
    out.connect(lp);

    const o1 = this._voice(ac.createOscillator());
    o1.setPeriodicWave(this._wave('lead'));
    o1.frequency.value = f;
    const o2 = this._voice(ac.createOscillator());
    o2.type = 'sine';
    o2.frequency.value = f * 2;
    const o2g = ac.createGain();
    o2g.gain.value = 0.1;
    o1.connect(out);
    o2.connect(o2g);
    o2g.connect(out);

    const vib = this._vibrato(o1.detune, 6, 2, time);

    const n = this._noise();
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = clamp(f * 1.6, 900, 4200);
    bp.Q.value = 1.1;
    const ng = ac.createGain();
    ng.gain.setValueAtTime(0.016 * v, time);
    ng.gain.exponentialRampToValueAtTime(0.0001, time + 0.09);
    n.connect(bp).connect(ng).connect(out);
    n.start(time, Math.random() * 2.6);
    n.stop(time + 0.1);

    o1.start(time); o2.start(time);
    o1.stop(rel + 0.05); o2.stop(rel + 0.05);
    for (const oscillator of vib) oscillator.stop(rel + 0.05);
  }

  /* ---------- drums ---------- */
  /* One small wobble per stroke, shared by the sampled and synthesised parts
     of the hit. The callers plan the groove; this is the hand on top of it,
     so even fills and toms that land on the grid move a little. */
  _humanDrum(time, vel) {
    const human = (this.song && this.song.human) || {};
    const spread = clamp((human.timing || 0.01) * 0.42, 0.0015, 0.007);
    return {
      time: Math.max(0, time + rand(-spread, spread)),
      vel: vel * rand(0.95, 1.05)
    };
  }

  _drumSample(name, time, vel, opts) {
    const o = opts || {};
    let actual = name;
    let variant = null;
    /* A brush kit takes the brush cymbal recordings whenever one exists, so a
       brushed song never pings with a stick ride or hi-hat. */
    const ds = (this.song && this.song.drumStyle) || {};
    if (ds.brush || ds.swirl) {
      const brushName = brushCymbal(name);
      if (brushName && this.samples.drum(brushName)) actual = brushName;
    }
    if (this.samples.drum(actual)) variant = this.samples.drumVariant(actual);
    const buf = variant ? variant.buffer : this.samples.drum(actual);
    if (!buf) return false;
    const ac = this.ctx;
    const src = this._voice(ac.createBufferSource());
    src.buffer = buf;
    if (o.rate) src.playbackRate.value = o.rate;
    const v = Math.max(0.001, vel);
    const peak = (o.gain === undefined ? 0.8 : o.gain) * v;
    const g = ac.createGain();
    if (o.attack) {
      /* ease the very front of the hit in. A brush dig's scrape lives in its
         first millisecond; starting at full peak made it bite like a stick. */
      g.gain.setValueAtTime(Math.max(0.0001, peak * 0.35), time);
      g.gain.linearRampToValueAtTime(peak, time + o.attack);
    } else {
      g.gain.setValueAtTime(peak, time);
    }
    if (o.fade) {
      const end = time + o.fade;
      if (o.tail) {
        /* The brush dig keeps sounding for ~0.4 s, so a fade crammed into the
           last 25 ms left it audible right up to an abrupt cut, and its uneven
           decay read as a swell. Hold the stroke's weight for a moment, then
           settle it well down by the end. */
        const from = time + Math.min(o.tail, o.fade * 0.5);
        g.gain.setValueAtTime(peak, from);
        g.gain.exponentialRampToValueAtTime(peak * 0.4, from + (end - from) * 0.45);
        g.gain.exponentialRampToValueAtTime(0.0001, end);
      } else {
        g.gain.setValueAtTime(peak, Math.max(time + 0.002, end - 0.025));
        g.gain.linearRampToValueAtTime(0.0001, end);
      }
    }
    let node = g;
    if (o.hp) {
      const f = ac.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = o.hp;
      f.Q.value = 0.4;
      node.connect(f);
      node = f;
    }
    if (o.lp) {
      const f = ac.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = o.lp;
      f.Q.value = 0.35;
      node.connect(f);
      node = f;
    }
    if (o.pan && ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      p.pan.value = clamp(o.pan, -1, 1);
      node.connect(p);
      node = p;
    }
    node.connect(o.dest || this.drumBus);
    src.connect(g);
    src.start(time);
    /* Always stop: a source left to run out its whole buffer keeps its node
       chain alive and smears into the next stroke. */
    const stopAt = o.stop !== undefined
      ? time + o.stop
      : time + (o.fade !== undefined
        ? o.fade + 0.06
        : buf.duration / (o.rate || 1) + 0.02);
    src.stop(stopAt);
    return true;
  }

  _duck(time, vel) {
    const g = this.musicDuck.gain;
    const depth = (this._duckBase || 0.18) * clamp(0.65 + vel * 0.35, 0, 1);
    const dur = 0.22;
    let start = 1;
    if (this._duckTime !== undefined && time < this._duckTime + dur) {
      const last = this._duckTime;
      const lastDepth = this._duckDepthLast || depth;
      if (time <= last + 0.008) start = 1 - lastDepth * Math.max(0, (time - last) / 0.008);
      else start = 1 - lastDepth + lastDepth * Math.min(1, (time - last - 0.008) / (dur - 0.008));
    }
    g.cancelScheduledValues(time);
    g.setValueAtTime(start, time);
    g.linearRampToValueAtTime(1 - depth, time + 0.008);
    g.linearRampToValueAtTime(1, time + dur);
    this._duckTime = time;
    this._duckDepthLast = depth;
  }

  _kick(time, vel) {
    const ac = this.ctx;
    const human = this._humanDrum(time, vel);
    time = human.time;
    const v = Math.max(0.02, human.vel);
    this._duck(time, v);
    /* Jazz keeps the kick light: the sampled body is trimmed and the synth
       sine behind it sits well back, so the beat breathes without a thump. */
    const jazzKick = this.song && this.song.mood && this.song.mood.jazz;
    const hadSample = this._drumSample('kick', time, v * (jazzKick ? 0.62 : 0.98),
      { gain: 1.0, dest: this.drumBus });

    const o = this._voice(ac.createOscillator());
    o.type = 'sine';
    o.frequency.setValueAtTime(hadSample ? 112 : 120, time);
    o.frequency.exponentialRampToValueAtTime(43, time + 0.13);
    const body = (hadSample ? 0.16 : 0.62) * (jazzKick ? 0.35 : 1);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(body * v, time + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.4);
    o.connect(g).connect(this.drumBus);
    o.start(time);
    o.stop(time + 0.44);

    const n = this._noise();
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1600;
    const ng = ac.createGain();
    ng.gain.setValueAtTime((hadSample ? 0.025 : 0.05) * v, time);
    ng.gain.exponentialRampToValueAtTime(0.0001, time + 0.02);
    n.connect(hp).connect(ng).connect(this.drumBus);
    n.start(time, Math.random() * 2.6);
    n.stop(time + 0.03);
  }

  _brush(time, vel, accent, sweep, opt) {
    const ac = this.ctx;
    const o = opt || {};
    /* The swirl already owns the wash, so a stroke landing on the same instant
       (a fill or a swell firing on a swirl step) would stack two releases into
       a 150 ms burst. Whichever caller gets there first keeps the slot. */
    if (!sweep && this._brushLast !== undefined && Math.abs(time - this._brushLast) < 0.009) return;
    const gridTime = time;
    const human = this._humanDrum(time, vel);
    time = human.time;
    const v = Math.max(0.01, human.vel);
    if (!sweep) this._brushLast = gridTime;
    /* circular motion: each stroke leans to the other side of the head. Only
       the swirl advances the circle; the swell hangs strokes off it so the two
       never sit out of phase with each other. */
    if (sweep) this._brushPan = ((this._brushPan || 0) + 0.382) % 1;
    const pan = Math.sin(this._brushPan * Math.PI * 2) * 0.22;

    /* The release tail peaks 80-100 ms after a stroke and only fades out by
       ~400 ms. When the next stroke lands inside that tail (the natural
       overlap of a swirl, ~400-550 ms at a slow tempo) start it quietly and
       swell into it: a hard onset every 400 ms is what made the wash pulse.
       Tails that have already faded keep their original level. */
    let overlap = 0;
    if (sweep && this._brushLast !== undefined) {
      const since = gridTime - this._brushLast;
      if (since >= 0 && since < 0.55) overlap = 1 - since / 0.55;
    }
    const into = 1 - 0.55 * overlap;
    if (sweep) this._brushLast = gridTime;

    /* Swirly Drums: real brush-release tails make the continuous wash, a
       "dig" stroke marks the accents, and a very quiet stir fills the gaps.
       Overlapping the releases on eighth notes is what turns them into a
       brush pattern instead of a row of separate swishes. Each stroke picks
       its own release, stir and pitch so no two sound identical. */
    if (this.samples.drum('brushRelease1')) {
      const rel = 'brushRelease' + randInt(1, 6);
      const stir = 'brushStir' + randInt(1, 6);
      const dig = 'brushDig' + randInt(1, 4);
      const tone = clamp(o.tone === undefined ? 1 : o.tone, 0.5, 1.5);
      /* light strokes are a little quieter as well as darker, but the swing
         across the arc is gentle: the old curve dropped the gentle end of the
         swirl to half level and the wash disappeared under the comp. */
      const gain = clamp(0.24 + 0.2 * tone, 0.22, 0.62) * into;
      if (accent) {
        this._drumSample(dig, time, v, {
          gain: 0.3,
          dest: this.drumBus,
          pan: pan + rand(-0.05, 0.05),
          hp: 170,
          /* keep the accent soft: the source's transient is already gentler
             now, and a lower corner keeps it from reading as a click */
          lp: (3200 + rand(-300, 400)) * (0.85 + 0.15 * tone),
          rate: rand(0.95, 1.05),
          /* soften the scrape: the dig's first ms is the brush biting the
             head, and at full level it read as scraping too hard */
          attack: 0.012,
          /* let the stroke settle away over its whole life */
          tail: 0.09,
          fade: 0.36
        });
      } else {
        this._drumSample(rel, time, v, {
          dest: this.drumBus,
          pan,
          hp: 260,
          gain,
          /* lighter strokes sit further back in the head, darker and quieter */
          lp: (3300 + rand(-300, 500)) * (0.84 + 0.16 * tone),
          rate: rand(0.94, 1.06) * (0.985 + 0.03 * (tone - 1)),
          /* a firm stroke holds the head a touch longer than a light one */
          fade: sweep ? 0.3 * (0.85 + 0.3 * tone) : 0.3
        });
        /* a very quiet stir underneath keeps the wash continuous between
           strokes without turning it back into a noise sweep */
        if (sweep) {
          this._drumSample(stir, time, v, {
            gain: 0.07 * into,
            dest: this.drumBus,
            pan: pan * 0.7,
            hp: 340,
            lp: 2800 + rand(-250, 350),
            rate: rand(0.9, 1.04),
            fade: 0.5
          });
        }
      }
      return;
    }

    /* Fallback for an older cached samples.js: keep the synthetic wash, but
       only as a last resort. */
    const a = accent ? 1 : 0.7;
    const tone = clamp(o.tone === undefined ? 1 : o.tone, 0.5, 1.5);
    if (!sweep || accent) {
      this._drumSample('snareSoft', time, v * (sweep ? 0.85 : 0.9), {
        gain: 0.26,
        dest: this.drumBus,
        pan: rand(-0.12, 0.14),
        hp: 200,
        lp: 2400 + rand(-300, 500),
        rate: rand(0.92, 1.04),
        fade: sweep ? 0.2 : 0.3
      });
    }

    const n = this._noise();
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 850 + rand(-100, 250);
    hp.Q.value = 0.3;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.35;
    const open = (2100 + rand(-400, 600)) * (0.8 + 0.2 * tone);
    lp.frequency.setValueAtTime(open, time);
    lp.frequency.linearRampToValueAtTime(open + 1200 + rand(-400, 900), time + 0.08);
    lp.frequency.linearRampToValueAtTime(open * 0.85, time + 0.34);
    const g = ac.createGain();
    const dur = sweep ? rand(0.3, 0.42) : (accent ? rand(0.22, 0.3) : rand(0.16, 0.24));
    const peak = (sweep ? 0.019 : 0.022) * v * a * rand(0.85, 1.15) * into;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(peak, time + dur * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    if (ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      p.pan.value = pan;
      n.connect(hp).connect(lp).connect(g).connect(p).connect(this.drumBus);
    } else {
      n.connect(hp).connect(lp).connect(g).connect(this.drumBus);
    }
    n.start(time, Math.random() * 3.4);
    n.stop(time + dur + 0.02);
  }

  _snare(time, vel, brush) {
    const ac = this.ctx;
    const human = this._humanDrum(time, vel);
    time = human.time;
    const v = Math.max(0.02, human.vel);
    /* On brushed songs the backbeat is a brush dig, not a stick hit. The dig
       was pushing through the swirl, so it sits well back in the wash. */
    if (brush && this.samples.drum('brushDig1')) {
      const dig = 'brushDig' + (1 + ((this._brushDig = (this._brushDig || 0) + 1) % 4));
      if (this._drumSample(dig, time, v, {
        gain: 0.34,
        dest: this.drumBus,
        pan: 0.04,
        hp: 160,
        lp: 3400 + rand(-250, 350),
        rate: rand(0.96, 1.04),
        /* same softened scrape as the accents in _brush */
        attack: 0.012,
        tail: 0.09,
        fade: 0.36
      })) return;
    }
    const hadSample = this._drumSample(brush ? 'snareSoft' : 'snare', time, v, {
      gain: brush ? 0.58 : 1.05,
      dest: this.drumBus,
      pan: 0.04
    });
    if (!hadSample) {
      const n = this._noise();
      const bp = ac.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = brush ? 3200 : 1800;
      bp.Q.value = brush ? 0.7 : 0.8;
      const ng = ac.createGain();
      const dec = brush ? 0.19 : 0.16;
      ng.gain.setValueAtTime((brush ? 0.06 : 0.17) * v, time);
      ng.gain.exponentialRampToValueAtTime(0.0001, time + dec);
      n.connect(bp).connect(ng).connect(this.drumBus);
      n.start(time, Math.random() * 2.6);
      n.stop(time + dec + 0.02);
    }

    if (!brush) {
      const n = this._noise();
      const hp = ac.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1600;
      const ng = ac.createGain();
      ng.gain.setValueAtTime(0.018 * v, time);
      ng.gain.exponentialRampToValueAtTime(0.0001, time + 0.07);
      n.connect(hp).connect(ng).connect(this.drumBus);
      n.start(time, Math.random() * 2.6);
      n.stop(time + 0.08);
    }
  }

  _ghost(time, vel) {
    const ac = this.ctx;
    const human = this._humanDrum(time, vel);
    time = human.time;
    const v = Math.max(0.01, human.vel);
    if (this._drumSample('snareSoft', time, v, { gain: 0.5, pan: -0.12, hp: 240 })) return;
    const n = this._noise();
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2100;
    bp.Q.value = 1.1;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.03 * v, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.09);
    n.connect(bp).connect(g).connect(this.drumBus);
    n.start(time, Math.random() * 2.6);
    n.stop(time + 0.1);
  }

  _hat(time, vel, open, opts) {
    const ac = this.ctx;
    const o = opts || {};
    const human = this._humanDrum(time, vel);
    time = human.time;
    vel = human.vel;
    if (this._drumSample(open ? 'hatOpen' : 'hat', time, vel, {
      gain: o.gain === undefined ? (open ? 0.46 : 0.55) : o.gain,
      dest: this.drumBus,
      pan: o.pan === undefined ? (open ? 0.16 : -0.2) : o.pan,
      rate: o.rate,
      lp: o.lp,
      fade: o.fade
    })) return;
    const n = this._noise();
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7800;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 10400;
    bp.Q.value = 0.7;
    const g = ac.createGain();
    const dec = open ? 0.22 : 0.045;
    g.gain.setValueAtTime(0.05 * vel, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dec);
    n.connect(hp).connect(bp).connect(g).connect(this.drumBus);
    n.start(time, Math.random() * 2.6);
    n.stop(time + dec + 0.02);
  }

  _ride(time, vel) {
    const ac = this.ctx;
    const human = this._humanDrum(time, vel);
    time = human.time;
    vel = human.vel;
    if (this._drumSample('ride', time, vel, {
      gain: 0.38,
      dest: this.drumBus,
      pan: 0.2,
      lp: 9000
    })) return;
    const n = this._noise();
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 5800;
    bp.Q.value = 0.8;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.03 * vel, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.5);
    n.connect(bp).connect(g).connect(this.drumBus);
    n.start(time, Math.random() * 2.6);
    n.stop(time + 0.52);
  }

  _shaker(time, vel) {
    const ac = this.ctx;
    const human = this._humanDrum(time, vel);
    time = human.time;
    vel = human.vel;
    if (this._drumSample('hat', time, vel, {
      gain: 0.8,
      dest: this.percBus,
      pan: 0.36,
      hp: 4600,
      fade: 0.13
    })) return;
    const n = this._noise();
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 6800;
    bp.Q.value = 0.9;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.04 * vel, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.1);
    n.connect(bp).connect(g).connect(this.percBus);
    n.start(time, Math.random() * 2.6);
    n.stop(time + 0.12);
  }

  _rim(time, vel) {
    const ac = this.ctx;
    const human = this._humanDrum(time, vel);
    time = human.time;
    vel = human.vel;
    if (this._drumSample('rim', time, vel, {
      gain: 0.5,
      dest: this.percBus,
      pan: -0.28
    })) return;
    const n = this._noise();
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2800;
    bp.Q.value = 1.4;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.035 * vel, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.06);
    n.connect(bp).connect(g).connect(this.percBus);
    n.start(time, Math.random() * 2.6);
    n.stop(time + 0.08);
  }

  _tom(time, vel, high) {
    const ac = this.ctx;
    const human = this._humanDrum(time, vel);
    time = human.time;
    vel = human.vel;
    /* The tom samples ring for ~0.85 s. A fill's last hit is the low tom on
       the "and" of beat 4, and letting it run to the end of its buffer left a
       flat hum over the next downbeat that read as synth rather than a struck
       head. A short gate and a touch of darkening keep it a tom: the low tom
       falls away faster than the high one. */
    if (this._drumSample(high ? 'tomHi' : 'tomLo', time, vel, {
      gain: high ? 0.62 : 0.58,
      dest: this.drumBus,
      pan: high ? 0.18 : -0.18,
      lp: high ? 2600 : 1900,
      rate: high ? 1.04 : 0.94,
      fade: high ? 0.62 : 0.4
    })) return;
    const o = this._voice(ac.createOscillator());
    o.type = 'sine';
    const f = high ? 170 : 120;
    o.frequency.setValueAtTime(f, time);
    o.frequency.exponentialRampToValueAtTime(f * 0.65, time + 0.18);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.18 * vel, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.28);
    o.connect(g).connect(this.drumBus);
    o.start(time);
    o.stop(time + 0.3);
  }

  _crash(time, vel) {
    const ac = this.ctx;
    const human = this._humanDrum(time, vel);
    time = human.time;
    vel = human.vel;
    /* The crash rings ~0.9 s; the splash is a short 0.62 s sample that has
       already fallen away by 0.45 s. Using them interchangeably at a section
       start meant it landed either as a wash under the new part or as a
       clipped stab, so keep the splash for light openings and take the crash
       when the landing needs weight. */
    const heavy = vel >= 0.28;
    if (this._drumSample(heavy ? 'crash' : (chance(0.5) ? 'crash' : 'splash'), time, vel, {
      gain: 0.3,
      dest: this.drumBus,
      pan: 0.24,
      lp: 10000
    })) return;
    const n = this._noise();
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 5000;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.025 * vel, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.6);
    n.connect(hp).connect(g).connect(this.drumBus);
    n.start(time, Math.random() * 2.6);
    n.stop(time + 0.62);
  }

  /* Plan one stroke of the brush swirl: how late it leans, how the pressure
     rides the arc, and how bright its release sits. Called inside the per-bar
     seeded stream, so a song sounds the same every time it plays. */
  _brushStroke(s, bar) {
    const dur = this.baseStepDur || this.stepDur;
    const accent = s === 4 || s === 12 ? 1 : s % 4 === 0 ? 0.86 : 0.7;

    /* A swirl note is not a metronomic eighth. The lean of each eighth in the
       bar is drawn once per song from its own stream, so the wash has a fixed
       unevenness that repeats the way a drummer's hand does. It is always a
       little late and never early: a brush stroke lands after the beat it
       answers, and the drums must not run ahead of the comp. */
    if (!this._brushLean) {
      const r = mulberry32(((this.song && this.song.seed) || 1) ^ 0x51ED270B);
      const lean = new Array(8);
      for (let i = 0; i < 8; i++) lean[i] = dur * (0.02 + 0.13 * r());
      lean[0] = 0;
      this._brushLean = lean;
    }
    let late = this._brushLean[s / 2];
    if (s === 0) late = 0;
    if (s === 4 || s === 12) {
      /* settle into the backbeat, so 4 and the next 1 sit closer to the
         written rhythm than the strokes inside the beat */
      late = dur * (0.01 + 0.05 * (late / (dur * 0.16)));
    } else if (s === 8) {
      late *= 0.7;
    }
    if (late > dur * 0.11) late = dur * 0.11;
    if (late < -0.01) late = -0.01;

    /* Pressure rides a slow arc: a little firmer into the backbeat, lighter
       through the turn of the bar, with a five-bar swell so it blooms and
       settles instead of repeating one dynamic for the whole song. */
    const burst = Math.sin(((bar % 5) / 5) * Math.PI);
    const arc = clamp(
      0.5 + 0.26 * Math.sin((s / 16 - 0.16) * Math.PI * 2) +
      0.12 * (s === 4 || s === 12 ? 1 : 0) + 0.10 * (burst - 0.5),
      0.12, 1
    );
    return {
      late,
      accent: accent * (0.92 + 0.16 * arc),
      /* only a firm backbeat stroke digs; the wash itself stays even */
      dig: (s === 4 || s === 12) && arc > 0.55 && chance(0.5),
      opts: {
        sweep: true,
        /* a lighter stroke is a flatter, duller swish, a firm one fuller */
        tone: 0.92 + 0.3 * arc + rand(-0.06, 0.06)
      }
    };
  }

  /* A single brush sweep on the "and" of 4, after the last backbeat. The
     old five-stroke swell stacked a full bar of releases, which read as a
     continuous snare sweep rather than a pickup. */
  _brushPickup(time, dur, vel) {
    const v = clamp(vel, 0.1, 1.2);
    this._brush(time + dur * 0.75, 0.24 * v, false, false);
    return true;
  }

  /* A short tom/snare pickup, the way a drummer would lead into a section.
     Jazz takes a clipped three-hit version: a six-note run at full weight
     reads as a rock roll in a relaxed trio. */
  _drumFill(time, dur, vel) {
    const v = clamp(vel, 0.1, 1.2);
    const jazzy = !!(this.song && this.song.mood && this.song.mood.jazz);
    const hits = jazzy
      ? [
        [0.52, 'tomHi', 0.16],
        [0.72, 'tomLo', 0.22],
        [0.88, 'snare', 0.24]
      ]
      : [
        [0.18, 'tomHi', 0.22],
        [0.36, 'tomHi', 0.28],
        [0.54, 'tomLo', 0.34],
        [0.70, 'snare', 0.30],
        [0.84, 'tomLo', 0.40],
        [0.94, 'snare', 0.38]
      ];
    for (const [p, kind, g] of hits) {
      const at = time + dur * p;
      if (kind === 'snare') this._snare(at, g * v, false);
      else this._tom(at, g * v, kind === 'tomHi');
    }
    return true;
  }

  /* Match the transition to the kit. Brush-led sections get one sweep on
     the "and" of 4; stick-led sections get the tom/snare pickup. A brush
     kit with the continuous swirl already has brush motion through the bar,
     so the swirl itself carries the transition. */
  _transitionInto(time, dur, rise) {
    const ds = this.song && this.song.drumStyle;
    const brushKit = !!(ds && (ds.brush || ds.swirl));
    const lift = clamp(0.85 + rise * 0.7, 0.85, 1.15);
    if (brushKit) {
      if (!ds.swirl) this._brushPickup(time, dur, lift);
      return 'brush';
    }
    this._drumFill(time, dur, lift);
    return 'fill';
  }

  /* the band takes a breath before a breakdown */
  _dropout(time, dur, amount) {
    const g = this.drumBus.gain;
    const base = (this.song.levels && this.song.levels.drums) || 0.9;
    g.cancelScheduledValues(time);
    g.setValueAtTime(base, time);
    g.linearRampToValueAtTime(base * clamp(1 - amount, 0.05, 1), time + 0.05);
    g.linearRampToValueAtTime(base, time + Math.max(0.1, dur));
  }

  _droplet(time) {
    const ac = this.ctx;
    const o = this._voice(ac.createOscillator());
    o.type = 'sine';
    o.frequency.setValueAtTime(rand(1600, 3200), time);
    const g = ac.createGain();
    /* sparse drops sit just above the rain bed, not on top of the music */
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(0.028, time + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.07);
    const dest = this.masterIn;
    if (ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      p.pan.value = rand(-0.65, 0.65);
      o.connect(g).connect(p).connect(dest);
    } else {
      o.connect(g).connect(dest);
    }
    o.start(time);
    o.stop(time + 0.09);
  }
}

/* ---------- public surface ---------- */
function createEngine(ctx, config) {
  return new SongEngine(ctx, config || {});
}

return {
  version: '1.0.0',
  createEngine,
  Engine: SongEngine,
  utils: {
    hashSeed, mulberry32, clamp, mod12, mtof, noteName: (m) => NOTE_NAMES[mod12(m)],
    noteNames: NOTE_NAMES, scaleNames: SCALE_NAMES,
    chords: CHORDS, scales: SCALES,
    makeImpulse, makeNoise, makeRain, makeRoomTone, makeVinylFloor
  }
};
});
