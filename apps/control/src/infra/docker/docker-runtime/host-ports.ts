/**
 * Hands out host ports for the control plane's side of a server, one claim at a time, so two
 * servers made at once never get the same one. It does not make the container that records them:
 * the verbs (`docker-runtime.ts`) do, inside the claim.
 */

import { createServer } from 'node:net'
import type Docker from 'dockerode'
import type { RuntimeSpec } from '../../../app/ports/runtime.ts'
import type { DockerRef } from '../handle.ts'
import { LABEL_PORTS } from './labels.ts'

const HOST_PORTS = { from: 42000, to: 42999 }

/** The host ports of the containers one runtime lists, chosen in this process. */
export class HostPorts {
  readonly #containers: () => Promise<Docker.ContainerInfo[]>
  /** The last port choice in flight; the next one starts after it. */
  #queue: Promise<unknown> = Promise.resolve()

  constructor(containers: () => Promise<Docker.ContainerInfo[]>) {
    this.#containers = containers
  }

  /**
   * Free host ports for `spec`, handed to `make`. A port is taken once a container records it, so
   * choosing and making happen one at a time: the next claim chooses after `make` has finished.
   */
  claim<T>(spec: RuntimeSpec, make: (ports: DockerRef['ports']) => Promise<T>): Promise<T> {
    return this.#oneAtATime(async () => make(await this.#allocatePorts(spec)))
  }

  /** Runs `work` after every earlier call has finished, in this process. */
  #oneAtATime<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work)
    this.#queue = run.catch(() => undefined)
    return run
  }

  /**
   * Free host ports for the control plane's side of a spec. A stopped server keeps its port for
   * when it starts again, so every container's recorded ports count, running or not, and a port
   * something else on the machine holds is skipped too.
   */
  async #allocatePorts(spec: RuntimeSpec): Promise<DockerRef['ports']> {
    const used = new Set<number>()
    for (const summary of await this.#containers()) {
      for (const p of summary.Ports) if (p.PublicPort) used.add(p.PublicPort)
      const recorded = JSON.parse(summary.Labels[LABEL_PORTS] ?? '{}') as DockerRef['ports']
      for (const mapping of Object.values(recorded)) if (mapping.host !== null) used.add(mapping.host)
    }
    const ports: DockerRef['ports'] = {}
    let next = HOST_PORTS.from
    for (const port of spec.ports) {
      let host: number | null = null
      if (port.audience.includes('control')) {
        while (next <= HOST_PORTS.to && (used.has(next) || !(await portFree(next)))) next++
        if (next > HOST_PORTS.to) throw new Error('No free host ports left for local servers')
        host = next
        used.add(next)
      }
      ports[port.name] = { container: port.port, host }
    }
    return ports
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}
