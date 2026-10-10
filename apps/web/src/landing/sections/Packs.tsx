// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The packs stratum: a modpack is one choice, and everything a host usually asks about it (the
 * loader, the Minecraft, the Java, which mods a server can run, how much memory) Blockly works out
 * from the pack itself. The demonstration is PacksDemo; the facts under it are the control plane's
 * own constants, each cited beside its number.
 *
 * What is left unsaid on purpose: that
 * any pack works, that files are checked before they run (the hashes are checked after the
 * install), and any pack's name.
 */
import type { PublicPlan } from '@blockly/contracts'
import type { ReactNode } from 'react'
import { Demo, Facts, Section } from '../kit'
import { PacksDemo } from './PacksDemo'
import styles from './packs.module.css'

/** The kinds of file a dropped pack can be. apps/control/src/minecraft/pack-layout.ts */
const FILE_KINDS = 6
/** How many times one start may learn about its pack's mods. apps/control/src/app/operations/boot.ts */
const LEARNED_PER_START = 3

/** A fact's second line: why it is so, in plain words. */
function Why({ children }: { children: ReactNode }) {
  return <span className={styles.why}>{children}</span>
}

export function Packs({ plans, bare }: { plans: PublicPlan[]; bare?: boolean }) {
  // The plan that runs mods, plugins and modpacks, by its own name.
  const paid = plans.find((plan) => plan.mods)

  return (
    <Section bare={bare} tone="stone" room="packs" className={styles.packs}>
      <h2 className="bl-h2">A modpack is one choice</h2>
      <p className="bl-lede">
        Pick a pack or drop in a file, and Cubepals works out the Minecraft, the loader and the Java it needs,
        and leaves out the mods that only run in a player’s game.{' '}
        {/* apps/control/src/domain/account/entitlements.ts */}
        {paid ? `Modpacks come with ${paid.name}.` : 'Modpacks come with the paid plan.'}
      </p>

      <Demo
        label="An example pack file, told apart by what it holds, read for what it needs, sorted jar by jar, and started"
        note="An example pack, sped up; nothing is installed or started. Nine of its ten mods are real, and are sorted the way each is published. Example Mod is made up: it stands for a mod that says it runs on a server and stops one."
      >
        <PacksDemo />
      </Demo>

      <Facts
        items={[
          {
            name: 'Kinds of pack file it reads',
            value: (
              <>
                {FILE_KINDS}, as one .zip or .mrpack
                {/* apps/control/src/app/packs/service.ts */}
                <Why>Nobody is asked which.</Why>
              </>
            ),
          },
          {
            name: 'Every jar it installed',
            value: (
              <>
                sha512, against the pack
                {/* apps/control/src/minecraft/install-check.ts, apps/control/src/app/operations/boot.ts */}
                <Why>
                  Hashed on the server once the install is done. A wrong one is removed and fetched once more.
                </Why>
              </>
            ),
          },
          {
            name: 'A start can learn',
            value: (
              <>
                {LEARNED_PER_START} times
                {/* docs/modpack-system.md */}
                <Why>What it learns holds for every server of that pack file.</Why>
              </>
            ),
          },
          {
            name: 'What friends get',
            said: true,
            value: (
              <>
                the exact pack version
                {/* apps/web/src/ui/pack.tsx */}
                <Why>
                  A link installs it in their launcher, where the pack has a public page. Where it has none,
                  they ask whoever runs the server.
                </Why>
              </>
            ),
          },
        ]}
      />
    </Section>
  )
}
