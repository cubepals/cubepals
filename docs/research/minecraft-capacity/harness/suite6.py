# /// script
# requires-python = ">=3.12"
# ///
"""Batch 6: the REQUIRED local runs only, polite to the host.

Every run is capped at 2 CPUs (4 for none), one at a time, and waits while the Mac is busy.
"""
import os, subprocess, sys, time
import mcb
from suite2 import MODS, BIG, RING, measure, floor
from suite5 import explore, spread_floor
from suite4 import pack
from suite3 import net_run


def host_busy():
    """True when the Mac is busy: 1-minute load above 6 of 10 cores, or critical memory pressure (level 4).

    Level 2 (warning) is the benchmark host's steady state with Docker Desktop running, so it only shortens runs.
    """
    load1 = float(subprocess.run(['sysctl', '-n', 'vm.loadavg'], capture_output=True, text=True).stdout.split()[1])
    level = subprocess.run(['sysctl', '-n', 'kern.memorystatus_vm_pressure_level'], capture_output=True, text=True).stdout.strip()
    return load1 > 6 or level == '4', f'load1={load1} pressure={level}'


def polite():
    waited = 0
    while True:
        busy, why = host_busy()
        if busy and waited >= 900:
            print(f'host still busy after 15 min ({why}); proceeding with a 2-CPU run anyway', flush=True)
            return
        if not busy:
            return
        if waited % 300 == 0:
            print(f'host busy ({why}), backing off', flush=True)
        time.sleep(30); waited += 30


def vanilla_baseline():
    s = mcb.Server('base-vanilla-26.3', type_='VANILLA', cpus=2)
    s.start()
    out = {'version': '26.3', 'type': 'VANILLA', 'cpus': 2, 'heap_mb': s.heap_mb, 'mem_mb': s.mem_mb,
           'ready': next(e for e in s.events if e['event'] == 'ready')}
    measure(s, 'idle', 90, out)
    s.stop(remove_volume=False)
    s2 = mcb.Server('base-vanilla-26.3-restart', type_='VANILLA', cpus=2, volume=s.volume)
    s2.start()
    out['restart_ready'] = next(e for e in s2.events if e['event'] == 'ready')
    s2.stop()
    out['stop_events'] = [e for e in s.events + s2.events if e['event'] == 'stopped']
    mcb.record('base-vanilla-26.3', out)


STEPS = {
    'baseline': vanilla_baseline,
    'explore-5-sep': lambda: explore('5-sep', 5, False, k=62),
    'explore-5-together': lambda: explore('5-together', 5, True, k=63),
    'floor-h1024': lambda: floor(1024, 2048, 30),
    'floor-h768': lambda: floor(768, 1792, 31),
    'floor-h512': lambda: floor(512, 1536, 32),
    'floor-h1024-m1280': lambda: floor(1024, 1280, 33),
    'floor-h1024-m1152': lambda: floor(1024, 1152, 34),
    'floor10-h1024': lambda: spread_floor(1024, 2048),
    'net-5': lambda: net_run('5-vd10', 5, k=41),
    'net-5b': lambda: net_run('5-vd10-b', 5, k=49),
    'pack-medium-pixelmon': lambda: pack('medium-pixelmon', 'the-pixelmon-modpack', '1.21.1', 3072, 4096),
    'pack-light': lambda: pack('light-cobblemon', 'cobblemon-fabric', '1.21.1', 3072, 4096),
    'pack-medium': lambda: pack('medium-createplus', 'create_plus', '1.21.1', 3072, 4096, env={'MODRINTH_MODPACK_VERSION_TYPE': 'alpha'}),
}

if __name__ == '__main__':
    for name in sys.argv[1:]:
        polite()
        print(f'=== {name} {time.strftime("%T")}', flush=True)
        STEPS[name]()
        mcb.sh("docker ps -a --format '{{.Names}}' | grep '^mcb-' | grep -v '^mcb-world' | xargs -r docker rm -f")
