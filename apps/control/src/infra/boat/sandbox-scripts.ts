// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto'
import type { RuntimeSpec } from '../../app/ports/runtime.ts'

/**
 * What runs inside a server's sandbox, as shell: one program, told what to do by a verb, run
 * through Boat's command endpoint. Every verb can be asked again after a failure or a lost answer
 * and ends in the same place, since Boat never retries a command and neither does the client.
 *
 * Inside the sandbox: the workload is one Docker container (`blockly-workload`) on a named volume
 * (`blockly-data`), and Blockly's snapshots are archives in another (`blockly-snapshots`). Boat's
 * own snapshots carry named volumes and the containers they had across a stop and a resume; the
 * container's configuration waits in /home/user/.blockly, written through Boat's file endpoint, so
 * no secret ever sits on a command line.
 */

export const WORKLOAD = 'blockly-workload'
const DATA_VOLUME = 'blockly-data'
const SNAPSHOT_VOLUME = 'blockly-snapshots'
/**
 * How long the sandbox waits, after a resume, for Boat to bring back the container before it makes
 * one again: minutes, since Boat took up to 296 s (2026-10-04), so a slow restore makes a slow
 * wake, not a failed one. One command waits at most SETTLE_PART_SECONDS of it, so it stays well
 * inside the time a command is given, then answers "wait" and is asked again (commands.ts).
 */
export const SETTLE_SECONDS = 360
export const SETTLE_PART_SECONDS = 100
/** Where the workload's configuration waits, as Boat's file endpoint names it. */
const CONFIG_DIR = '/home/user/.blockly'
/** Written here, then moved into place by `configure` once nothing still needs the one before. */
export const NEXT_CONFIG = `${CONFIG_DIR}/workload.next.json`

const PROGRAM = String.raw`
set -u
W=${WORKLOAD}
CONF=${CONFIG_DIR}
# Docker's volumes, and the room a snapshot leaves free; tests point them elsewhere.
VOLUMES=$(printenv BLOCKLY_VOLUMES || echo /var/lib/docker/volumes)
ROOM=$(printenv BLOCKLY_ROOM_BYTES || echo 1073741824)
# What settle waits, in all and in one command, and where it notes when it began: in memory, so
# a resume, which comes up on another machine, begins again (tests change all three).
WAIT=$(printenv BLOCKLY_SETTLE_SECONDS || echo ${SETTLE_SECONDS})
PART=$(printenv BLOCKLY_SETTLE_PART_SECONDS || echo ${SETTLE_PART_SECONDS})
SINCE=$(printenv BLOCKLY_SETTLE_SINCE || echo /dev/shm/blockly-settle)
# Set before this line by scriptOnNew: a sandbox Boat never saved, with nothing coming back.
NEW=${'$'}{BLOCKLY_NEW:-}
DATA=$VOLUMES/${DATA_VOLUME}/_data
SNAPS=$VOLUMES/${SNAPSHOT_VOLUME}/_data
fail() { echo "failed $*"; exit 1; }
# Docker prints an empty line for a container it doesn't have, as well as failing: only its
# verdict is read, or the state would be "\nmissing", which isn't "missing" (2026-10-04: a wake
# that waited not at all for a container still being restored).
state() { s=$(docker inspect -f '{{.State.Status}}' "$W" 2>/dev/null) || s=missing; echo "$s"; }
running() { case "$(state)" in running|restarting) return 0;; *) return 1;; esac; }
volumes() {
  docker volume create ${DATA_VOLUME} >/dev/null && docker volume create ${SNAPSHOT_VOLUME} >/dev/null || fail "making the volumes"
}
docker_ready() {
  for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && return 0; sleep 1; done
  fail "Docker did not answer"
}
# Made from the configuration Blockly last gave. False when the name is taken: Boat brought its own
# back meanwhile, which a resume does some seconds in.
create() {
  image=$(cat "$CONF/image")
  docker image inspect "$image" >/dev/null 2>&1 || docker pull -q "$image" >/dev/null || fail "pulling $image"
  out=$(curl -sS --unix-socket /var/run/docker.sock -H 'Content-Type: application/json' \
    -X POST "http://docker/containers/create?name=$W" --data-binary @"$CONF/workload.json") || fail "creating the workload"
  case "$out" in
    *'"Id"'*) return 0;;
    *'is already in use'*) return 1;;
    *) fail "creating the workload: $out";;
  esac
}
# After a resume Boat brings back what the sandbox held lazily: the configuration, the world's
# volume and, last, the container, each seconds to minutes in (2026-10-04: the container 23 to
# 296 s after the resume, and once neither the configuration nor the volume was back 38 s in).
# A file read before it arrives can fail outright (2026-09-28: "Input/output error" on this
# directory 15 s in), so what is or isn't there yet says nothing: every sandbox but a new one
# ($NEW) waits for its container. Nothing touches the workload before it is back, or one made
# meanwhile would stand in its way; one still missing $WAIT seconds after the first look is made
# again from what Blockly last gave it. A command that has waited $PART seconds answers "wait"
# and is asked again, so the wait outlasts the time one command is given.
settle() {
  docker_ready
  [ -n "$NEW" ] && return 0
  [ -s "$SINCE" ] || date +%s > "$SINCE"
  begun=$(cat "$SINCE")
  while [ "$(state)" = missing ] && [ $(($(date +%s) - begun)) -lt "$WAIT" ]; do
    # $SECONDS counts from the program's start, Docker's own wait included.
    [ "$SECONDS" -lt "$PART" ] || { echo "wait the sandbox is still bringing its workload back"; exit 0; }
    sleep 2
  done
  [ "$(state)" != missing ] && return 0
  # Never given a configuration (made, then never configured): nothing to make it from.
  [ -f "$CONF/workload.json" ] || return 0
  volumes
  create || true
}
firewall() {
  sudo -n ufw allow "$1/tcp" >/dev/null || fail "opening port $1"
  sudo -n ufw status | grep -Eq "^$1/tcp +ALLOW" || fail "port $1 is still closed"
}
up() {
  settle
  for port in "$@"; do firewall "$port"; done
  # A start in the first moments after Boat made the container again can leave it created.
  for _ in 1 2 3 4 5; do
    running && { echo "ok running"; return 0; }
    docker start "$W" >/dev/null 2>&1
    sleep 2
  done
  running && { echo "ok running"; return 0; }
  fail "the workload did not start ($(state))"
}
stop() {
  settle
  running || { echo "ok stopped"; return 0; }
  # The container's own stop timeout, set from the spec when it was made.
  docker stop "$W" >/dev/null 2>&1
  running && fail "the workload did not stop"
  echo "ok stopped"
}
kill_() {
  docker kill "$W" >/dev/null 2>&1
  running && fail "the workload could not be killed"
  echo "ok killed"
}
configure() {
  digest=$1 image=$2
  settle
  volumes
  mkdir -p "$CONF" && chmod 700 "$CONF"
  mv -f "$CONF/workload.next.json" "$CONF/workload.json" && chmod 600 "$CONF/workload.json" || fail "keeping the configuration"
  printf %s "$image" > "$CONF/image"
  was=stopped
  running && was=running
  for _ in 1 2 3 4 5; do
    current=$(docker inspect -f '{{index .Config.Labels "blockly.spec-digest"}}' "$W" 2>/dev/null)
    [ "$current" = "$digest" ] && { echo "ok unchanged"; return 0; }
    if [ "$(state)" != missing ]; then
      docker stop "$W" >/dev/null 2>&1
      docker rm -f "$W" >/dev/null || fail "removing the old workload"
    fi
    if create; then
      [ "$was" = running ] && docker start "$W" >/dev/null
      echo "ok created"
      return 0
    fi
    sleep 2
  done
  fail "the workload's name stayed taken"
}
inspect() {
  s=$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}} {{.RestartCount}} {{.State.StartedAt}} {{.State.FinishedAt}}' "$W" 2>/dev/null) || s=missing
  echo "ok $s"
}
# A snapshot is written beside the world, on the same disk, and Boat keeps only so much of a
# sandbox's data (the size of the type, in bytes, is the second argument). One that wouldn't fit
# with a gigabyte to spare, on the disk or in what Boat keeps, is refused before anything is
# written, so a running world never finds its disk full. An archive of the world is never much
# larger than the world. Docker's volumes are root's: everything here reads them as root.
snapshot() {
  file=$1 keeps=$2
  # Woken for this, the sandbox may still be bringing Docker and its files back (2026-10-01: a
  # snapshot of a sleeping server failed making its volumes two seconds into the resume).
  settle
  volumes
  need=$(sudo -n du -sb "$DATA" | cut -f1)
  held=$(sudo -n du -sb "$VOLUMES" | cut -f1)
  free=$(sudo -n df -B1 --output=avail "$VOLUMES" | tail -1 | tr -d ' ')
  case "$need$held$free" in '' | *[!0-9]*) fail "couldn't read how much room there is";; esac
  [ "$free" -ge $((need + ROOM)) ] ||
    fail "there isn't room for a snapshot: the world takes $((need / 1048576)) MB and $((free / 1048576)) MB are free"
  [ "$keeps" -ge $((held + need + ROOM)) ] ||
    fail "a snapshot would take the server past what its sandbox keeps: $((held / 1048576)) MB of $((keeps / 1048576)) MB used"
  # Woken for this, the world's files stream back lazily, and one read before it arrives can fail
  # (2026-10-01: a sleeping server's first backup failed archiving, its retry worked): asked again
  # while they arrive, with what tar said kept for the failure.
  said=$(mktemp)
  for try in 1 2 3 4 5; do
    if sudo -n tar -czf "$SNAPS/.$file" -C "$DATA" . 2>"$said"; then
      rm -f "$said"
      sudo -n mv "$SNAPS/.$file" "$SNAPS/$file" || fail "keeping the snapshot"
      echo "ok $(sudo -n stat -c %s "$SNAPS/$file")"
      return 0
    fi
    sudo -n rm -f "$SNAPS/.$file"
    [ "$try" = 5 ] || sleep 5
  done
  fail "archiving the world: $(tail -c 300 "$said" | tr '\n' ' ')"
}
snapshots() {
  settle
  echo "ok $(sudo -n ls "$SNAPS" 2>/dev/null | grep -E '^[0-9a-z-]+\.tar\.gz$' | tr '\n' ' ')"
}
forget() {
  settle
  sudo -n rm -f "$SNAPS/$1" && echo "ok forgotten"
}
fill() {
  running && fail "the workload is running"
  sudo -n tar -tzf "$1" >/dev/null || fail "the archive is not whole"
  sudo -n find "$DATA" -mindepth 1 -delete && sudo -n tar -xzf "$1" -C "$DATA" || fail "unpacking the world"
}
restore_snapshot() {
  settle
  volumes
  sudo -n test -f "$SNAPS/$1" || fail "the snapshot is gone"
  fill "$SNAPS/$1"
  echo "ok restored"
}
restore_archive() {
  settle
  volumes
  incoming="$SNAPS/.incoming.tar.gz"
  sudo -n curl -sS --fail --connect-timeout 20 --speed-limit 1024 --speed-time 60 --retry 5 --retry-delay 2 \
    -o "$incoming" "$1" || fail "downloading the archive"
  fill "$incoming"
  sudo -n rm -f "$incoming"
  echo "ok restored"
}
# One PUT carries the archive (no larger than $most): uploaded. Larger: left for export_parts.
export_() {
  file=$1 url=$2 most=$3
  shift 3
  settle
  sudo -n test -f "$SNAPS/$file" || fail "the snapshot is gone"
  sha=$(sudo -n sha256sum "$SNAPS/$file" | cut -d' ' -f1)
  size=$(sudo -n stat -c %s "$SNAPS/$file")
  if [ "$size" -gt "$most" ]; then echo "ok parts $sha $size"; return; fi
  sudo -n curl -sS --fail --connect-timeout 20 --speed-limit 1024 --speed-time 60 --retry 5 --retry-delay 2 \
    -X PUT -T "$SNAPS/$file" "$@" "$url" >/dev/null || fail "uploading the archive"
  echo "ok $sha $size"
}
# The archive in parts of $mib MiB, each streamed by dd with its length declared (S3 takes no
# chunked upload, so curl's is switched off) and tried three times: the parts' URLs one to a line,
# then the headers every part is sent with. Prints n=etag for each part.
export_parts() {
  file=$1 mib=$2 size=$3 urls=$4
  shift 4
  sudo -n test -f "$SNAPS/$file" || fail "the snapshot is gone"
  out= i=0
  while IFS= read -r url; do
    len=$(( size - i * mib * 1048576 ))
    [ "$len" -gt 0 ] || break
    [ "$len" -gt $(( mib * 1048576 )) ] && len=$(( mib * 1048576 ))
    tries=0
    while :; do
      tag=$(sudo -n dd if="$SNAPS/$file" bs=1048576 skip=$(( i * mib )) count="$mib" 2>/dev/null |
        curl -sS --fail --connect-timeout 20 --speed-limit 1024 --speed-time 60 -o /dev/null -D - -X PUT -T - \
          -H "Content-Length: $len" -H "Transfer-Encoding:" "$@" "$url" |
        tr -d '\r' | sed -n 's/^[Ee][Tt][Aa][Gg]: *//p')
      [ -n "$tag" ] && break
      tries=$((tries + 1)); [ "$tries" -lt 3 ] || fail "uploading part $((i + 1))"
      sleep 2
    done
    i=$((i + 1))
    out="$out $i=$tag"
  done <<< "$urls"
  echo "ok$out"
}
verb=$1
shift
case "$verb" in
  up) up "$@";;
  stop) stop;;
  kill) kill_;;
  restart) settle; ( stop ) >/dev/null || kill_ >/dev/null; up "$@";;
  configure) configure "$@";;
  inspect) inspect;;
  snapshot) snapshot "$@";;
  snapshots) snapshots;;
  forget) forget "$@";;
  restore-snapshot) restore_snapshot "$@";;
  restore-archive) restore_archive "$@";;
  export) export_ "$@";;
  export-parts) export_parts "$@";;
  *) fail "no verb $verb";;
esac
`

export const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

export type Verb =
  | 'up'
  | 'stop'
  | 'kill'
  | 'restart'
  | 'configure'
  | 'inspect'
  | 'snapshot'
  | 'snapshots'
  | 'forget'
  | 'restore-snapshot'
  | 'restore-archive'
  | 'export'
  | 'export-parts'

/** The command Boat runs for one verb. */
export function script(verb: Verb, ...args: readonly string[]): string {
  return ['bash', '-c', quote(PROGRAM), 'blockly', verb, ...args.map(quote)].join(' ')
}

/**
 * The command for one verb on a sandbox Boat never saved: it was never stopped, so nothing is
 * coming back, and the verb doesn't wait for it.
 */
export function scriptOnNew(verb: Verb, ...args: readonly string[]): string {
  return ['bash', '-c', quote(`BLOCKLY_NEW=1${PROGRAM}`), 'blockly', verb, ...args.map(quote)].join(' ')
}

/** A command run inside the workload, as Docker's exec takes one. */
export const inWorkload = (command: readonly string[]) =>
  ['docker', 'exec', WORKLOAD, ...command.map(quote)].join(' ')

export const specDigest = (spec: RuntimeSpec) =>
  createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 32)

/**
 * A RuntimeSpec as the Docker Engine API's create body, as DockerRuntime makes its containers:
 * only ports the edge reaches are published, so a console port never leaves the container. It
 * restarts unless Blockly stopped it, so a sandbox that went down and came back runs its server
 * again by itself.
 */
export function workloadConfig(spec: RuntimeSpec, serverId: string): Record<string, unknown> {
  const exposed: Record<string, object> = {}
  const bindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {}
  for (const port of spec.ports) {
    const key = `${port.port}/${port.protocol}`
    exposed[key] = {}
    if (port.audience.includes('edge')) bindings[key] = [{ HostIp: '', HostPort: String(port.port) }]
  }
  return {
    Image: spec.image,
    ...(spec.entrypoint === undefined ? {} : { Entrypoint: [...spec.entrypoint] }),
    Env: Object.entries({ ...spec.env, ...spec.secrets }).map(([k, v]) => `${k}=${v}`),
    Labels: { ...spec.labels, 'blockly.server': serverId, 'blockly.spec-digest': specDigest(spec) },
    ExposedPorts: exposed,
    StopSignal: spec.stop.signal,
    StopTimeout: spec.stop.timeoutSeconds,
    HostConfig: {
      Mounts: [{ Type: 'volume', Source: DATA_VOLUME, Target: spec.storage.mountPath }],
      Memory: spec.resources.memoryMb * 1024 * 1024,
      // Mods are code the owner chose to run (docs/modpack-system.md § Security).
      SecurityOpt: ['no-new-privileges:true'],
      PidsLimit: 4096,
      PortBindings: bindings,
      RestartPolicy: { Name: 'unless-stopped' },
    },
  }
}
