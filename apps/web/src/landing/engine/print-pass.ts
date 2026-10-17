// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The second pass of the print (gl.ts): it turns what the first pass wrote (scene-pass.ts) into
 * dots, ink and paper by an ordered dither, a line where two planes meet, and lamplight warm.
 */

export const PRINT_VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

export const PRINT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uShade;
uniform sampler2D uPlane;
uniform vec3 uLow[4];
uniform vec3 uHigh[4];
uniform vec3 uLine[4];
uniform vec3 uWarm;
uniform vec4 uEdges;
uniform int uRegions[5];
uniform ivec2 uSize;
out vec4 o;

float bayer(ivec2 p) {
  int x = p.x & 3;
  int y = p.y & 3;
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[y * 4 + x]) + 0.5) / 16.0;
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
  if (shade.a < 0.5 && !edge) { o = vec4(0.0); return; }
  // The page behind the print changes colour on the way down, and the print changes with it, on
  // the same row.
  float row = float(uSize.y - 1 - c.y);
  int region = row < uEdges.x ? 0 : (row < uEdges.y ? 1 : (row < uEdges.z ? 2 : (row < uEdges.w ? 3 : 4)));
  int band = uRegions[region];
  float t = bayer(c);
  float t2 = bayer(c + ivec2(2, 1));
  // Far off, a world thins to scattered dots and then to nothing, whatever the page's colour.
  float fog = max(here.b, max(right.b, down.b));
  // A lit window still shows from a long way off.
  if (fog > 0.0 && shade.b > t * 0.9) { o = vec4(uWarm, 1.0); return; }
  if (fog > bayer(c + ivec2(1, 3))) { o = vec4(0.0); return; }
  if (edge) { o = vec4(uLine[band], 1.0); return; }
  if (shade.b > t * 0.9) { o = vec4(uWarm, 1.0); return; }
  if (shade.g > t2) { o = vec4(uWarm, 1.0); return; }
  o = vec4(shade.r > t ? uHigh[band] : uLow[band], 1.0);
}`
