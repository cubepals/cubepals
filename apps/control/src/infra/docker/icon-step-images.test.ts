// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The start's icon step, run inside both images a server runs today (`imageFor`): the Ubuntu
 * build, and the Alpine one whose tools are BusyBox's. The icon it fetched is put in place byte for
 * byte, as the image's own `cp -f` of a 64x64 PNG put it before, owned by the server's user, and
 * the image is handed no icon to do again. Where the fetch fails, an image with ImageMagick is left
 * to fetch it itself, as before.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Docker from 'dockerode'
import { ICON_STEP, imageFor } from '../../minecraft/runtime-spec.ts'

const SOCKET = '/var/run/docker.sock'
const docker = new Docker({ socketPath: SOCKET })

/**
 * Both images, as the product picks them. CI pulls them in the job that runs this file ("Pull the
 * server images"), and that step fails the job if a pull fails; elsewhere one not pulled is skipped.
 */
const IMAGES = {
  ubuntu: imageFor({ gameVersion: '26.3', loader: 'paper', modpack: null }),
  alpine: imageFor({ gameVersion: '26.3', loader: 'vanilla', modpack: null }),
}

/** Cubepals' own icon, as every server's default is: a 64x64 PNG. */
const ICON = readFileSync(new URL('../../../assets/server-icons/blockly.png', import.meta.url))

let root = ''

/** The step as a server's start runs it, as root on the volume, with `/data` moved under the test's folder. */
async function iconStep(image: string, url: string): Promise<string> {
  const script = ICON_STEP.join('\n').replaceAll('/data/', '/t/data/')
  const container = await docker.createContainer({
    Image: image,
    User: '0',
    Entrypoint: ['/bin/sh', '-c'],
    Cmd: [
      `export ICON='${url}' OVERRIDE_ICON=TRUE\n${script}\necho "ICON=\${ICON-none} OVERRIDE_ICON=\${OVERRIDE_ICON-none}"`,
    ],
    HostConfig: { Binds: [`${root}:/t`] },
  })
  try {
    await container.start()
    await container.wait()
    return (await container.logs({ stdout: true, stderr: true })).toString('utf8')
  } finally {
    await container.remove({ force: true })
  }
}

describe.skipIf(!existsSync(SOCKET))('the icon step in the images a server runs', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'blockly-icon-'))
    chmodSync(root, 0o777)
    writeFileSync(join(root, 'icon.png'), ICON)
  })
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  const pulled = (image: string) => Bun.spawnSync(['docker', 'image', 'inspect', image]).exitCode === 0
  for (const [name, image] of Object.entries(IMAGES)) {
    test.skipIf(!pulled(image))(
      `${name}: the icon is put in place byte for byte, the server's own, and the image is given none`,
      async () => {
        rmSync(join(root, 'data'), { recursive: true, force: true })
        mkdirSync(join(root, 'data'))
        const said = await iconStep(image, 'file:///t/icon.png')
        expect(said).toContain('ICON=none OVERRIDE_ICON=none')
        const placed = join(root, 'data', 'server-icon.png')
        expect(readFileSync(placed).equals(ICON)).toBe(true)
        expect(statSync(placed).uid).toBe(1000)
        // The same icon again is left as it is.
        const before = statSync(placed).mtimeMs
        expect(await iconStep(image, 'file:///t/icon.png')).toContain('ICON=none OVERRIDE_ICON=none')
        expect(statSync(placed).mtimeMs).toBe(before)
      },
      120_000,
    )

    test.skipIf(!pulled(image))(
      `${name}: an icon curl can't fetch is left to the image, which has ImageMagick`,
      async () => {
        rmSync(join(root, 'data'), { recursive: true, force: true })
        mkdirSync(join(root, 'data'))
        const said = await iconStep(image, 'file:///t/missing.png')
        expect(said).toContain('ICON=file:///t/missing.png OVERRIDE_ICON=TRUE')
        expect(existsSync(join(root, 'data', 'server-icon.png'))).toBe(false)
      },
      120_000,
    )
  }
})
