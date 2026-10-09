/**
 * Says what a server's game container is made with: its image, environment, labels, ports, and the
 * limits it runs under on this machine. It does not make, start or remove one, nor choose its host
 * ports: the verbs (`docker-runtime.ts`) and `host-ports.ts` do.
 */

import { createHash } from 'node:crypto'
import type Docker from 'dockerode'
import type { RuntimeSpec } from '../../../app/ports/runtime.ts'
import type { DockerRef } from '../handle.ts'
import { LABEL_DEPLOYMENT, LABEL_DIGEST, LABEL_PORTS, LABEL_SERVER, LABEL_STOP_TIMEOUT } from './labels.ts'

/** Processes and threads a game container may hold: a big pack's JVM runs a few hundred. */
const GAME_PIDS = 4096

/** The create options of `ref`'s container, running `spec` on `network` for `deployment`. */
export function gameContainer(
  ref: DockerRef,
  spec: RuntimeSpec,
  deployment: string,
  network: string,
): Docker.ContainerCreateOptions {
  const exposed: Record<string, object> = {}
  const bindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {}
  for (const port of spec.ports) {
    const key = `${port.port}/${port.protocol}`
    exposed[key] = {}
    const host = ref.ports[port.name]?.host
    if (host != null) bindings[key] = [{ HostIp: '127.0.0.1', HostPort: String(host) }]
  }
  return {
    name: ref.container,
    Image: spec.image,
    ...(spec.entrypoint === undefined ? {} : { Entrypoint: [...spec.entrypoint] }),
    Env: Object.entries({ ...spec.env, ...spec.secrets }).map(([k, v]) => `${k}=${v}`),
    Labels: {
      ...spec.labels,
      [LABEL_DEPLOYMENT]: deployment,
      [LABEL_SERVER]: ref.serverId,
      [LABEL_DIGEST]: specDigest(spec),
      [LABEL_STOP_TIMEOUT]: String(spec.stop.timeoutSeconds),
      [LABEL_PORTS]: JSON.stringify(ref.ports),
    },
    ExposedPorts: exposed,
    StopSignal: spec.stop.signal,
    StopTimeout: spec.stop.timeoutSeconds,
    HostConfig: {
      Mounts: [{ Type: 'volume', Source: ref.volume, Target: spec.storage.mountPath }],
      Memory: spec.resources.memoryMb * 1024 * 1024,
      // Mods are code the owner chose to run (docs/modpack-system.md § Security): the image drops
      // to its own user with gosu, which needs no setuid, so nothing inside may gain privileges,
      // and a mod that forks without end runs out of processes, not the host.
      SecurityOpt: ['no-new-privileges:true'],
      PidsLimit: GAME_PIDS,
      PortBindings: bindings,
      NetworkMode: network,
      RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 3 },
      ExtraHosts: ['host.docker.internal:host-gateway'],
    },
  }
}

/** What a container records of the spec it was made from, to tell whether it must be made again. */
export function specDigest(spec: RuntimeSpec): string {
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 32)
}
