#!/bin/bash
# Self-contained Fly Machine benchmark: runs the itzg image's /start in the background, drives a fixed
# workload over RCON, samples metrics every 5 s into /data/results.jsonl, then idles until DEADLINE_MIN
# so results can be pulled. The machine exits at the deadline no matter what (run with --rm).
set -u
DEADLINE_MIN=${DEADLINE_MIN:-50}
PROFILE=${PROFILE:-unknown}
BENCH_MODE=${BENCH_MODE:-standard}    # standard | modpack (not MODE: itzg uses MODE for game mode)
SHORT=${SHORT:-0}         # 1 = dry run with short phases
OUT=/data/results.jsonl
mkdir -p /data && chown 1000:1000 /data
( sleep $((DEADLINE_MIN * 60)); echo "deadline reached"; kill -TERM $$ ) &

export EULA=TRUE ENABLE_RCON=TRUE RCON_PASSWORD=bench ONLINE_MODE=FALSE SEED=blockly-bench
export VIEW_DISTANCE=10 SIMULATION_DISTANCE=10 ENABLE_AUTOPAUSE=FALSE USE_AIKAR_FLAGS=TRUE MAX_PLAYERS=100
export JVM_XX_OPTS="-Xlog:gc:file=/data/gc.log:uptime,level"
if [ "$BENCH_MODE" = modpack ]; then
  export TYPE=MODRINTH MODRINTH_MODPACK=${PACK} MODRINTH_PROJECTS=chunky
else
  export TYPE=FABRIC VERSION=26.3 MODRINTH_PROJECTS=fabric-api,carpet,chunky
fi
export MEMORY=${HEAP}
/start > /data/server.log 2>&1 &

T0=$(date +%s)
PHASE=boot
echo boot > /tmp/phase
rcon() { rcon-cli --password bench "$@" 2>/dev/null; }
asmc() { setpriv --reuid=1000 --regid=1000 --clear-groups "$@"; }
event() { echo "{\"t\":$(( $(date +%s) - T0 )),\"event\":\"$1\",\"detail\":\"$2\"}" >> $OUT; }
finish() {
  event gc "$(grep -c Pause /data/gc.log) pauses, max $(grep -oE '[0-9.]+ms$' /data/gc.log | sort -n | tail -1)"
  event done "$1"; touch /data/DONE; wait; }
phase() {
  if ! pgrep -x java >/dev/null; then
    event crashed "$(grep -iE 'watchdog|single server tick|OutOfMemory|Exception' /data/server.log | head -3 | tr '"' "'" | tr -d '\033')"
    finish crashed
  fi
  echo "$1" > /tmp/phase; event phase "$1"; }

sampler() {
  while true; do
    local pid heap tick cpu mem net rss
    pid=$(pgrep -x java | head -1)
    cpu=$(head -1 /proc/stat | awk '{print $2+$3, $4, $5, $6, $9}')   # user+nice sys idle iowait steal (jiffies)
    mem=$(awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END{print t, a}' /proc/meminfo)
    net=$(awk '/eth0/{print $2, $10}' /proc/net/dev)
    rss=0; heap=""; tick=""
    if [ -n "$pid" ]; then
      rss=$(awk '/VmRSS/{print $2}' /proc/$pid/status 2>/dev/null)
      heap=$(asmc /opt/java/openjdk/bin/jcmd $pid GC.heap_info 2>/dev/null | grep -oE '(committed|total) [0-9]+K, used [0-9]+K' | head -1)
      tick=$(rcon "tick query" | tr -d '\033' | grep -oE 'Average time per tick: [0-9.]+ms|P50: [0-9.]+ms P95: [0-9.]+ms P99: [0-9.]+ms' | tr '\n' ' ')
    fi
    echo "{\"t\":$(( $(date +%s) - T0 )),\"phase\":\"$(cat /tmp/phase)\",\"cpu\":\"$cpu\",\"mem_kb\":\"$mem\",\"net\":\"$net\",\"rss_kb\":${rss:-0},\"heap\":\"$heap\",\"tick\":\"$tick\"}" >> $OUT
    sleep 5
  done
}

snapshot() {  # full-GC live set + chunk counts + world size + gc log size
  local pid=$(pgrep -x java | head -1)
  local hist live lc pc ws gcl
  hist=$(asmc /opt/java/openjdk/bin/jcmd $pid GC.class_histogram 2>/dev/null)
  lc=$(echo "$hist" | awk '$4=="net.minecraft.world.level.chunk.LevelChunk"{print $2}')
  pc=$(echo "$hist" | awk '$4=="net.minecraft.world.level.chunk.ProtoChunk"{print $2}')
  live=$(asmc /opt/java/openjdk/bin/jcmd $pid GC.heap_info 2>/dev/null | grep -oE 'used [0-9]+K' | head -1)
  ws=$(du -sb /data/world 2>/dev/null | cut -f1)
  classes=$(asmc /opt/java/openjdk/bin/jcmd $pid VM.metaspace 2>/dev/null | grep -oE 'Total Usage - [0-9]+ loaders, [0-9]+ classes')
  ents=$(rcon "execute if entity @e" | grep -oE '[0-9]+$')
  echo "{\"t\":$(( $(date +%s) - T0 )),\"event\":\"snapshot\",\"phase\":\"$(cat /tmp/phase)\",\"live\":\"$live\",\"LevelChunk\":\"$lc\",\"ProtoChunk\":\"$pc\",\"world_bytes\":\"$ws\",\"classes\":\"$classes\",\"entities\":\"$ents\"}" >> $OUT
}

d() { if [ "$SHORT" = 1 ]; then echo 20; else echo "$1"; fi; }

event start "profile=$PROFILE heap=$HEAP cpus=$(nproc) mem=$(awk '/MemTotal/{print $2}' /proc/meminfo)kB model=$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2)"
sampler &
until grep -q 'Done (' /data/server.log 2>/dev/null || grep -q 'Done (' /data/logs/latest.log 2>/dev/null; do
  sleep 2
  if [ $(( $(date +%s) - T0 )) -gt 1800 ]; then event boot_timeout ""; break; fi
  if ! pgrep -f '/start|java' >/dev/null; then event died_during_boot "$(tail -3 /data/server.log | tr '"' "'")"; break; fi
done
sleep 5
event ready "$(grep -m1 -oE 'Done \([0-9.]+s\)' /data/server.log /data/logs/latest.log 2>/dev/null | head -1)"

phase idle; sleep $(d 120); snapshot

phase pregen
  rcon "chunky radius ${PREGEN_RADIUS:-640}"; rcon "chunky center 0 0"; rcon "chunky shape square"; rcon "chunky start"; rcon "chunky confirm"
  for i in $(seq 1 $(( $(d 480) / 5 ))); do
    sleep 5
    grep -q 'Task finished' /data/server.log /data/logs/latest.log 2>/dev/null && break
  done
  event pregen "$(rcon 'chunky progress' | tr -d '\033' | tr '"' "'")"
  rcon "chunky cancel"; rcon "chunky confirm"; snapshot

if [ "$BENCH_MODE" = standard ]; then

  phase 1-bot
  rcon "player b0 spawn at 0 150 0 facing 0 0 in minecraft:overworld in creative"
  sleep $(d 180); snapshot

  phase 5-together
  for i in 1 2 3 4; do rcon "player b$i spawn at $((i * 6)) 150 0 facing 0 0 in minecraft:overworld in creative"; done
  sleep $(d 180); snapshot

  phase 5-spread
  i=0; for a in 0 72 144 216 288; do
    x=$(awk -v a=$a 'BEGIN{printf "%d", 400*cos(a*3.14159/180)}'); z=$(awk -v a=$a 'BEGIN{printf "%d", 400*sin(a*3.14159/180)}')
    rcon "tp b$i $x 150 $z"; i=$((i+1)); done
  sleep $(d 300); snapshot

  phase 5-explore
  i=0; for a in 0 72 144 216 288; do rcon "tp b$i $((20000 + i * 3000)) 150 20000"; i=$((i+1)); done
  sleep 15
  end=$(( $(date +%s) + $(d 240) ))
  while [ $(date +%s) -lt $end ]; do
    printf 'execute as b0 at @s run tp @s ~10 150 ~\nexecute as b1 at @s run tp @s ~10 150 ~\nexecute as b2 at @s run tp @s ~10 150 ~\nexecute as b3 at @s run tp @s ~10 150 ~\nexecute as b4 at @s run tp @s ~10 150 ~\n' | rcon-cli --password bench >/dev/null 2>&1
    sleep 1
  done
  snapshot
fi
phase end
finish ok
