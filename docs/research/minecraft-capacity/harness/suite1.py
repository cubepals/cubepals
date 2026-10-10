# SPDX-FileCopyrightText: 2026 The Cubepals Authors
#
# SPDX-License-Identifier: AGPL-3.0-only

# /// script
# requires-python = ">=3.12"
# ///
"""Batch 1: versions, implementations, CPU scaling of chunk generation."""
import re, sys, time
import mcb


def finished_count(s):
    return int(mcb.sh(f'docker logs {s.name} 2>&1 | grep -ciE "Task finished|Task (stopped|cancelled)"').strip() or 0)


def wait_chunky(s, before, timeout=3600, stall_s=180):
    """Waits for Chunky's completion line in the log. Gives up if progress stops moving for stall_s."""
    t = time.time()
    last, last_change = None, time.time()
    while time.time() - t < timeout:
        prog = s.rcon('chunky progress')
        m = re.search(r'Processed: ([\d,]+) chunks', prog)
        if m and m.group(1) != last:
            last, last_change = m.group(1), time.time()
        elif time.time() - last_change > stall_s:
            return 'stalled: ' + prog.strip()[-160:]
        if finished_count(s) > before:
            log = mcb.sh(f'docker logs {s.name} 2>&1 | grep -iE "Task finished|Task (stopped|cancelled)" | tail -1')
            return log.strip()[-160:]
        if not s.alive():
            return 'died'
        time.sleep(3)
    return 'timeout'


def chunky(s, radius, dim='minecraft:overworld', shape='square'):
    s.rcon('chunky quiet 30')
    s.rcon(f'chunky world {dim}')
    s.rcon('chunky center 0 0')
    s.rcon(f'chunky shape {shape}')
    s.rcon(f'chunky radius {radius}')
    s.rcon('chunky confirm')
    before = finished_count(s)
    print(s.rcon('chunky start'))
    s.rcon('chunky confirm')
    return wait_chunky(s, before)


def boot_idle_gen(run, version, type_, mods, cpus=4, radius=512, gen=True, heap=3072, mem=4096, env=None):
    e = dict(env or {})
    if mods:
        e['MODRINTH_PROJECTS'] = mods
    s = mcb.Server(run, version=version, type_=type_, cpus=cpus, heap_mb=heap, mem_mb=mem, env=e)
    if not s.start():
        s.stop(); mcb.record(run, {'error': 'boot failed', 'events': s.events}); return
    ready = next(e for e in s.events if e['event'] == 'ready')
    s.set_phase('idle')
    time.sleep(90)
    idle = s.snapshot('idle')
    idle_w = s.window('idle')
    out = {'version': version, 'type': type_, 'mods': mods, 'cpus': cpus, 'ready': ready, 'idle': idle, 'idle_window': idle_w}
    if gen:
        s.set_phase('gen')
        t = time.time()
        out['chunky_line'] = chunky(s, radius)
        out['gen_secs'] = round(time.time() - t, 1)
        out['gen_window'] = s.window('gen')
        out['gen'] = s.snapshot('gen')
    mcb.record(run, out)
    s.stop()


which = sys.argv[1]
if which == 'versions':
    for v in ['1.16.5', '1.18.2', '1.20.6', '1.21.11', '26.3']:
        boot_idle_gen(f'ver-vanilla-{v}', v, 'VANILLA', None, gen=False)
        boot_idle_gen(f'ver-fabric-{v}', v, 'FABRIC', 'fabric-api,chunky')
elif which == 'versions2':
    boot_idle_gen('ver-fabric-1.18.2', '1.18.2', 'FABRIC', 'fabric-api,chunky')
    for v in ['1.20.6', '1.21.11', '26.3']:
        boot_idle_gen(f'ver-vanilla-{v}', v, 'VANILLA', None, gen=False)
        boot_idle_gen(f'ver-fabric-{v}', v, 'FABRIC', 'fabric-api,chunky')
elif which == 'impls2':
    alpha = {'MODRINTH_ALLOWED_VERSION_TYPE': 'alpha'}
    boot_idle_gen('impl-neoforge-26.3', '26.3', 'NEOFORGE', 'chunky', env={'NEOFORGE_VERSION': '26.3.0.6-beta'})
    boot_idle_gen('impl-fabric-opt-26.3', '26.3', 'FABRIC', 'fabric-api,chunky,lithium,ferrite-core,c2me-fabric,scalablelux', env=alpha)
    for c in [1, 2, 4, 8]:
        boot_idle_gen(f'cpu-fabric-c2me-{c}', '26.3', 'FABRIC', 'fabric-api,chunky,c2me-fabric', cpus=c, env=alpha)
elif which == 'impls':
    boot_idle_gen('impl-paper-26.3', '26.3', 'PAPER', 'chunky')
    boot_idle_gen('impl-fabric-opt-26.3', '26.3', 'FABRIC', 'fabric-api,chunky,lithium,ferrite-core,c2me-fabric,scalablelux')
    boot_idle_gen('impl-fabric-lithium-26.3', '26.3', 'FABRIC', 'fabric-api,chunky,lithium,ferrite-core')
    boot_idle_gen('impl-neoforge-26.3', '26.3', 'NEOFORGE', 'chunky')
elif which == 'cpus':
    for c in [1, 2, 4, 8]:
        boot_idle_gen(f'cpu-fabric-{c}', '26.3', 'FABRIC', 'fabric-api,chunky', cpus=c)
    for c in [1, 2, 4]:
        boot_idle_gen(f'cpu-paper-{c}', '26.3', 'PAPER', 'chunky', cpus=c)
    boot_idle_gen('cpu-fabric-c2me-4', '26.3', 'FABRIC', 'fabric-api,chunky,c2me-fabric', cpus=4)
    boot_idle_gen('cpu-fabric-c2me-8', '26.3', 'FABRIC', 'fabric-api,chunky,c2me-fabric', cpus=8)
