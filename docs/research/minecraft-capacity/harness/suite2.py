# /// script
# requires-python = ">=3.12"
# ///
"""Batch 2: world growth, distances, player scenarios, entities, memory floor. Fabric 26.3 + Carpet bots."""
import math, subprocess, sys, threading, time
import mcb
from suite1 import chunky

MODS = 'fabric-api,carpet,chunky'
BIG = 'mcb-world-big'  # pregenerated world, kept across runs of this batch


def bulk(s, commands):
    """Sends many commands through one interactive rcon-cli session."""
    subprocess.run(['docker', 'exec', '-i', s.name, 'rcon-cli'], input='\n'.join(commands) + '\n',
                   capture_output=True, text=True, timeout=600)


class Explorer:
    """Moves bots outward in straight lines at `speed` blocks/s by teleporting once a second."""
    def __init__(self, s, bots, speed):
        self.s, self.bots, self.speed = s, bots, speed  # bots: [(name, dx, dz)] unit vectors
        self.stop = threading.Event()
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        while not self.stop.is_set():
            bulk(self.s, [f'execute as {n} at @s run tp @s ~{dx * self.speed:.1f} 150 ~{dz * self.speed:.1f}' for n, dx, dz in self.bots])
            self.stop.wait(1)


def measure(s, phase, secs, out):
    s.set_phase(phase)
    time.sleep(secs)
    snap = s.snapshot(phase)
    out[phase] = {'window': s.window(phase), 'snap': snap}
    return out[phase]


def growth():
    s = mcb.Server('growth', type_='FABRIC', cpus=4, env={'MODRINTH_PROJECTS': MODS}, volume=BIG)
    s.start()
    out = {}
    before = s.world_bytes()
    out['fresh'] = before
    for r in [256, 512, 1024, 2048]:
        s.set_phase(f'ow-r{r}')
        t = time.time()
        line = chunky(s, r)
        out[f'ow-r{r}'] = {'line': line, 'secs': round(time.time() - t), 'window': s.window(f'ow-r{r}'),
                           'world': s.world_bytes()}
        mcb.record('growth-step', {'radius': r, **out[f'ow-r{r}']})
    for dim in ['minecraft:the_nether', 'minecraft:the_end']:
        s.set_phase(dim)
        t = time.time()
        line = chunky(s, 512, dim)
        out[dim] = {'line': line, 'secs': round(time.time() - t), 'window': s.window(dim), 'world': s.world_bytes()}
        mcb.record('growth-step', {'dim': dim, **out[dim]})
    s.rcon('save-all flush')
    time.sleep(10)
    out['final_world'] = s.world_bytes()
    s.stop(remove_volume=False)
    # backup sizes of the same world, with common compressors
    b = mcb.sh(['docker', 'run', '--rm', '-v', f'{BIG}:/data:ro', 'alpine', 'sh', '-c',
                'apk add -q zstd >/dev/null; cd /data; echo RAW $(du -sb world | cut -f1); '
                'echo GZIP6 $(tar -cf - world | gzip -6 | wc -c); echo ZSTD3 $(tar -cf - world | zstd -3 -T0 -q | wc -c); '
                'echo ZSTD19 $(tar -cf - world | zstd -19 -T0 -q | wc -c)'], timeout=3600)
    out['backup'] = b
    mcb.record('growth', out)
    # restart on a big existing world
    s2 = mcb.Server('restart-big', type_='FABRIC', cpus=4, env={'MODRINTH_PROJECTS': MODS}, volume=BIG)
    s2.start()
    s2.set_phase('idle'); time.sleep(60)
    snap = s2.snapshot('idle')
    s2.stop(remove_volume=False)
    mcb.record('restart-big', {'events': s2.events, 'idle': snap})


def compression(kind):
    s = mcb.Server(f'compress-{kind}', type_='FABRIC', cpus=4, env={'MODRINTH_PROJECTS': MODS, 'REGION_FILE_COMPRESSION': kind})
    s.start()
    s.set_phase('gen')
    t = time.time()
    line = chunky(s, 512)
    s.rcon('save-all flush'); time.sleep(10)
    mcb.record(f'compress-{kind}', {'line': line, 'secs': round(time.time() - t), 'window': s.window('gen'), 'world': s.world_bytes()})
    s.stop()


def origin(k):
    """A far-away, never-generated spot per exploring run so runs never re-walk each other's terrain."""
    return k * 10000, 60000


RING = [(math.cos(2 * math.pi * i / 10), math.sin(2 * math.pi * i / 10)) for i in range(10)]


def distances():
    for k, (vd, sd) in enumerate([(6, 4), (8, 6), (10, 10), (12, 12), (16, 16)]):
        s = mcb.Server(f'dist-{vd}-{sd}', type_='FABRIC', cpus=2, vd=vd, sd=sd, env={'MODRINTH_PROJECTS': MODS}, volume=BIG)
        s.start()
        out = {'vd': vd, 'sd': sd}
        measure(s, 'idle', 45, out)
        mcb.sh(['docker', 'exec', s.name, 'rcon-cli', 'player b0 spawn at 0 150 0 facing 0 0 in minecraft:overworld in creative'])
        measure(s, '1-bot', 90, out)
        for i in range(1, 5):
            mcb.spawn_bot(s, f'b{i}', 8 * i, 0)
        measure(s, '5-together', 90, out)
        for i in range(5):
            x, z = RING[i * 2]
            s.rcon(f'tp b{i} {int(x * 1500)} 150 {int(z * 1500)}')
        measure(s, '5-spread', 90, out)
        # explore outward from the pregenerated edge, 1 bot, 20 blocks/s (between sprint-flying and elytra)
        for i in range(1, 5):
            mcb.kill_bot(s, f'b{i}')
        ox, oz = origin(k)
        s.rcon(f'tp b0 {ox} 150 {oz}')
        time.sleep(20)
        ex = Explorer(s, [('b0', 1, 0)], 20)
        measure(s, '1-explore', 150, out)
        ex.stop.set()
        mcb.record(f'dist-{vd}-{sd}', out)
        s.stop(remove_volume=False)


def players(cpus=2, tag='', k=10):
    s = mcb.Server(f'players{tag}', type_='FABRIC', cpus=cpus, env={'MODRINTH_PROJECTS': MODS}, volume=BIG)
    s.start()
    out = {'cpus': cpus}
    measure(s, 'idle', 45, out)
    for i in range(10):
        mcb.spawn_bot(s, f'b{i}', 6 * (i % 5), 6 * (i // 5))
    measure(s, '10-together', 120, out)
    for i, (x, z) in enumerate(RING):
        s.rcon(f'tp b{i} {int(x * 1500)} 150 {int(z * 1500)}')
    measure(s, '10-spread', 120, out)
    for i in range(10):
        dim = 'minecraft:overworld' if i < 4 else 'minecraft:the_nether' if i < 7 else 'minecraft:the_end'
        x, z = RING[i]
        r = 1500 if i < 4 else 250 if i < 7 else 300
        s.rcon(f'execute in {dim} run tp b{i} {int(x * r)} 150 {int(z * r)}')
    measure(s, '10-dims', 120, out)
    ox, oz = origin(k)
    for i, (x, z) in enumerate(RING):
        s.rcon(f'execute in minecraft:overworld run tp b{i} {ox + int(x * 400)} 150 {oz + int(z * 400)}')
    time.sleep(20)
    ex = Explorer(s, [(f'b{i}', x, z) for i, (x, z) in enumerate(RING)], 10)
    measure(s, '10-explore', 180, out)
    ex.stop.set()
    mcb.record(f'players{tag}', out)
    s.stop(remove_volume=False)


def entities():
    s = mcb.Server('entities', type_='FABRIC', cpus=2, env={'MODRINTH_PROJECTS': MODS}, volume=BIG)
    s.start()
    out = {}
    s.rcon('gamerule doMobSpawning false'); s.rcon('gamerule spawn_mobs false')
    s.rcon('fill -40 199 -40 40 204 40 glass hollow')
    mcb.spawn_bot(s, 'b0', 0, 0, y=201)
    measure(s, 'baseline', 60, out)
    total = 0
    for target in [250, 500, 1000, 2000]:
        cmds = [f'summon cow {(-38 + (i * 7) % 76)} 201 {(-38 + (i * 13) % 76)}' for i in range(target - total)]
        bulk(s, cmds)
        total = target
        measure(s, f'cows-{target}', 90, out)
        out[f'cows-{target}']['entities'] = s.entities()
    s.rcon('kill @e[type=cow]')
    time.sleep(5)
    total = 0
    for target in [100, 250, 500]:
        cmds = [f'summon villager {(-38 + (i * 7) % 76)} 201 {(-38 + (i * 13) % 76)}' for i in range(target - total)]
        bulk(s, cmds)
        total = target
        measure(s, f'villagers-{target}', 90, out)
    mcb.record('entities', out)
    s.stop(remove_volume=False)


def floor(heap, mem, k, tag=None, pretouch=True, cpus=2):
    """Same workload at a given heap/container size: 3 bots spread + 2 exploring at 10 b/s, vd 10/sd 10."""
    name = tag or f'floor-h{heap}-m{mem}'
    s = mcb.Server(name, type_='FABRIC', cpus=cpus, heap_mb=heap, mem_mb=mem, pretouch=pretouch,
                   env={'MODRINTH_PROJECTS': MODS}, volume=BIG)
    ok = s.start()
    out = {'heap': heap, 'mem': mem, 'pretouch': pretouch, 'booted': ok}
    if ok:
        try:
            measure(s, 'idle', 45, out)
            for i in range(5):
                x, z = RING[i * 2]
                mcb.spawn_bot(s, f'b{i}', int(x * 1200), int(z * 1200))
            ox, oz = origin(k)
            s.rcon(f'tp b3 {ox} 150 {oz}'); s.rcon(f'tp b4 {ox} 150 {oz + 3000}')
            time.sleep(10)
            ex = Explorer(s, [('b3', 1, 0), ('b4', -1, 0)], 10)
            measure(s, 'load', 240, out)
            ex.stop.set()
        except Exception as e:
            out['error'] = repr(e)
    out['alive'] = s.alive()
    out['oom'] = s.oom_killed()
    out['log_tail'] = mcb.sh(f'docker logs {s.name} 2>&1 | grep -iE "OutOfMemory|Can.t keep up|overloaded" | tail -5')
    out['events'] = [e for e in s.events if e['event'] in ('ready', 'died_during_boot', 'boot_timeout')]
    mcb.record(name, out)
    s.stop(remove_volume=False)


which = sys.argv[1]
if which == 'growth':
    growth()
    compression('lz4')
    compression('none')
    compression('deflate')
elif which == 'distances':
    distances()
elif which == 'players':
    players(2, '', 10)
    players(4, '-4cpu', 11)
    players(1, '-1cpu', 12)
elif which == 'entities':
    entities()
elif which == 'floor':
    k = 20
    for heap in [2048, 1536, 1024, 768, 512, 384]:
        floor(heap, heap + 1024, k); k += 1
    # container ceiling with a fixed 1 GB heap: how much native memory is needed
    for mem in [1536, 1408, 1280, 1152]:
        floor(1024, mem, k); k += 1
    floor(3072, 4096, k, tag='floor-blockly4g-nopretouch', pretouch=False)
