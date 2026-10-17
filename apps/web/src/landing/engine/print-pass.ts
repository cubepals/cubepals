// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The second pass of the print (gl.ts): it turns what the first pass wrote (scene-pass.ts) into
 * dots. Brightness goes through a tone curve (exposure, contrast, gamma) and then an 8 by 8
 * ordered dither between five tones; a line is drawn where two planes meet; what glows is printed
 * solid, and its blur (GLOW_FRAG, twice) as torch dots round it; the empty night sky gets a few
 * stars; and the dust in a beam of light is a scatter of dots that drifts. The picture runs on
 * under the words: they carry a halo of their own ground (landing.css), so nothing of it is erased
 * for them.
 */

export const PRINT_VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

/** One way of a separable Gaussian, nine taps, over what glows (the first pass's green). */
export const GLOW_FRAG = `#version 300 es
precision mediump float;
uniform sampler2D uFrom;
uniform vec2 uStep;
uniform int uChannel;
out vec4 o;
void main() {
  vec2 size = vec2(textureSize(uFrom, 0));
  vec2 at = gl_FragCoord.xy / size;
  float w[5] = float[5](1.0, 0.8825, 0.6065, 0.3247, 0.1353);
  float sum = 0.0;
  for (int i = -4; i <= 4; i++) {
    vec4 t = texture(uFrom, at + uStep * float(i) / size);
    sum += (uChannel == 1 ? t.g : t.r) * w[abs(i)];
  }
  o = vec4(sum / 4.9082, 0.0, 0.0, 1.0);
}`

export const PRINT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uShade;
uniform sampler2D uPlane;
uniform sampler2D uGlow;
uniform vec3 uLow[4];
uniform vec3 uHigh[4];
uniform vec3 uLine[4];
uniform vec3 uWarm;
uniform vec3 uStar;
uniform vec4 uEdges;
uniform int uRegions[5];
uniform ivec2 uSize;
uniform float uExposure;
uniform float uContrast;
uniform float uLevels;
uniform float uStars;
// The scene's clock, in seconds, for the dust drifting in a beam.
uniform float uTime;
out vec4 o;

// How many tones a dot can take between the ground's dark and its light, the dark aside.
const float TONES = 4.0;

float b2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return b2(0.5 * a) * 0.25 + b2(a); }
float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + b2(a); }

float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  ivec2 hi = uSize - 1;
  vec4 shade = texelFetch(uShade, c, 0);
  vec4 here = texelFetch(uPlane, c, 0);
  vec4 right = texelFetch(uPlane, min(c + ivec2(1, 0), hi), 0);
  vec4 down = texelFetch(uPlane, max(c - ivec2(0, 1), ivec2(0)), 0);
  // A line is drawn where one plane meets another, but not round the dots of something that is
  // thinning away: those would close up into a blot.
  bool thin = abs(here.a - 0.5) < 0.2;
  bool edge = !thin && (
    (any(notEqual(here.rg, right.rg)) && abs(right.a - 0.5) >= 0.2) ||
    (any(notEqual(here.rg, down.rg)) && abs(down.a - 0.5) >= 0.2));
  // The page behind the print changes colour on the way down, and the print changes with it, on
  // the same row.
  float row = float(uSize.y - 1 - c.y);
  int region = row < uEdges.x ? 0 : (row < uEdges.y ? 1 : (row < uEdges.z ? 2 : (row < uEdges.w ? 3 : 4)));
  int band = uRegions[region];
  float t = bayer8(vec2(c));
  // A lamp is solid torch; its light round it is torch dots, added in the dither's own order.
  float glow = texelFetch(uGlow, c, 0).r;
  bool solid = shade.a > 0.5 && shade.g > 0.5;
  if (solid || glow * 0.9 > t + 0.08) { o = vec4(uWarm, 1.0); return; }
  // A beam of light through the air in front of what is drawn (scene-pass.ts, the alpha below
  // one): dust, a scatter of warm dots as thick as the beam, drifting down a dot at a time.
  float dust = shade.a > 0.5 ? (1.0 - shade.a) / 0.4 : 0.0;
  if (dust > 0.0 && hash(vec2(c.x, c.y + int(floor(uTime * 5.0)))) < dust * 0.4) { o = vec4(uWarm, 1.0); return; }
  if (shade.a < 0.5 && !edge) {
    // The night sky, where nothing is drawn: a star here and there, each one dot, never fading.
    bool night = band == 0 || band == 3;
    if (night && uStars > 0.5 && hash(vec2(c)) > 0.9992) { o = vec4(uStar, 1.0); return; }
    o = vec4(0.0);
    return;
  }
  // Far off, a world thins to scattered dots and then to nothing, whatever the page's colour.
  float fog = max(here.b, max(right.b, down.b));
  if (fog > bayer8(vec2(c + ivec2(3, 5)))) { o = vec4(0.0); return; }
  if (edge) { o = vec4(uLine[band], 1.0); return; }
  // The tone curve: exposure, then contrast about the middle, then gamma. This is the art direction.
  float l = shade.r * 2.0 * uExposure;
  l = 1.0 - exp(-l);
  l = clamp((l - 0.5) * uContrast + 0.5, 0.0, 1.0);
  // On the dark grounds the gamma starts with a straight run out of black, as sRGB's does, so the
  // faintest light comes in a few dots at a time and a wall's shading draws no contour.
  l = band == 2 && l < 0.1 ? l * 3.51 : pow(l, 1.0 / 2.2);
  // (The plainer print has a few flat steps of grey instead.)
  if (uLevels > 0.0) l = floor(l * uLevels + 0.5) / uLevels;
  // In the dark rooms the faint end of the light eases into the dark: below a thirtieth it
  // prints nothing and above that it comes in gently, so a lamp's pool has no rim. The dither's
  // order is jittered a little there too, so its steps draw no contour on a wall.
  // On the light grounds a shadow is a dark grey, never a hole of ink: the page is lit. Under the
  // sky the darkest face keeps a scatter of light dots too, as concept A1's does.
  if (band == 1) l = mix(0.14, 1.0, l);
  if (band == 0) l = mix(0.1, 1.0, l);
  if (band == 2) {
    l = smoothstep(0.03, 0.95, l);
    t = clamp(t + (hash(vec2(c) + 3.0) - 0.5) * 0.12, 0.03, 1.0);
  }
  // Five tones, not two: the ground's dark, three steps between, and its light; the dither only
  // ever sets a dot beside the next tone up. A grey is then a quiet weave of near tones instead of
  // black on white, which is easier on the eye and still reads as a print.
  float v = l * TONES;
  float rung = min(floor(v) + (fract(v) > t ? 1.0 : 0.0), TONES) / TONES;
  if (rung <= 0.0) { o = vec4(uLow[band], 1.0); return; }
  // A lit dot is warm where that share of the light here is lamplight, in the dither's own order.
  vec3 top = shade.b > bayer8(vec2(c + ivec2(5, 2))) ? uWarm : uHigh[band];
  o = vec4(mix(uLow[band], top, rung), 1.0);
}`
