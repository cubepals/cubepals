// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The first pass of the print (gl.ts): it draws the world's blocks and loose parts and writes, for
 * every drawn pixel, how bright the surface there is, how much lamplight reaches it, and which flat
 * plane it belongs to. Not the dots, which the second pass makes (print-pass.ts).
 */

export const MAX_LIGHTS = 24

export const SCENE_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aCorner;
layout(location=1) in float aFace;
layout(location=2) in vec2 aUv;
layout(location=3) in vec3 iPos;
layout(location=4) in vec4 iA;
layout(location=5) in vec4 iB;
layout(location=6) in vec2 iTurn;
uniform mat4 uCamera;
uniform vec2 uShift;
uniform float uNudge;
uniform vec2 uWave;
uniform vec3 uEye;
uniform vec3 uFog;
uniform float uTime;
uniform float uLoose;
uniform float uFace[6];
uniform float uRoom[6];
out vec3 vWorld;
out float vFog;
out vec2 vUv;
flat out vec2 vLit;
flat out int vFace;
flat out vec4 vA;
flat out vec4 vB;
flat out vec3 vCell;
flat out float vSolid;
void main() {
  // What moves is made of loose parts: boxes of any size, every face of them drawn. Their bytes
  // say other things than a block's do (see Renderer.setMoving).
  bool loose = uLoose > 0.5;
  int mask = loose ? 63 : int(iA.a * 255.0 + 0.5);
  int face = int(aFace + 0.5);
  // A face with a block against it is never drawn: its corners are sent off the picture here,
  // before any of the work below is done for them.
  if ((mask & (1 << face)) == 0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  // The far worlds arrive as a ring spreading out from this one: each block grows from nothing
  // and rises into its place as the ring's edge passes it.
  float grow = uWave.y <= 0.0 ? 1.0 : clamp((uWave.x - distance(iPos.xz, vec2(8.0))) / uWave.y, 0.0, 1.0);
  // A block may be drawn smaller than whole (one growing back after being dug), about its middle.
  float size = iB.a * grow;
  int kind = int(iA.g * 255.0 + 0.5);
  // What moves by itself moves a few times a second, like the frames of a drawn loop.
  float tick = floor(uTime * 9.0) / 9.0;
  // Leaves breathe, each block a little out of step with the next, and the whole crown leans.
  if (!loose && kind == 7) size *= 1.04 + 0.05 * sin(tick * 2.6 + dot(iPos, vec3(1.3, 2.1, 1.7)));
  vec3 p = iPos + 0.5 + (aCorner - 0.5) * size;
  // A loose part: where its low corner is, and how far it reaches each way (up to two blocks).
  // It may be turned about its own middle: tipped forward or back, and then turned to face any
  // way round. That is how an arm swings from a shoulder and a figure turns to look at something.
  vLit = vec2(0.0);
  if (loose) {
    vec3 reach = vec3(iA.a, iB.r, iB.g) * 2.0;
    vec3 o = (aCorner - 0.5) * reach;
    vec3 n = face == 0 ? vec3(0.0, 1.0, 0.0) : face == 1 ? vec3(1.0, 0.0, 0.0) : face == 2 ? vec3(0.0, 0.0, 1.0)
      : face == 3 ? vec3(0.0, -1.0, 0.0) : face == 4 ? vec3(-1.0, 0.0, 0.0) : vec3(0.0, 0.0, -1.0);
    float cp = cos(iTurn.y);
    float sp = sin(iTurn.y);
    o = vec3(o.x, o.y * cp - o.z * sp, o.y * sp + o.z * cp);
    n = vec3(n.x, n.y * cp - n.z * sp, n.y * sp + n.z * cp);
    float cy = cos(iTurn.x);
    float sy = sin(iTurn.x);
    o = vec3(o.x * cy + o.z * sy, o.y, -o.x * sy + o.z * cy);
    n = vec3(n.x * cy + n.z * sy, n.y, -n.x * sy + n.z * cy);
    p = iPos + reach * 0.5 + o;
    // A turned face takes its light from the ways it now leans, each by how far it leans there.
    vec3 w = n * n;
    vLit.x = w.y * (n.y > 0.0 ? uFace[0] : uFace[3]) + w.x * (n.x > 0.0 ? uFace[1] : uFace[4])
      + w.z * (n.z > 0.0 ? uFace[2] : uFace[5]);
    vLit.y = w.y * (n.y > 0.0 ? uRoom[0] : uRoom[3]) + w.x * (n.x > 0.0 ? uRoom[1] : uRoom[4])
      + w.z * (n.z > 0.0 ? uRoom[2] : uRoom[5]);
  }
  if (!loose && kind == 7) {
    p.x += 0.09 * sin(tick * 1.7 + iPos.y * 0.9 + iPos.z * 0.35);
    p.z += 0.07 * sin(tick * 1.3 + iPos.y * 0.7 + iPos.x * 0.35);
  }
  // Water lies a little under its bank and swells: its surface is one sheet, so the corners that
  // blocks share move together.
  if (!loose && kind == 10 && aCorner.y > 0.5) {
    vec2 at = iPos.xz + aCorner.xz;
    p.y -= 0.24 + 0.13 * sin(tick * 2.8 + at.x * 1.1 + at.y * 0.7) + 0.06 * sin(tick * 4.1 - at.y * 1.6);
  }
  p.y -= (1.0 - grow) * (1.0 - grow) * 14.0;
  // The worlds a long way off fade into the page, the way far hills do.
  vFog = uFog.z * clamp((distance(iPos, uEye) - uFog.x) / uFog.y, 0.0, 1.0);
  vec4 clip = uCamera * vec4(p, 1.0);
  // The whole picture is slid across the screen, so what the camera looks at can be held to one
  // side of it.
  clip.xy += uShift * clip.w;
  clip.z -= uNudge * clip.w;
  gl_Position = clip;
  vWorld = p;
  vUv = aUv;
  vFace = face;
  vA = iA;
  // A loose part is lit by the day when it is out of doors and by its room when it is in one.
  float outside = iB.b > 0.0 ? 0.0 : 63.0 / 255.0;
  vB = loose ? vec4(outside, outside, iB.b, 1.0) : iB;
  // A part has no cell of its own on the grid; its number stands in, so its grain holds still as
  // it moves and its faces get lines of their own.
  vCell = loose ? vec3(float(gl_InstanceID) * 1.37 + 500.0) : iPos;
  // How much of a loose part is there: all of it, or some of its dots while it comes or goes.
  vSolid = loose ? iB.a : 1.0;
}`

export const SCENE_FRAG = `#version 300 es
precision highp float;
in vec3 vWorld;
in float vFog;
in vec2 vUv;
flat in vec2 vLit;
flat in int vFace;
flat in vec4 vA;
flat in vec4 vB;
flat in vec3 vCell;
flat in float vSolid;
uniform float uFace[6];
uniform float uRoom[6];
uniform float uShadow;
uniform float uLevels;
uniform float uTime;
uniform float uLoose;
uniform vec4 uLights[${MAX_LIGHTS}];
uniform float uLightOn[${MAX_LIGHTS}];
uniform float uLightGroup[${MAX_LIGHTS}];
uniform int uLightCount;
uniform float uGroups[16];
uniform float uDetail;
uniform float uRock;
uniform vec3 uPick;
layout(location=0) out vec4 o0;
layout(location=1) out vec4 o1;

float hash(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}

float bayer(vec2 p) {
  int x = int(p.x) & 3;
  int y = int(p.y) & 3;
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[y * 4 + x]) + 0.5) / 16.0;
}

void main() {
  // A part that is coming or going is drawn in some of its dots only, and what is behind shows
  // through the rest: it thins away the way far hills do, in the print's own grain.
  bool ghost = vSolid < 0.995;
  if (ghost && vSolid <= bayer(gl_FragCoord.xy)) discard;
  float tone = vA.r;
  int kind = int(vA.g * 255.0 + 0.5);
  int group = int(vA.b * 255.0 + 0.5);
  int sunny = int(vB.r * 255.0 + 0.5);
  int outdoors = int(vB.g * 255.0 + 0.5);
  int room = int(vB.b * 255.0 + 0.5);
  float sun = (sunny & (1 << vFace)) != 0 ? 1.0 : 0.0;
  bool open = (outdoors & (1 << vFace)) != 0;
  // A room with its switch only part-way up is still a room you can see into: the walls keep most
  // of their light and it is the lamps' warmth that dims.
  float level = uGroups[room];
  bool loose = uLoose > 0.5;
  float roomLight = (loose ? vLit.y : uRoom[vFace]) * min(1.0, level * 8.0) * (0.6 + 0.4 * level);

  // Each kind gets a little of its own grain, so a field of one material isn't a flat tint.
  float grain = hash(vCell) - 0.5;
  vec2 texel = floor(vUv * 4.0);
  float fine = hash(vec3(texel, 7.0) + vCell * 3.0) - 0.5;
  // (With the detail turned down a material is one flat tone: the plainer, sharper print.)
  if (kind == 2) tone += step(0.4, grain) * 0.2 * uDetail;
  if (kind == 3) tone -= step(0.44, grain) * 0.25 * uDetail;
  if (kind == 4) tone += step(0.44, grain) * 0.25 * uDetail;
  if (kind == 5) tone += fine * 0.3 * uDetail;
  if (kind == 7) tone += grain * 0.5 * uDetail;
  if (kind == 9) tone += step(0.2, fine) * 0.25 * uDetail;
  if (kind == 14 && uDetail > 0.5) tone = fine > 0.15 ? 0.0 : tone;
  // Sand is as pale as the grass beside it, so it is told apart by its pebbles.
  if (kind == 23) tone -= step(0.24, fine) * 0.55 * uDetail;
  if (kind == 10) {
    // Water: hatched with short dashes that run both ways, crossed by darker troughs that travel
    // over it, with a glint here and there. Stepped in time, like everything that moves by itself.
    float tick = floor(uTime * 9.0) / 9.0;
    float row = floor(vWorld.z * 3.0);
    float way = mod(row, 2.0) * 2.0 - 1.0;
    float dash = step(0.5, fract(vWorld.x * 0.8 + row * 0.37 + tick * 0.55 * way));
    float on = step(fract(vWorld.z * 3.0), 0.34);
    tone = 1.0 - on * dash * 0.9;
    // Two ripples a block and a half apart, each a narrow shadow, so the pond stays one sheet of
    // water with waves crossing it and is never cut in two by one.
    float trough = sin(vWorld.x * 2.1 + vWorld.z * 3.3 - tick * 4.2);
    tone -= smoothstep(0.62, 0.92, trough) * 0.6;
    float glint = step(0.975, hash(vec3(floor(vWorld.xz * 2.0), floor(tick * 2.5))));
    tone = max(tone, glint);
  }

  // A lit room is brighter than the rock it is cut from, so it reads as a room and not as more wall.
  if (!open) tone = mix(tone, 1.0, 0.45);
  // The rock a room is cut from is the margin of the picture, not the picture: it prints quieter.
  if (open && !loose && vWorld.y < -0.5) tone = mix(tone, 1.0, uRock);
  float daylight = open ? (loose ? vLit.x : uFace[vFace]) * mix(uShadow, 1.0, sun) : roomLight;
  float lum = clamp(tone * daylight, 0.0, 1.0);

  float warm = 0.0;
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= uLightCount) break;
    // A room's lamps light that room; the lamps outdoors light the outdoors. Rock is not glass.
    float mine = open ? 1.0 : float(room);
    if (abs(uLightGroup[i] - mine) > 0.5) continue;
    float d = distance(vWorld, uLights[i].xyz);
    float f = clamp(1.0 - d / uLights[i].w, 0.0, 1.0);
    warm += uLightOn[i] * f * f;
  }
  warm = clamp(warm * (0.35 + tone * 0.65), 0.0, 1.0);
  // A few flat steps of grey, so each face prints as one clean pattern rather than as noise.
  lum = floor(lum * uLevels + 0.5) / uLevels;
  warm = floor(warm * uLevels + 0.5) / uLevels;

  float glow = 0.0;
  if (group > 0 && (kind == 12 || kind == 13 || kind == 22)) glow = uGroups[group];

  // Which flat plane this is: the way it faces, how far along that way, and what it's made of.
  int axis = vFace % 3;
  float along = axis == 0 ? vCell.y : (axis == 1 ? vCell.x : vCell.z);
  float plane = along + (vFace < 3 ? 1.0 : 0.0);
  float id = float(vFace) * 7.0 + plane * 13.0 + float(kind) * 31.0;
  bool gridded = kind == 16 || kind == 15 || kind == 18 || kind == 13 || kind == 12;
  if (gridded) id += dot(vCell, vec3(3.0, 17.0, 5.0));
  // The block the cursor is on: bare paper with a line round it, the way the game marks one.
  if (all(equal(vCell, uPick))) {
    lum = 1.0;
    warm = 0.0;
    id += 977.0 + dot(vCell, vec3(3.0, 17.0, 5.0));
  }
  id = mod(id + 8192.0, 65535.0) + 1.0;
  o0 = vec4(lum, warm, glow, 1.0);
  // (Half marks a part that is thinning: no line is drawn round its scattered dots.)
  o1 = vec4(mod(id, 256.0) / 255.0, floor(id / 256.0) / 255.0, vFog, ghost ? 0.5 : 1.0);
}`
