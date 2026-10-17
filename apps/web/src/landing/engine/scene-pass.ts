// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The first pass of the print (gl.ts): it draws the world's blocks and loose parts, lights them,
 * and writes, for every drawn pixel, how bright the surface there is, whether it glows, and which
 * flat plane it belongs to. The light is one key (the moon by night, the sun by day) with a shadow
 * map; a fill from the sky, as much of it as can be seen from here; a room's own light; the placed
 * lamps, their shadows and their bounce baked when the chunk was built (bake.ts); and the lights
 * that move. Corners are darkened by the blocks round them (ambient occlusion, worked out when the
 * world is packed), and the light hanging in the air near a lamp is handed on as dust for a beam.
 * Not the dots, which the second pass makes (print-pass.ts), nor the shadow map's own drawing,
 * which uses this vertex shader with SHADOW_FRAG.
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
layout(location=7) in uvec2 iAo;
uniform mat4 uCamera;
uniform vec2 uShift;
uniform float uNudge;
uniform vec2 uWave;
uniform vec3 uEye;
uniform vec3 uFog;
uniform float uTime;
uniform float uLoose;
uniform float uRoom[6];
out vec3 vWorld;
out float vFog;
out vec2 vUv;
flat out vec3 vNormal;
flat out float vRoomLit;
flat out int vFace;
flat out uint vAo;
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
  vec3 n = face == 0 ? vec3(0.0, 1.0, 0.0) : face == 1 ? vec3(1.0, 0.0, 0.0) : face == 2 ? vec3(0.0, 0.0, 1.0)
    : face == 3 ? vec3(0.0, -1.0, 0.0) : face == 4 ? vec3(-1.0, 0.0, 0.0) : vec3(0.0, 0.0, -1.0);
  // A loose part: where its low corner is, and how far it reaches each way (up to two blocks).
  // It may be turned about its own middle: tipped forward or back, and then turned to face any
  // way round. That is how an arm swings from a shoulder and a figure turns to look at something.
  vRoomLit = 0.0;
  if (loose) {
    vec3 reach = vec3(iA.a, iB.r, iB.g) * 2.0;
    vec3 o = (aCorner - 0.5) * reach;
    float cp = cos(iTurn.y);
    float sp = sin(iTurn.y);
    o = vec3(o.x, o.y * cp - o.z * sp, o.y * sp + o.z * cp);
    n = vec3(n.x, n.y * cp - n.z * sp, n.y * sp + n.z * cp);
    float cy = cos(iTurn.x);
    float sy = sin(iTurn.x);
    o = vec3(o.x * cy + o.z * sy, o.y, -o.x * sy + o.z * cy);
    n = vec3(n.x * cy + n.z * sy, n.y, -n.x * sy + n.z * cy);
    p = iPos + reach * 0.5 + o;
    // A turned face takes its room's light from the ways it now leans, each by how far it leans.
    vec3 w = n * n;
    vRoomLit = w.y * (n.y > 0.0 ? uRoom[0] : uRoom[3]) + w.x * (n.x > 0.0 ? uRoom[1] : uRoom[4])
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
  vNormal = n;
  // This face's four corners, two bits each, from the six faces' bytes.
  vAo = ((face < 4 ? iAo.x : iAo.y) >> uint(8 * (face & 3))) & 255u;
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

/** The shadow map keeps only depth, so its fragments have nothing to write. */
export const SHADOW_FRAG = `#version 300 es
precision mediump float;
void main() {}`

export const SCENE_FRAG = `#version 300 es
precision highp float;
precision highp sampler2DShadow;
in vec3 vWorld;
in float vFog;
in vec2 vUv;
flat in vec3 vNormal;
flat in float vRoomLit;
flat in int vFace;
flat in uint vAo;
flat in vec4 vA;
flat in vec4 vB;
flat in vec3 vCell;
flat in float vSolid;
uniform float uRoom[6];
uniform vec3 uKey;
uniform float uKeyLight;
uniform float uFill;
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
uniform sampler2DShadow uShadowMap;
uniform mat4 uLight;
uniform float uMapTexel;
// 1 where the shadow map is drawn and holds this world; 0 where a face's own bits say what the
// key reaches (the far worlds, and a device that can't afford the map).
uniform int uMapped;
// The one lamp that casts a shadow (the light in front of a room's server), as its index among the
// lights, or -1; its own shadow map, drawn looking down from it.
uniform int uTorch;
uniform sampler2DShadow uLampMap;
uniform mat4 uLampView;
// How dark the rooms are: their own fill, and how strongly the lamps light them.
uniform float uRoomFill;
uniform float uLampGain;
// How far the camera is under the grass, 0 to 1: the rock outside the rooms goes dark with it.
uniform float uDeep;
// The least light any face gets, from everything round about.
uniform float uAmbient;
// How many times over a room's lamps count: more when it is a lit window seen from out of doors.
uniform float uWindows;
// The light that doesn't move, baked a cell a block (bake.ts): red the sky a cell sees, green the
// placed lamps' light that reaches it, blue what comes back off the blocks round it. Its size in
// cells and the height of its lowest cell; a size of 0 where there is none (the far worlds).
uniform highp sampler3D uVolume;
uniform vec4 uVolume3;
uniform vec3 uEye;
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

// How dark a corner is, by how many of the three blocks round it are there (0fps, 2013).
const float AO_CURVE[4] = float[4](0.42, 0.62, 0.82, 1.0);

// The face's four corners, interpolated across it the way its two triangles would be, with the
// diagonal flipped where the shading would otherwise smear across it.
float occlusion() {
  float a0 = AO_CURVE[int(vAo & 3u)];
  float a1 = AO_CURVE[int((vAo >> 2u) & 3u)];
  float a2 = AO_CURVE[int((vAo >> 4u) & 3u)];
  float a3 = AO_CURVE[int((vAo >> 6u) & 3u)];
  float u = clamp(vUv.x, 0.0, 1.0);
  float v = clamp(vUv.y, 0.0, 1.0);
  if (a0 + a2 < a1 + a3) {
    if (u + v <= 1.0) return a0 * (1.0 - u - v) + a1 * u + a3 * v;
    return a2 * (u + v - 1.0) + a1 * (1.0 - v) + a3 * (1.0 - u);
  }
  if (u >= v) return a0 * (1.0 - u) + a1 * (u - v) + a2 * v;
  return a0 * (1.0 - v) + a2 * u + a3 * (v - u);
}

// How much of the key light reaches this point, 0 to 1: the shadow map read in a 5 by 5 patch,
// so the edge of a shadow is soft by a few texels.
float lit(vec3 n, bool sunny, int kind) {
#ifdef QUICK
  return 1.0;
#endif
  if (uMapped == 0) return sunny ? 1.0 : 0.0;
  // Leaves sway after the map was drawn, so they keep a little further from their own shadow.
  float push = kind == 7 ? 0.16 : 0.04;
  vec4 at = uLight * vec4(vWorld + n * push, 1.0);
  vec3 s = at.xyz * 0.5 + 0.5;
  if (any(lessThan(s, vec3(0.0))) || any(greaterThan(s, vec3(1.0)))) return 1.0;
  // Five by five taps two texels apart: a shadow's edge is a soft band, not a line.
  float sum = 0.0;
  for (int dx = -2; dx <= 2; dx++)
    for (int dy = -2; dy <= 2; dy++)
      sum += texture(uShadowMap, vec3(s.xy + vec2(float(dx), float(dy)) * 2.0 * uMapTexel, s.z - 0.0006));
  return sum / 25.0;
}

// The baked light just in front of this surface, blended between cells: the sky it sees, and the
// placed lamps' light, straight and bounced, as one, twice what a byte holds (LAMP_SCALE).
vec2 baked(vec3 n) {
#ifdef QUICK
  return vec2(1.0, 0.0);
#endif
  if (uVolume3.x <= 0.0) return vec2(1.0, 0.0);
  vec3 p = vWorld + n * 0.55;
  vec3 q = vec3(p.x, p.y - uVolume3.w, p.z) / uVolume3.xyz;
  if (any(lessThan(q, vec3(0.0))) || any(greaterThan(q, vec3(1.0)))) return vec2(1.0, 0.0);
  vec3 v = texture(uVolume, q).rgb;
  // A block further out says which way the light comes from: more there, and this face is turned
  // toward it; less, and away, so the far side of a rack or a figure is a step darker, softly.
  vec3 f = texture(uVolume, q + n / uVolume3.xyz).rgb;
  float near = v.g + v.b;
  float far = f.g + f.b;
  float toward = clamp(0.5 + 1.5 * (far - near) / max(far + near, 0.02), 0.0, 1.0);
  return vec2(v.r, near * 2.0 * (0.4 + 0.6 * toward));
}

// Light hanging in the air between the eye and this point, walked back toward the eye for eight
// blocks: only where it is thick, close by a placed lamp (baked) or a light that moves (a torch),
// so it shows as a few beams and not as a haze over everything. 0 to 1.
float beams(float level) {
#ifdef QUICK
  return 0.0;
#endif
  if (uVolume3.x <= 0.0) return 0.0;
  vec3 back = normalize(uEye - vWorld);
  float sum = 0.0;
  for (int i = 1; i <= 12; i++) {
    vec3 p = vWorld + back * (float(i) * 0.65);
    vec3 q = vec3(p.x, p.y - uVolume3.w, p.z) / uVolume3.xyz;
    if (any(lessThan(q, vec3(0.0))) || any(greaterThan(q, vec3(1.0)))) continue;
    // Only where a lamp's light is thick, near it: a room's general glow is no beam.
    vec4 v = texture(uVolume, q);
    sum += max(0.0, v.g * 2.0 * level - 0.35) * 2.0;
    for (int k = 0; k < ${MAX_LIGHTS}; k++) {
      if (k >= uLightCount) break;
      float f = clamp(1.0 - distance(p, uLights[k].xyz) / uLights[k].w, 0.0, 1.0);
      sum += uLightOn[k] * max(0.0, f * f - 0.25);
    }
  }
  return clamp(sum * 0.16, 0.0, 0.8);
}

// How much of the room's main lamp reaches this point, 0 to 1, from its own map, 3 by 3.
float lampLit(vec3 n) {
#ifdef QUICK
  return 1.0;
#endif
  vec4 at = uLampView * vec4(vWorld + n * 0.06, 1.0);
  if (at.w <= 0.0) return 1.0;
  vec3 s = at.xyz / at.w * 0.5 + 0.5;
  if (any(lessThan(s, vec3(0.0))) || any(greaterThan(s, vec3(1.0)))) return 1.0;
  float sum = 0.0;
  for (int dx = -1; dx <= 1; dx++)
    for (int dy = -1; dy <= 1; dy++)
      sum += texture(uLampMap, vec3(s.xy + vec2(float(dx), float(dy)) / 1024.0, s.z - 0.0015));
  return sum / 9.0;
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
  bool open = (outdoors & (1 << vFace)) != 0;
  // A room with its switch only part-way up is still a room you can see into: the walls keep most
  // of their light and it is the lamps' warmth that dims.
  float level = uGroups[room];
  bool loose = uLoose > 0.5;
  // A room with its switch down is dim, never black: its walls keep a share of their light.
  float roomLight = (loose ? vRoomLit : uRoom[vFace]) * max(min(1.0, level * 8.0) * (0.6 + 0.4 * level), 0.55);

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

  // A room is a little paler than the rock it is cut from, so it reads as a room and not as more wall.
  if (!open) tone = mix(tone, 1.0, 0.3);
  // The rock a room is cut from is the margin of the picture, not the picture: it prints quieter.
  if (open && !loose && vWorld.y < -0.5) tone = mix(tone, 1.0, uRock);
  tone = clamp(tone, 0.0, 1.0);
  vec3 n = normalize(vNormal);
  float ao = occlusion();
  // Out of doors: the key where it reaches, and the sky's fill, white from above and a grey bounce
  // from the ground below, so a face turned away from the key is dark.
  float key = uKeyLight * max(dot(n, uKey), 0.0) * lit(n, (sunny & (1 << vFace)) != 0, kind);
  vec2 still = baked(n);
  // The sky's fill as much as the sky can be seen from here: under eaves, in corners and down the
  // dig it is shut out.
  // Most of it falls from straight above: the tops are the brightest faces, the sides take less.
  float up = n.y * 0.5 + 0.5;
  float sky = uFill * mix(0.3, 1.0, up * up) * mix(0.3, 1.0, still.x);
  // From inside a room, all that is out of doors is in the dark, however high the room is.
  float deep = loose ? 1.0 : 1.0 - uDeep;
  // Nothing is ever left in the black: light comes back off everything round about, the more
  // onto what faces up, so a face in shadow, underground or away from the key is a grey; and
  // twice as much where no sky is seen, since light shut in goes round and round.
  float around = uAmbient * mix(0.7, 1.0, n.y * 0.5 + 0.5) * mix(2.0, 1.0, still.x);
  float light = open ? max((key + sky) * deep, around) : max(roomLight * uRoomFill, around);
  float lum = tone * light * ao;

  // The lamps: a room's light that room, the ones outdoors the outdoors. Each falls off with
  // distance and lights the faces turned to it; the room's main lamp casts a shadow.
  // The placed lamps, baked with their shadows and the light they bounce, by how far up their
  // switch is: eased, so a room turned low still glows. A room seen from out of doors (the column,
  // a cutaway) is a lit window in a dark wall, so its lamps count for more there.
  float lamp = still.y * sqrt(uGroups[open ? 1 : room]) * (open ? 1.0 : uWindows);
  // A room's rock walls stand close beside its lamps and face them square on, so a lamp would
  // light a round pool on a wall, bright to its rim: there its light falls away sooner, and the
  // pool fades into the wall's dark the way the floor's does.
  bool wall = !open && abs(n.y) < 0.5 && (kind == 2 || kind == 3 || kind == 4 || kind == 5 || kind == 14);
#ifndef QUICK
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= uLightCount) break;
    // A room's lamps light that room; the lamps outdoors light the outdoors. Rock is not glass.
    float mine = open ? 1.0 : float(room);
    if (abs(uLightGroup[i] - mine) > 0.5) continue;
    vec3 to = uLights[i].xyz - vWorld;
    float d = length(to);
    float f = clamp(1.0 - d / uLights[i].w, 0.0, 1.0);
    float facing = 0.4 + 0.6 * max(dot(n, to / max(d, 0.001)), 0.0);
    float shadow = i == uTorch ? lampLit(n) : 1.0;
    lamp += uLightOn[i] * f * f * (wall ? f * 0.8 : 1.0) * facing * shadow;
  }
#endif
  float warmth = tone * lamp * uLampGain * ao;
  lum += warmth;

  // What glows: a lit window, a lamp, a torch. The second pass prints it solid and its blur warm.
  float glow = 0.0;
  if (group > 0 && (kind == 12 || kind == 13 || kind == 22)) glow = uGroups[group];
  // A room seen from out of doors and far off (the column) is a lit window: with its switch up,
  // its inside prints solid warm with a glow round it, so it reads at that size. Close to, as in
  // the vault or a cutaway, it is drawn as a room.
  float far = smoothstep(120.0, 200.0, distance(uEye, vWorld));
  if (!open && !loose && room > 0) glow = max(glow, uGroups[room] * smoothstep(2.0, 5.0, uWindows) * far);

  // Which flat plane this is: the way it faces, how far along that way, and what it's made of.
  int axis = vFace % 3;
  float along = axis == 0 ? vCell.y : (axis == 1 ? vCell.x : vCell.z);
  float plane = along + (vFace < 3 ? 1.0 : 0.0);
  float id = float(vFace) * 7.0 + plane * 13.0 + float(kind) * 31.0;
  bool gridded = kind == 16 || kind == 15 || kind == 18 || kind == 13 || kind == 12;
  if (gridded) id += dot(vCell, vec3(3.0, 17.0, 5.0));
  // The block the cursor is on: bare paper with a line round it, the way the game marks one.
  if (all(equal(vCell, uPick))) {
    lum = 2.0;
    warmth = 0.0;
    glow = 0.0;
    id += 977.0 + dot(vCell, vec3(3.0, 17.0, 5.0));
  }
  id = mod(id + 8192.0, 65535.0) + 1.0;
  // Brightness is kept at half, so light past white still has room before the tone curve.
  // Blue is how much of the light here is lamplight, where there is enough of it to show: the
  // second pass prints that share warm, at most three dots in five, so a lamp-lit wall stays a wall.
  // The alpha carries the dust of a beam in front of this point, for the second pass to scatter.
  float dust = loose ? 0.0 : beams(uGroups[open ? 1 : room]);
  // A beam is light in the air: what is seen through it is seen paler and warmer.
  lum += dust * 0.9;
  warmth += dust * 0.2;
  o0 = vec4(clamp(lum * 0.5, 0.0, 1.0), glow, clamp(warmth / max(lum, 0.001), 0.0, 1.0) * 0.6 * smoothstep(0.0, 0.6, warmth), 1.0 - 0.4 * dust);
  // (Half marks a part that is thinning: no line is drawn round its scattered dots.)
  o1 = vec4(mod(id, 256.0) / 255.0, floor(id / 256.0) / 255.0, vFog, ghost ? 0.5 : 1.0);
}`

/** The same pass without the shadows and the lamps: quick to compile, for the first frames. */
export const QUICK_FRAG = SCENE_FRAG.replace('#version 300 es\n', '#version 300 es\n#define QUICK\n')
