# /// script
# requires-python = ">=3.12"
# ///
"""Disposable Minecraft server benchmark harness against itzg/minecraft-server.

Every container and volume is prefixed mcb- and removed after each run. Metrics come from
cgroup v2 files, /proc, JDK jcmd (from a mounted Temurin JDK), the game's own `/tick query`
over rcon-cli, and the G1 GC log.
"""
import json, re, subprocess, threading, time, os, sys
from collections import defaultdict

IMAGE = 'itzg/minecraft-server:2026.9.1'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'results')
os.makedirs(OUT, exist_ok=True)


def java_for(v):
    if v.startswith('26.'):
        return 25
    minor = int(v.split('.')[1])
    patch = int(v.split('.')[2]) if v.count('.') == 2 else 0
    if minor > 20 or (minor == 20 and patch >= 5):
        return 21
    return 17


def sh(cmd, check=False, timeout=600):
    r = subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True, timeout=timeout)
    if check and r.returncode:
        raise RuntimeError(f'{cmd}: {r.stderr}')
    return r.stdout


class Server:
    def __init__(self, run, version='26.3', type_='VANILLA', heap_mb=3072, mem_mb=4096, cpus=2,
                 vd=10, sd=10, env=None, volume=None, aikar=True, pretouch=True):
        self.run, self.name = run, f'mcb-{run}'
        self.version, self.type = version, type_
        self.heap_mb, self.mem_mb, self.cpus, self.vd, self.sd = heap_mb, mem_mb, cpus, vd, sd
        self.env = env or {}
        self.volume = volume or f'mcb-vol-{run}'
        self.aikar, self.pretouch = aikar, pretouch
        self.rows, self.events = [], []
        self.phase = 'boot'
        self._stop = threading.Event()
        self.pid = None
        self.gc_lines_at = {}
        self.threads_at = {}
        self.t0 = None

    # ── lifecycle ────────────────────────────────────────────────────────────
    def start(self, wait=True, timeout=900):
        sh(f'docker rm -f {self.name}')
        xx = '-XX:NativeMemoryTracking=summary -Xlog:gc:file=/data/gc.log:uptime,level'
        if not self.pretouch:
            # Aikar's flags minus AlwaysPreTouch; the image appends its own list after ours, so we can't just negate it.
            self.aikar = False
            xx += (' -XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions'
                   ' -XX:+DisableExplicitGC -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M'
                   ' -XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4'
                   ' -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90'
                   ' -XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1')
        env = {
            'EULA': 'TRUE', 'TYPE': self.type, 'VERSION': self.version, 'ENABLE_RCON': 'TRUE',
            'RCON_PASSWORD': 'bench', 'ONLINE_MODE': 'FALSE', 'SEED': 'blockly-bench',
            'ENABLE_AUTOPAUSE': 'FALSE', 'VIEW_DISTANCE': str(self.vd), 'SIMULATION_DISTANCE': str(self.sd),
            'MEMORY': f'{self.heap_mb}M', 'USE_AIKAR_FLAGS': 'TRUE' if self.aikar else 'FALSE',
            'JVM_XX_OPTS': xx, 'STOP_DURATION': '60', 'MAX_PLAYERS': '100',
        }
        env.update(self.env)
        args = ['docker', 'run', '-d', '--name', self.name, '-m', f'{self.mem_mb}m', '--memory-swap', f'{self.mem_mb}m',
                '--cpus', str(self.cpus), '-v', 'mcb-jdk:/jdk:ro', '-v', f'{self.volume}:/data', '-p', '0:25565']
        for k, v in env.items():
            args += ['-e', f'{k}={v}']
        args.append(f'{IMAGE}-java{java_for(self.version)}')
        subprocess.run(args, check=True, capture_output=True)
        self.t0 = time.time()
        self.event('container_started')
        threading.Thread(target=self._sampler, daemon=True).start()
        if wait:
            return self.wait_ready(timeout)

    def wait_ready(self, timeout=900):
        t = time.time()
        while time.time() - t < timeout:
            if not self.alive():
                self.event('died_during_boot', oom=self.oom_killed())
                return False
            if 'Done (' in sh(f'docker logs {self.name} 2>&1 | grep -m1 "Done ("'):
                # rcon listens after Done
                for _ in range(30):
                    if 'Target tick rate' in self.rcon('tick query') or 'Average' in self.rcon('tick query'):
                        break
                    time.sleep(1)
                self.pid = sh(f'docker exec {self.name} pgrep -x java').strip()
                done = sh(f'docker logs {self.name} 2>&1 | grep -m1 "Done ("').strip()
                self.event('ready', wall_s=round(time.time() - self.t0, 1), done_line=done[-60:])
                return True
            time.sleep(1)
        self.event('boot_timeout')
        return False

    def alive(self):
        return sh(f"docker inspect -f '{{{{.State.Running}}}}' {self.name}").strip() == 'true'

    def oom_killed(self):
        return sh(f"docker inspect -f '{{{{.State.OOMKilled}}}} {{{{.State.ExitCode}}}}' {self.name}").strip()

    def stop(self, remove_volume=True):
        t = time.time()
        sh(f'docker stop -t 90 {self.name}', timeout=120)
        self.event('stopped', stop_s=round(time.time() - t, 1))
        self._stop.set()
        time.sleep(1)
        self.save()
        sh(f'docker rm -f {self.name}')
        if remove_volume:
            sh(f'docker volume rm -f {self.volume}')

    # ── game interaction ─────────────────────────────────────────────────────
    def rcon(self, cmd):
        return sh(['docker', 'exec', self.name, 'rcon-cli', cmd], timeout=60)

    def jcmd(self, cmd, timeout=300):
        if not self.pid:
            return ''
        return sh(['docker', 'exec', '-u', '1000', self.name, '/jdk/bin/jcmd', self.pid] + cmd.split(), timeout=timeout)

    def execsh(self, script, timeout=300):
        return sh(['docker', 'exec', self.name, 'sh', '-c', script], timeout=timeout)

    # ── metrics ──────────────────────────────────────────────────────────────
    def event(self, kind, **kw):
        e = {'t': round(time.time() - (self.t0 or time.time()), 1), 'phase': self.phase, 'event': kind, **kw}
        self.events.append(e)
        print(f'[{self.run}] {e}', flush=True)

    def _probe(self):
        pid = self.pid or '$(pgrep -x java)'
        out = self.execsh(
            'cd /sys/fs/cgroup; echo MEM $(cat memory.current); grep -E "^(anon|file) " memory.stat | tr "\\n" " "; echo;'
            'echo CPU $(grep usage_usec cpu.stat | cut -d" " -f2); echo THR $(grep nr_throttled cpu.stat | cut -d" " -f2);'
            'echo NET $(grep eth0 /proc/net/dev); echo IO $(cat io.stat | head -1);'
            f'P={pid}; echo RSS $(grep VmRSS /proc/$P/status 2>/dev/null); echo NTH $(ls /proc/$P/task 2>/dev/null | wc -l)', timeout=30)
        row = {}
        for line in out.splitlines():
            parts = line.split()
            if not parts:
                continue
            k = parts[0]
            try:
                if k == 'MEM':
                    row['cg_mem'] = int(parts[1])
                elif k == 'anon':
                    row['anon'] = int(parts[1]); row['file'] = int(parts[3])
                elif k == 'CPU':
                    row['cpu_usec'] = int(parts[1])
                elif k == 'THR':
                    row['throttled'] = int(parts[1])
                elif k == 'NET':
                    f = parts[1:] if parts[1] != 'eth0:' else parts[2:]
                    f = line.split(':', 1)[1].split()
                    row['rx'] = int(f[0]); row['tx'] = int(f[8])
                elif k == 'IO':
                    m = dict(x.split('=') for x in parts[2:] if '=' in x)
                    row['io_r'] = int(m.get('rbytes', 0)); row['io_w'] = int(m.get('wbytes', 0))
                elif k == 'RSS' and len(parts) >= 3:
                    row['rss'] = int(parts[2]) * 1024
                elif k == 'NTH':
                    row['threads'] = int(parts[1])
            except (ValueError, IndexError):
                pass
        return row

    def heap(self):
        out = self.jcmd('GC.heap_info', timeout=30)
        # JDK 25: "total reserved R, committed C, used U"; JDK 17/21: "total C, used U"
        m = re.search(r'(?:committed|total) (\d+)K, used (\d+)K', out)
        return (int(m.group(2)) * 1024, int(m.group(1)) * 1024) if m else (None, None)

    def tick(self):
        out = self.rcon('tick query')
        m = re.search(r'Average time per tick: ([\d.]+)ms', out)
        p = re.search(r'P50: ([\d.]+)ms P95: ([\d.]+)ms P99: ([\d.]+)ms', out)
        r = {}
        if m:
            r['mspt'] = float(m.group(1))
        if p:
            r['p50'], r['p95'], r['p99'] = map(float, p.groups())
        return r

    def _sampler(self):
        i = 0
        while not self._stop.is_set():
            try:
                if not self.alive():
                    time.sleep(2); continue
                row = {'t': round(time.time() - self.t0, 1), 'phase': self.phase, **self._probe()}
                if self.pid:
                    row['heap_used'], row['heap_committed'] = self.heap()
                    row.update(self.tick())
                self.rows.append(row)
            except Exception as ex:  # a sample is best effort
                pass
            i += 1
            self._stop.wait(5)

    def set_phase(self, name):
        self.phase = name
        self.gc_lines_at[name] = self.gc_line_count()
        self.threads_at[name] = self.thread_cpu()
        self.event('phase')

    def gc_line_count(self):
        try:
            return int(self.execsh('wc -l < /data/gc.log').strip() or 0)
        except ValueError:
            return 0

    def gc_stats(self, since_phase):
        start = self.gc_lines_at.get(since_phase, 0)
        lines = self.execsh(f'tail -n +{start + 1} /data/gc.log').splitlines()
        pauses = [float(m.group(1)) for l in lines if 'Pause' in l and (m := re.search(r'([\d.]+)ms$', l))]
        full = sum(1 for l in lines if 'Pause Full' in l)
        return {'gc_pauses': len(pauses), 'gc_pause_total_ms': round(sum(pauses), 1),
                'gc_pause_max_ms': round(max(pauses), 1) if pauses else 0, 'gc_full': full}

    def thread_cpu(self):
        """CPU ticks by thread-name family, from /proc/<pid>/task/*/stat."""
        if not self.pid:
            return {}
        out = self.execsh(f'for t in /proc/{self.pid}/task/*; do echo "$(cat $t/comm)|$(cut -d")" -f2 $t/stat)"; done 2>/dev/null')
        agg = defaultdict(int)
        for line in out.splitlines():
            if '|' not in line:
                continue
            name, rest = line.split('|', 1)
            f = rest.split()
            try:
                ticks = int(f[11]) + int(f[12])  # utime, stime (fields 14, 15 overall)
            except (IndexError, ValueError):
                continue
            fam = re.sub(r'[#\-\s]*\d+$', '', name.strip())
            agg[fam] += ticks
        return dict(agg)

    def thread_delta(self, since_phase):
        a, b = self.threads_at.get(since_phase, {}), self.thread_cpu()
        d = {k: (b.get(k, 0) - a.get(k, 0)) / 100 for k in b}  # USER_HZ=100 → seconds
        return {k: round(v, 1) for k, v in sorted(d.items(), key=lambda x: -x[1]) if v >= 0.1}

    def live_set(self):
        """Forces a full GC via a class histogram, then reads heap used = live set."""
        hist = self.jcmd('GC.class_histogram', timeout=300)
        used, _ = self.heap()
        counts = {}
        for cls in ['net.minecraft.world.level.chunk.LevelChunk', 'net.minecraft.world.level.chunk.ProtoChunk',
                    'net.minecraft.server.level.ServerPlayer', 'net.minecraft.world.level.chunk.LevelChunkSection']:
            m = re.search(r'\s(\d+)\s+(\d+)\s+' + re.escape(cls) + r'\s', hist)
            counts[cls.rsplit('.', 1)[1]] = int(m.group(1)) if m else None
        return {'live_heap': used, **counts}

    def nmt(self):
        out = self.jcmd('VM.native_memory summary scale=MB', timeout=60)
        r = {}
        m = re.search(r'Total: reserved=(\d+)MB, committed=(\d+)MB', out)
        if m:
            r['nmt_committed_mb'] = int(m.group(2))
        for cat in ['Java Heap', 'Class', 'Thread', 'Code', 'GC', 'Metaspace', 'Other', 'Symbol', 'Internal']:
            m = re.search(r'-\s+' + re.escape(cat) + r' \(reserved=\d+MB, committed=(\d+)MB', out)
            if m:
                r[f'nmt_{cat.lower().replace(" ", "_")}'] = int(m.group(1))
        return r

    def classes(self):
        m = re.search(r'Total Usage - (\d+) loaders, (\d+) classes', self.jcmd('VM.metaspace', timeout=60))
        return {'class_loaders': int(m.group(1)), 'loaded_classes': int(m.group(2))} if m else {}

    def entities(self):
        m = re.search(r'[Cc]ount: (\d+)', self.rcon('execute if entity @e'))
        return int(m.group(1)) if m else None

    def world_bytes(self, level='world'):
        out = self.execsh(f'cd /data/{level} 2>/dev/null && du -sb . && find . -maxdepth 4 -type d \\( -name region -o -name entities -o -name poi -o -name playerdata -o -name data \\) -exec du -sb {{}} \\;')
        r = {}
        for line in out.splitlines():
            size, path = line.split('\t')
            r['total' if path == '.' else path.lstrip('./')] = int(size)
        return r

    def snapshot(self, since_phase=None, live=True):
        """Everything worth recording at the end of a phase."""
        s = {'phase': self.phase, 't': round(time.time() - self.t0, 1), **self._probe()}
        s['heap_used'], s['heap_committed'] = self.heap()
        s.update(self.tick())
        s['entities'] = self.entities()
        s.update(self.nmt())
        s.update(self.classes())
        if since_phase:
            s.update(self.gc_stats(since_phase))
            s['thread_cpu_s'] = self.thread_delta(since_phase)
        if live:
            s.update(self.live_set())
        s['world'] = self.world_bytes()
        self.event('snapshot', **{k: v for k, v in s.items() if k not in ('phase', 't')})
        return s

    def save(self):
        with open(os.path.join(OUT, f'{self.run}.json'), 'w') as f:
            json.dump({'run': self.run, 'version': self.version, 'type': self.type, 'heap_mb': self.heap_mb,
                       'mem_mb': self.mem_mb, 'cpus': self.cpus, 'vd': self.vd, 'sd': self.sd, 'env': self.env,
                       'events': self.events, 'rows': self.rows}, f)

    # ── windowed summary of sampled rows ─────────────────────────────────────
    def window(self, phase):
        rows = [r for r in self.rows if r.get('phase') == phase]
        if len(rows) < 2:
            return {}
        a, b = rows[0], rows[-1]
        dt = b['t'] - a['t']
        ms = sorted(r['mspt'] for r in rows if 'mspt' in r)
        p99 = [r['p99'] for r in rows if 'p99' in r]
        return {
            'secs': round(dt), 'cpu_cores_avg': round((b.get('cpu_usec', 0) - a.get('cpu_usec', 0)) / 1e6 / dt, 2),
            'mspt_median': ms[len(ms) // 2] if ms else None, 'mspt_max': max(ms) if ms else None,
            'p99_max': max(p99) if p99 else None,
            'rss_max_mb': max(r.get('rss', 0) for r in rows) // 2**20,
            'cg_mem_max_mb': max(r.get('cg_mem', 0) for r in rows) // 2**20,
            'heap_used_max_mb': max((r.get('heap_used') or 0) for r in rows) // 2**20,
            'disk_w_mb_s': round((b.get('io_w', 0) - a.get('io_w', 0)) / 2**20 / dt, 2),
            'tx_kb_s': round((b.get('tx', 0) - a.get('tx', 0)) / 1024 / dt, 1),
            'rx_kb_s': round((b.get('rx', 0) - a.get('rx', 0)) / 1024 / dt, 1),
            'throttled_periods': b.get('throttled', 0) - a.get('throttled', 0),
        }


# ── carpet fake players ───────────────────────────────────────────────────────
def spawn_bot(s, name, x, z, dim='minecraft:overworld', y=150):
    return s.rcon(f'player {name} spawn at {x} {y} {z} facing 0 0 in {dim} in creative')


def kill_bot(s, name):
    s.rcon(f'player {name} kill')


def record(result_name, data):
    path = os.path.join(OUT, 'summary.jsonl')
    with open(path, 'a') as f:
        f.write(json.dumps({'name': result_name, **data}) + '\n')
