// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The backups stratum: a world as something that can go back. When a backup is taken, which ones a
 * plan keeps, what a change that doesn't start comes back from, and where a deleted server waits.
 * The demonstration is BackupsDemo; the numbers under it are the control plane's own, each cited
 * beside its constant.
 *
 * The heading says "almost". A restore loses what was played after the backup it goes back to, a
 * backup deleted by hand can't be brought back, and past its days in the trash a server is gone for
 * good.
 */
import type { PublicPlan } from '@blockly/contracts'
import type { ReactNode } from 'react'
import { Demo, Facts, Section } from '../kit'
import { BackupsDemo, type Shelf } from './BackupsDemo'
import styles from './backups.module.css'

/**
 * What each plan keeps that the public plans don't carry: daily backups and the owner's own, and
 * the days a deleted server waits in the trash. The names are the plans' own; the words beside each
 * stand in only when the plans can't be read.
 * apps/control/src/domain/account/entitlements.ts
 */
const KEEPS = [
  { key: 'free', kept: 3, trashDays: 7, label: 'Free plan', said: 'the free plan' },
  { key: 'plus', kept: 14, trashDays: 30, label: 'Paid plan', said: 'the paid plan' },
] as const

/** Backups from before a change, a restore or a move, kept apart on every plan. apps/control/src/app/backups/service.ts */
const SAFETY_KEPT = 3

/** What a running server is told around a backup. apps/control/src/minecraft/console.ts */
const SAVE_OFF = 'save-off'
const SAVE_ALL_FLUSH = 'save-all flush'
const SAVE_ON = 'save-on'

/** The largest world download that can be uploaded back, in GB. service.ts */
const UPLOAD_MOST_GB = 4
/** How much of a disk a world brought back may take, and Free's disk in GB. entitlements.ts */
const WORLD_SHARE_OF_DISK = 0.6
const FREE_DISK_GB = 3

/** A fact's second line: what it means, in plain words. */
function Aside({ children }: { children: ReactNode }) {
  return <span className={styles.aside}>{children}</span>
}

export function Backups({ plans, bare }: { plans: PublicPlan[]; bare?: boolean }) {
  const shelves: Shelf[] = KEEPS.map((keep) => {
    const name = plans.find((plan) => plan.key === keep.key)?.name
    return {
      key: keep.key,
      label: name ?? keep.label,
      said: name ?? keep.said,
      kept: keep.kept,
      trashDays: keep.trashDays,
    }
  })
  const [free, paid] = shelves
  const trash =
    free && paid ? `, ${free.trashDays} days on ${free.said} and ${paid.trashDays} on ${paid.said}` : ''
  // The limit a server's disk has room for, as the product words it. service.ts
  const freeUploadGb = Number(Math.min(UPLOAD_MOST_GB, FREE_DISK_GB * WORLD_SHARE_OF_DISK).toFixed(1))

  return (
    <Section bare={bare} tone="stone" room="backups" className={styles.backups}>
      <h2 className="bl-h2">Almost nothing here is one-way</h2>
      <p className="bl-lede">
        Cubepals takes a backup a day while people play, and one before each change to what the server runs,
        each restore and each move. A change that doesn’t start goes back by itself, and a server you delete
        waits in the trash first{trash}.
      </p>

      <Demo
        label="One example server’s shelf of backups, and buttons for what can happen to it: a day with or without play, a backup, a change, a restore, a delete"
        note="Sped up, on an example server; nothing is really backed up. A backup is a copy of the server’s disk at one moment, so going back to one loses what was played after it. Here each day’s backup falls after everyone has left; when one falls while friends are on, the server is told the same three things around the copy. A world nobody plays for weeks rests in storage, and the backups on this shelf are no longer offered then; the example doesn’t follow it there."
      >
        <BackupsDemo
          shelves={shelves}
          safetyKept={SAFETY_KEPT}
          commands={[SAVE_OFF, SAVE_ALL_FLUSH, SAVE_ON]}
        />
      </Demo>

      <Facts
        items={[
          {
            name: 'Sent to a running server around each backup',
            value: (
              <>
                {SAVE_OFF}, {SAVE_ALL_FLUSH}, {SAVE_ON}
                {/* apps/control/src/app/operations/handlers.ts */}
                <Aside>
                  Stop writing and flush, the disk is copied, write again. A sleeping server saved its world
                  as it stopped.
                </Aside>
              </>
            ),
          },
          {
            name: 'Backups kept',
            value: (
              <>
                {shelves.map((shelf) => `${shelf.kept} on ${shelf.said}`).join(', ')}
                {/* service.ts */}
                <Aside>
                  And on every plan the newest {SAFETY_KEPT} from before a change, a restore or a move.
                </Aside>
              </>
            ),
          },
          {
            name: 'Beside every change in History',
            value: (
              <>
                Go back to this
                {/* apps/web/src/app/(app)/servers/[id]/settings/history.tsx; apps/control/src/app/revisions/service.ts */}
                <Aside>
                  Going back writes a new entry, so History only grows. An older Minecraft than the world has
                  run takes a backup instead.
                </Aside>
              </>
            ),
          },
          {
            name: 'A world as a file',
            value: (
              <>
                .tar.gz, up to {UPLOAD_MOST_GB} GB
                {/* service.ts */}
                <Aside>
                  Download it, and upload it back as a backup to restore.
                  {free
                    ? ` On ${free.said} the limit is what its disk has room for, ${freeUploadGb} GB.`
                    : ''}
                </Aside>
              </>
            ),
          },
        ]}
      />
    </Section>
  )
}
