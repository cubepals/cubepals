// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The second pass of the print (gl.ts): it turns what the first pass wrote (scene-pass.ts) into
 * dots. Brightness goes through a tone curve (exposure, contrast, gamma) and then an 8 by 8
 * ordered dither; a line is drawn where two planes meet; what glows is printed solid, and its
 * blur (GLOW_FRAG, twice) as torch dots round it; the empty night sky gets a few stars. Behind the
 * words on the page the print opens to bare ground (the quiet rects), its dots thinning out over
 * about 150 CSS pixels, so no word sits on texture.
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
// How many CSS pixels one drawn dot is, and the rects (x, y, w, h in CSS pixels from the canvas's
// top left) the print keeps quiet behind; a width of 0 or less is unused.
uniform float uUnit;
uniform vec4 uQuiet[3];
out vec4 o;

float b2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return b2(0.5 * a) * 0.25 + b2(a); }
float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + b2(a); }

float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

// How quiet the print is here, 0 to 1: the distance to each rect, as a rect with round corners,
// eased over 150 CSS pixels with a smoothstep, so the open ground has a soft, round edge and never
// a box's.
float quietAt() {
  vec2 css = vec2(gl_FragCoord.x, float(uSize.y) - gl_FragCoord.y) * uUnit;
  float m = 0.0;
  for (int i = 0; i < 3; i++) {
    vec4 r = uQuiet[i];
    if (r.z <= 0.0) continue;
    vec2 half_ = r.zw * 0.5;
    float corner = min(48.0, min(half_.x, half_.y));
    vec2 q = abs(css - (r.xy + half_)) - half_ + corner;
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - corner;
    m = max(m, 1.0 - smoothstep(-24.0, 150.0, d));
  }
  return m;
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
  float quiet = quietAt();
  float t = bayer8(vec2(c));
  // The page behind the print changes colour on the way down, and the print changes with it, on
  // the same row.
  float row = float(uSize.y - 1 - c.y);
  int region = row < uEdges.x ? 0 : (row < uEdges.y ? 1 : (row < uEdges.z ? 2 : (row < uEdges.w ? 3 : 4)));
  int band = uRegions[region];
  // A lamp is solid torch; its light round it is torch dots, added in the dither's own order.
  float glow = texelFetch(uGlow, c, 0).r * (1.0 - quiet);
  bool solid = shade.a > 0.5 && shade.g > 0.5 && quiet < t;
  if (solid || glow * 1.5 > t + 0.05) { o = vec4(uWarm, 1.0); return; }
  if (shade.a < 0.5 && !edge) {
    // The night sky, where nothing is drawn: a star here and there, each one dot, never fading.
    bool night = band == 0 || band == 3;
    if (night && uStars > 0.5 && quiet < 0.01 && hash(vec2(c)) > 0.9992) { o = vec4(uStar, 1.0); return; }
    o = vec4(0.0);
    return;
  }
  // Far off, a world thins to scattered dots and then to nothing, whatever the page's colour.
  float fog = max(here.b, max(right.b, down.b));
  if (fog > bayer8(vec2(c + ivec2(3, 5)))) { o = vec4(0.0); return; }
  if (edge && quiet < t) { o = vec4(uLine[band], 1.0); return; }
  // The tone curve: exposure, then contrast about the middle, then gamma. This is the art direction.
  float l = shade.r * 2.0 * uExposure;
  l = 1.0 - exp(-l);
  l = clamp((l - 0.5) * uContrast + 0.5, 0.0, 1.0);
  l = pow(l, 1.0 / 2.2);
  // (The plainer print has a few flat steps of grey instead.)
  if (uLevels > 0.0) l = floor(l * uLevels + 0.5) / uLevels;
  // Behind the words the print opens to its ground: paper on the light grounds, dark on the dark.
  l = mix(l, band == 2 ? 0.0 : 1.0, quiet);
  if (l <= t) { o = vec4(uLow[band], 1.0); return; }
  // A lit dot is warm where that share of the light here is lamplight, in the dither's own order.
  o = vec4(shade.b > bayer8(vec2(c + ivec2(5, 2))) ? uWarm : uHigh[band], 1.0);
}`
