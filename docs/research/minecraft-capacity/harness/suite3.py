# SPDX-FileCopyrightText: 2026 The Cubepals Authors
#
# SPDX-License-Identifier: AGPL-3.0-only

# /// script
# requires-python = ">=3.12"
# ///
"""Batch 3: network with real protocol clients (mineflayer) on 1.21.11 (newest version mineflayer supports well).

Egress = container eth0 TX (server -> clients), ingress = RX. Phases:
  join              bots connect 3 s apart; bytes per join = TX over the phase / bots
  idle-grouped      all bots standing at spawn
  move-local        bots circle spawn (radius 48, ~5 b/s) inside already generated terrain
  explore-separate  each bot flies its own line through fresh terrain at 20 b/s
  explore-together  all bots fly one shared line through fresh terrain at 20 b/s
"""
import math, os, subprocess, sys, time
import mcb
from suite2 import bulk, origin

NET = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'net')
VERSION = '1.21.11'


def phase(s, name, secs, out, bots):
    s.set_phase(name)
    t0 = s._probe(); time.sleep(secs); t1 = s._probe()
    w = s.window(name)
    tx, rx = t1['tx'] - t0['tx'], t1['rx'] - t0['rx']
    out[name] = {'secs': secs, 'tx_bytes': tx, 'rx_bytes': rx,
                 'tx_kb_s': round(tx / 1024 / secs, 1), 'rx_kb_s': round(rx / 1024 / secs, 1),
                 'tx_mb_per_player_min': round(tx / 2**20 / bots / secs * 60, 2) if bots else None,
                 'rx_kb_per_player_min': round(rx / 1024 / bots / secs * 60, 1) if bots else None,
                 'window': w}
    print(name, out[name], flush=True)


def ticker(s, commands_fn, secs):
    stop = time.time() + secs
    i = 0
    while time.time() < stop:
        bulk(s, commands_fn(i)); i += 1
        time.sleep(1)


def net_run(tag, bots, vd=10, threshold=256, k=40, cpus=2, type_='VANILLA'):
    s = mcb.Server(f'net-{tag}', version=VERSION, type_=type_, cpus=cpus, vd=vd, sd=min(vd, 10),
                   env={'NETWORK_COMPRESSION_THRESHOLD': str(threshold), 'ALLOW_FLIGHT': 'TRUE', 'MODE': 'creative'})
    if not s.start():
        mcb.record(f'net-{tag}', {'error': 'boot failed'}); s.stop(); return
    port = mcb.sh(f'docker port {s.name} 25565').splitlines()[0].split(':')[-1].strip()
    out = {'version': VERSION, 'type': type_, 'bots': bots, 'vd': vd, 'threshold': threshold, 'cpus': cpus,
           'heap_mb': s.heap_mb, 'mem_mb': s.mem_mb}
    phase(s, 'idle-empty', 30, out, 0)
    s.set_phase('join')
    t0 = s._probe()
    proc = subprocess.Popen(['bun', 'run', 'bots.ts', port, str(bots), VERSION, '3000'], cwd=NET,
                            stdout=open(os.path.join(mcb.OUT, f'net-{tag}.bots.log'), 'w'), stderr=subprocess.STDOUT)
    time.sleep(bots * 3 + 30)
    t1 = s._probe()
    out['join'] = {'tx_bytes': t1['tx'] - t0['tx'], 'rx_bytes': t1['rx'] - t0['rx'],
                   'tx_mb_per_join': round((t1['tx'] - t0['tx']) / 2**20 / bots, 2), 'window': s.window('join')}
    out['online'] = s.rcon('list').strip()
    time.sleep(30)  # let join chunk sending finish before measuring idle
    phase(s, 'idle-grouped', 60, out, bots)
    s.set_phase('move-local')
    ang = lambda i, j: 2 * math.pi * (j * 0.1 + i / max(bots, 1))
    t0 = s._probe(); ticker(s, lambda j: [f'tp net{i} {4 * (j % 30) if (j // 30) % 2 == 0 else 4 * (30 - j % 30)} 100 {i * 4}' for i in range(bots)], 60)
    t1 = s._probe()
    out['move-local'] = {'tx_bytes': t1['tx'] - t0['tx'], 'rx_bytes': t1['rx'] - t0['rx'],
                         'tx_mb_per_player_min': round((t1['tx'] - t0['tx']) / 2**20 / bots, 2), 'window': s.window('move-local')}
    ox, oz = origin(k)
    bulk(s, [f'tp net{i} {ox + i * 1500} 150 {oz}' for i in range(bots)]); time.sleep(15)
    s.set_phase('explore-separate')
    t0 = s._probe(); ticker(s, lambda j: [f'execute as net{i} at @s run tp @s ~0 150 ~20' for i in range(bots)], 90)
    t1 = s._probe()
    out['explore-separate'] = {'tx_bytes': t1['tx'] - t0['tx'], 'rx_bytes': t1['rx'] - t0['rx'],
                               'tx_mb_per_player_min': round((t1['tx'] - t0['tx']) / 2**20 / bots / 1.5, 2),
                               'window': s.window('explore-separate')}
    bulk(s, [f'tp net{i} {ox - 3000 + i} 150 {oz}' for i in range(bots)]); time.sleep(15)
    s.set_phase('explore-together')
    t0 = s._probe(); ticker(s, lambda j: [f'tp net{i} {ox - 3000 + i} 150 {oz + 20 * j}' for i in range(bots)], 90)
    t1 = s._probe()
    out['explore-together'] = {'tx_bytes': t1['tx'] - t0['tx'], 'rx_bytes': t1['rx'] - t0['rx'],
                               'tx_mb_per_player_min': round((t1['tx'] - t0['tx']) / 2**20 / bots / 1.5, 2),
                               'window': s.window('explore-together')}
    out['end'] = s.snapshot('explore-together', live=False)
    proc.kill()
    out['bots_log'] = open(os.path.join(mcb.OUT, f'net-{tag}.bots.log')).read()[-600:]
    mcb.record(f'net-{tag}', out)
    s.stop()


which = sys.argv[1]
if which == 'net':
    net_run('1-vd10', 1, k=40)
    net_run('5-vd10', 5, k=41)
    net_run('10-vd10', 10, k=42)
    net_run('5-vd6', 5, vd=6, k=43)
    net_run('5-vd16', 5, vd=16, k=44)
    net_run('5-vd10-nocompress', 5, threshold=-1, k=45)
    net_run('5-vd10-thresh64', 5, threshold=64, k=46)
    net_run('paper-5-vd10', 5, k=47, type_='PAPER')
    net_run('paper-10-vd10', 10, k=48, type_='PAPER')
