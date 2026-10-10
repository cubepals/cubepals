# SPDX-FileCopyrightText: 2026 The Cubepals Authors
#
# SPDX-License-Identifier: AGPL-3.0-only

# /// script
# requires-python = ">=3.12"
# ///
"""Batch 5: exploration variants with a generation-lag metric, a second memory floor, CPU floors."""
import math, sys, time
import mcb
from suite2 import MODS, BIG, RING, bulk, origin, measure, Explorer, floor


def ahead_loaded(s, bots, dist=64):
    """Fraction of bots whose chunk `dist` blocks ahead is fully loaded (players would otherwise see holes)."""
    ok = 0
    for n, dx, dz in bots:
        out = s.rcon(f'execute as {n} at @s if loaded ~{dx * dist:.0f} ~ ~{dz * dist:.0f}')
        ok += 'passed' in out.lower()
    return ok / len(bots)


def explore(tag, n, together, speed=10, cpus=2, k=0, secs=180, vd=10, sd=10, heap=2048, mem=3072):
    s = mcb.Server(f'exp-{tag}', type_='FABRIC', cpus=cpus, vd=vd, sd=sd, heap_mb=heap, mem_mb=mem, env={'MODRINTH_PROJECTS': MODS}, volume=BIG)
    s.start()
    out = {'players': n, 'together': together, 'speed': speed, 'cpus': cpus, 'vd': vd, 'sd': sd}
    ox, oz = origin(k)
    bots = []
    for i in range(n):
        if together:
            dx, dz = 1.0, 0.0
            mcb.spawn_bot(s, f'b{i}', ox + 6 * i, oz + 6 * (i % 3))
        else:
            dx, dz = RING[i * (10 // n) % 10]
            mcb.spawn_bot(s, f'b{i}', ox + int(dx * 300), oz + int(dz * 300))
        bots.append((f'b{i}', dx, dz))
    time.sleep(20)
    before = s.world_bytes().get('total', 0)
    ex = Explorer(s, bots, speed)
    s.set_phase('explore')
    samples = []
    t = time.time()
    while time.time() - t < secs:
        time.sleep(10)
        samples.append(ahead_loaded(s, bots))
    ex.stop.set()
    snap = s.snapshot('explore')
    after = snap['world'].get('total', 0)
    out['explore'] = {'window': s.window('explore'), 'snap': snap}
    out['world_growth_mb'] = round((after - before) / 2**20, 1)
    out['world_growth_mb_per_hour'] = round((after - before) / 2**20 / secs * 3600)
    out['ahead_loaded_frac'] = round(sum(samples) / len(samples), 2) if samples else None
    out['ahead_samples'] = samples
    mcb.record(f'exp-{tag}', out)
    s.stop(remove_volume=False)


def spread_floor(heap, mem, cpus=2):
    """10 bots spread apart in pregenerated terrain (heaviest steady workload measured), vd 10 / sd 10."""
    name = f'floor10-h{heap}-m{mem}-c{cpus}'
    s = mcb.Server(name, type_='FABRIC', cpus=cpus, heap_mb=heap, mem_mb=mem, env={'MODRINTH_PROJECTS': MODS}, volume=BIG)
    ok = s.start()
    out = {'heap': heap, 'mem': mem, 'cpus': cpus, 'booted': ok}
    if ok:
        try:
            for i, (x, z) in enumerate(RING):
                mcb.spawn_bot(s, f'b{i}', int(x * 1500), int(z * 1500))
            measure(s, 'load', 240, out)
        except Exception as e:
            out['error'] = repr(e)
    out['alive'] = s.alive()
    out['oom'] = s.oom_killed()
    out['log_tail'] = mcb.sh(f'docker logs {s.name} 2>&1 | grep -iE "OutOfMemory|Can.t keep up|overloaded" | tail -5')
    out['events'] = [e for e in s.events if e['event'] in ('ready', 'died_during_boot', 'boot_timeout')]
    mcb.record(name, out)
    s.stop(remove_volume=False)


which = sys.argv[1]
if which == 'explore':
    explore('1-sep-10bps', 1, False, k=60)
    explore('1-sep-20bps', 1, False, speed=20, k=61)
    explore('5-sep', 5, False, k=62)
    explore('5-together', 5, True, k=63)
    explore('10-sep', 10, False, k=64)
    explore('10-together', 10, True, k=65)
    explore('10-sep-4cpu', 10, False, cpus=4, k=66)
    explore('5-sep-1cpu', 5, False, cpus=1, k=67)
    explore('5-sep-vd6', 5, False, k=68, vd=6, sd=4)
elif which == 'floor':
    for heap in [3072, 2048, 1536, 1024, 768]:
        spread_floor(heap, heap + 1024)
    # CPU floors on the lighter floor workload (3 spread + 2 exploring), 2 GB heap
    k = 80
    for c in [0.5, 1]:
        floor(2048, 3072, k, tag=f'floor-cpu{c}', cpus=c); k += 1
    spread_floor(2048, 3072, cpus=1)
    spread_floor(2048, 3072, cpus=4)
