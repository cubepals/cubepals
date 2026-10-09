# /// script
# requires-python = ">=3.12"
# ///
"""Batch 4: modpacks from Modrinth via the itzg image's TYPE=MODRINTH, light to heavy."""
import sys, time
import mcb
from suite1 import chunky

PACKS = [  # (tag, modrinth slug, game version for the java tag)
    ('light-cobblemon', 'cobblemon-fabric', '1.21.1'),
    ('medium-createplus', 'create_plus', '1.21.1'),
    ('heavy-prominence2', 'prominence-2-fabric', '1.20.1'),
]


def pack(tag, slug, version, heap, mem, gen=True, env=None):
    s = mcb.Server(f'pack-{tag}-h{heap}', version=version, type_='MODRINTH', cpus=4, heap_mb=heap, mem_mb=mem,
                   env={'MODRINTH_MODPACK': slug, 'MODRINTH_PROJECTS': 'chunky', **(env or {})})
    ok = s.start(timeout=1500)
    out = {'slug': slug, 'heap': heap, 'mem': mem, 'booted': ok,
           'events': [e for e in s.events if e['event'] in ('ready', 'died_during_boot', 'boot_timeout')]}
    if ok:
        out['mods'] = mcb.sh(['docker', 'exec', s.name, 'sh', '-c', 'ls /data/mods | wc -l; du -sb /data/mods | cut -f1'])
        s.set_phase('idle'); time.sleep(90)
        out['idle'] = s.snapshot('idle'); out['idle_window'] = s.window('idle')
        if gen:
            s.set_phase('gen'); t = time.time()
            out['chunky_line'] = chunky(s, 256)
            out['gen_secs'] = round(time.time() - t)
            out['gen_window'] = s.window('gen'); out['gen'] = s.snapshot('gen')
    out['oom'] = s.oom_killed()
    out['log_tail'] = mcb.sh(f'docker logs {s.name} 2>&1 | grep -iE "OutOfMemory|Can.t keep up|Exception" | tail -3')
    mcb.record(f'pack-{tag}-h{heap}', out)
    s.stop()


if sys.argv[1] == 'packs':
    for tag, slug, v in PACKS:
        pack(tag, slug, v, 5120, 6656)
    for tag, slug, v in PACKS:
        pack(tag, slug, v, 2048, 3072, gen=False)
