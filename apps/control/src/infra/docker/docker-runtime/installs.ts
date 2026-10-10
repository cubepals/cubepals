// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Copies the install made for a server's release into its volume before it first starts, and
 * makes that install, once, when there is none yet. It does not decide whether a server has an
 * install or when it starts: `ensureProvisioned` (`docker-runtime.ts`) does.
 */

import { createHash } from 'node:crypto'
import type Docker from 'dockerode'
import type { InstallSeed, RuntimeSpec } from '../../../app/ports/runtime.ts'
import { HELPER_IMAGE, type RunHelper } from './helper.ts'
import { LABEL_DEPLOYMENT, LABEL_INSTALL } from './labels.ts'

/** Written last into an install's volume: without it, the install is still being made, or failed. */
const INSTALL_DONE = '.blockly-install-done'

/** The installs of one deployment on this daemon, and those being made in this process. */
export class Installs {
  readonly #docker: Docker
  readonly #deployment: string
  readonly #helper: RunHelper
  /** Installs being made, by volume: a server that asks while one is made doesn't start another. */
  readonly #installing = new Map<string, Promise<void>>()

  constructor(docker: Docker, deployment: string, helper: RunHelper) {
    this.#docker = docker
    this.#deployment = deployment
    this.#helper = helper
  }

  /**
   * Copies the install made for this server's release into its storage, beside anything already
   * there, so the image finds it and downloads nothing. With none made yet, one starts being made
   * for the next server, by a run of the image with the install's settings alone: what is copied
   * is only ever Blockly's own run, never another server's files, which its mods could have
   * changed. Nothing here fails a start; without the copy, the image downloads as it always has.
   * Made and copied in this process only, which is where every local server is provisioned.
   */
  async seed(volume: string, spec: RuntimeSpec, install: InstallSeed): Promise<void> {
    const made = `bly-${this.#deployment}-install-${createHash('sha256').update(install.key).digest('hex').slice(0, 16)}`
    try {
      await this.#ensureInstallVolume(made, install)
      const copied = await this.#helper(
        HELPER_IMAGE,
        [
          'sh',
          '-c',
          `[ -f /made/${INSTALL_DONE} ] || { echo missing; exit 0; }; cd /made && cp -an -- "$@" /data/ && echo copied`,
          'seed',
          ...install.paths,
        ],
        {
          mounts: [
            { Type: 'volume', Source: made, Target: '/made', ReadOnly: true },
            { Type: 'volume', Source: volume, Target: '/data' },
          ],
        },
      )
      if (copied.trim() === 'copied' || this.#installing.has(made)) return
    } catch {
      return
    }
    const making = this.#makeInstall(made, spec, install)
      .catch(() => undefined)
      .finally(() => this.#installing.delete(made))
    this.#installing.set(made, making)
  }

  /**
   * Runs the image with the install's settings alone, which installs and stops, then keeps only
   * the install's own files and marks it done. Whatever else the run wrote — the console's
   * password among it — goes before anything can be copied.
   */
  async #makeInstall(made: string, spec: RuntimeSpec, install: InstallSeed): Promise<void> {
    const mount = { Type: 'volume' as const, Source: made, Target: spec.storage.mountPath }
    await this.#helper(HELPER_IMAGE, ['sh', '-c', 'find /made -mindepth 1 -delete'], {
      mounts: [{ Type: 'volume', Source: made, Target: '/made' }],
    })
    await this.#helper(spec.image, [], {
      mounts: [mount],
      env: Object.entries(install.env).map(([k, v]) => `${k}=${v}`),
    })
    await this.#helper(
      HELPER_IMAGE,
      [
        'sh',
        '-c',
        `set -e; mkdir /keep; cd /made; cp -a -- "$@" /keep/; find /made -mindepth 1 -delete; cp -a /keep/. /made/; touch /made/${INSTALL_DONE}`,
        'keep',
        ...install.paths,
      ],
      { mounts: [{ Type: 'volume', Source: made, Target: '/made' }] },
    )
  }

  async #ensureInstallVolume(name: string, install: InstallSeed): Promise<void> {
    const found = await this.#docker
      .getVolume(name)
      .inspect()
      .catch(() => null)
    if (found) return
    await this.#docker.createVolume({
      Name: name,
      Labels: { [LABEL_DEPLOYMENT]: this.#deployment, [LABEL_INSTALL]: install.key },
    })
  }
}
