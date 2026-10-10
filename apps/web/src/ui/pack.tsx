// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import type { PackView } from '@blockly/contracts'
import { Download } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from './Button'
import { ICON } from './index'
import { CopyField } from './interactive'

/** How long a launcher is given to open before the page says what to do if it didn't. */
const OPENS_WITHIN_MS = 1_500

/**
 * Prism Launcher 11 and newer imports a pack from a link of its own, asking the player first
 * (PrismLauncher MainWindow.cpp, 11.1.0); older ones treat the link as a sign-in and do nothing.
 */
const prismImport = (file: string) => `prismlauncher://import?url=${encodeURIComponent(file)}`

const siteOf = (page: string) => new URL(page).hostname

/**
 * The exact version of a pack a server plays, and the quickest way into a player's own launcher:
 * one press for the Modrinth App or Prism, the file itself for any other, all straight from the
 * pack's catalog. A page can't see which launchers a computer has, so a press that opened nothing
 * is followed by what to do instead, the way modrinth.com does it. A phone plays no Java Edition,
 * so it is told where to open the page instead. A pack that runs on the server alone is only
 * named: nobody installs it. `quiet` where the page's own actions sit nearby.
 */
export function GetPack({
  pack,
  gameVersion,
  quiet,
}: {
  pack: PackView
  gameVersion: string
  quiet?: boolean
}) {
  const [pressed, setPressed] = useState<'app' | 'prism' | null>(null)
  const [late, setLate] = useState(false)
  useEffect(() => {
    if (pressed === null) return
    setLate(false)
    const timer = setTimeout(() => setLate(true), OPENS_WITHIN_MS)
    return () => clearTimeout(timer)
  }, [pressed])
  const size = quiet ? 'sm' : 'md'
  const icon = <Download {...ICON} size={quiet ? 16 : 18} aria-hidden />

  return (
    <div className="bk-getpack">
      <div className="bk-getpack__pack">
        {/* biome-ignore lint/performance/noImgElement: a pre-sized third-party thumbnail, as in the pack picker */}
        <img
          className="bk-getpack__icon"
          src={pack.icon ?? '/server-icons/chest.svg'}
          alt=""
          width={44}
          height={44}
        />
        <span className="bk-stack" style={{ minInlineSize: 0 }}>
          <span className="bk-getpack__name">{pack.name}</span>
          <span className="bk-getpack__meta bk-num">
            {pack.version} · Minecraft {gameVersion}
          </span>
        </span>
      </div>

      {pack.page === null ? (
        // A pack its owner uploaded has no public page, and Blockly never hands out their files.
        pack.environment === 'both' && (
          <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
            It isn’t published anywhere Cubepals can link to: ask whoever runs the server for this exact
            version.
          </p>
        )
      ) : pack.file === null || pack.environment === 'server' ? (
        <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
          <a href={pack.page} target="_blank" rel="noreferrer">
            See this version on {siteOf(pack.page)}
          </a>
          .
        </p>
      ) : (
        <div className="bk-getpack__launch">
          <div className="bk-row bk-wrap" style={{ gap: 'var(--space-8)' }}>
            {pack.app !== null && (
              <Button
                variant={quiet ? 'outline' : 'secondary'}
                size={size}
                icon={icon}
                href={pack.app}
                onClick={() => setPressed('app')}
              >
                Install with Modrinth App
              </Button>
            )}
            <Button
              variant="outline"
              size={size}
              icon={quiet || pack.app === null ? icon : undefined}
              href={prismImport(pack.file)}
              onClick={() => setPressed('prism')}
            >
              Install with Prism
            </Button>
          </div>
          {late && pressed === 'app' && (
            <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
              Nothing opened?{' '}
              <a href="https://modrinth.com/app" target="_blank" rel="noreferrer">
                Get the Modrinth App
              </a>
              , it’s free, then press again.
            </p>
          )}
          {late && pressed === 'prism' && (
            <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
              <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
                Nothing opened? Prism opens these from version 11. In an older one, copy the pack’s link, then
                choose Add Instance → Import and paste it.
              </p>
              <CopyField value={pack.file} label="Copy the pack’s link" concealed />
            </div>
          )}
          {late && pressed === 'app' && (
            <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
              Opened GDLauncher instead? It takes Modrinth’s links: download the pack below and import it
              there.
            </p>
          )}
          {/* Only Prism and the Modrinth App take a pack from a page (each launcher's own source);
              the rest are told their one step. */}
          <details className="bk-getpack__others">
            <summary className="type-body-sm bk-disclosure">Another launcher?</summary>
            <ul className="bk-getpack__steps type-body-sm">
              <li>
                <strong>CurseForge</strong> can’t open Modrinth packs. The Modrinth App or Prism can, and both
                are free.
              </li>
              <li>
                <strong>ATLauncher, MultiMC or HMCL:</strong> choose Import, then paste the pack’s link.
                <div className="bk-getpack__copy">
                  <CopyField value={pack.file} label="Copy the pack’s link" concealed />
                </div>
              </li>
              <li>
                <strong>Any other:</strong> <a href={pack.file}>download the pack</a> and import it, or{' '}
                <a href={pack.page} target="_blank" rel="noreferrer">
                  see this version on {siteOf(pack.page)}
                </a>
                .
              </li>
            </ul>
          </details>
        </div>
      )}
      {pack.file !== null && pack.page !== null && pack.environment === 'both' && (
        <p className="bk-getpack__elsewhere type-body-sm" style={{ color: 'var(--ink-muted)' }}>
          Java Edition runs on a computer: open this page there to install it in one press, or{' '}
          <a href={pack.page} target="_blank" rel="noreferrer">
            see this version on {siteOf(pack.page)}
          </a>
          .
        </p>
      )}
    </div>
  )
}
