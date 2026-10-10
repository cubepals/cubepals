'use client'

import { type DehydratedState, useMutation, useQuery } from '@tanstack/react-query'
import {
  Archive,
  Box,
  Globe,
  LayoutGrid,
  Puzzle,
  Settings,
  ShieldCheck,
  SquareTerminal,
  UserRound,
  Users,
} from 'lucide-react'
import Link from 'next/link'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { type ReactNode, Suspense, useEffect, useRef } from 'react'
import { SiteFooter } from '../../legal/footer'
import { ApiProvider, useTRPC } from '../../lib/api'
import { insightOn } from '../../lib/insight'
import { presentStatus } from '../../lib/present'
import { RealtimeProvider } from '../../lib/realtime'
import type { Session } from '../../lib/session'
import { SOURCE_PARAMS, sourceOf } from '../../lib/source'
import { ICON, Note, ShareButton, StatusPill } from '../../ui'
import { Lockup } from '../../ui/brand'
import { ResendConfirmation } from '../(auth)/resend-confirmation'
import { AccountMenu } from './account-menu'
import { Feedback } from './feedback'
import styles from './insight.module.css'
import { MomentCard } from './moment'
import { usePrefetch } from './prefetch'

export function AppFrame({
  user,
  data,
  children,
}: {
  user: Session['user']
  /** What the server read for the first paint (lib/first-paint.ts). */
  data: DehydratedState
  children: ReactNode
}) {
  return (
    <ApiProvider data={data}>
      <RealtimeProvider>
        <Shell user={user}>{children}</Shell>
      </RealtimeProvider>
    </ApiProvider>
  )
}

function Shell({ user, children }: { user: Session['user']; children: ReactNode }) {
  const trpc = useTRPC()
  const pathname = usePathname()
  const router = useRouter()
  const params = useParams<{ id?: string }>()
  const serverId = params.id
  const server = useQuery({
    ...trpc.servers.get.queryOptions({ serverId: serverId ?? '' }),
    enabled: Boolean(serverId),
  })
  const view = serverId ? server.data : undefined
  const me = useQuery(trpc.account.me.queryOptions())
  // The first page after sign-up carries where the account came from, with the link's campaign
  // tags; they are kept once, and the address goes back to what it was.
  const search = useSearchParams()
  const carried = search.get('ref')
  const recordSource = useMutation(trpc.account.recordSource.mutationOptions())
  const kept = useRef(false)
  useEffect(() => {
    if (carried === null || kept.current) return
    kept.current = true
    // Read as the links into sign-up read it, so a tag edited by hand is dropped, not the source.
    const link = sourceOf({ ...Object.fromEntries(search), utm_source: undefined })
    if (link !== null) recordSource.mutate(link, { onSettled: () => undefined })
    const rest = new URLSearchParams(search)
    for (const name of SOURCE_PARAMS) rest.delete(name)
    router.replace(rest.size > 0 ? `${pathname}?${rest}` : pathname)
  }, [carried, search, pathname, router, recordSource])
  // Admins see how many alerts are open wherever they are, not only on the admin pages.
  const alerts = useQuery({
    ...trpc.admin.alerts.queryOptions(),
    enabled: me.data?.admin === true,
    refetchInterval: 120_000,
  })

  const serverItems = serverId
    ? [
        { href: `/servers/${serverId}`, label: 'Overview', icon: <LayoutGrid {...ICON} aria-hidden /> },
        {
          href: `/servers/${serverId}/players`,
          label: 'Players',
          icon: <Users {...ICON} aria-hidden />,
          trailing: view?.players ? String(view.players.online) : undefined,
        },
        {
          href: `/servers/${serverId}/mods`,
          label: view?.loader === 'paper' ? 'Plugins' : 'Mods',
          icon: <Puzzle {...ICON} aria-hidden />,
        },
        { href: `/servers/${serverId}/world`, label: 'World', icon: <Globe {...ICON} aria-hidden /> },
        { href: `/servers/${serverId}/backups`, label: 'Backups', icon: <Archive {...ICON} aria-hidden /> },
        {
          href: `/servers/${serverId}/console`,
          label: 'Console',
          icon: <SquareTerminal {...ICON} aria-hidden />,
        },
        {
          href: `/servers/${serverId}/settings`,
          label: 'Settings',
          icon: <Settings {...ICON} aria-hidden />,
        },
      ]
    : []

  // Every link here starts its page's reads as soon as someone heads for it (./prefetch.ts).
  const prefetch = usePrefetch()

  // Next fetches each item's page whole as soon as it shows (`prefetch`), its code included, so a
  // press swaps the page with nothing left to ask the server; this layout isn't run again for it.
  const item = (entry: { href: string; label: string; icon: ReactNode; trailing?: string | undefined }) => (
    <Link
      key={entry.href}
      href={entry.href}
      prefetch
      className="bk-appnav__item"
      aria-current={pathname === entry.href ? 'page' : undefined}
      {...prefetch.intent(entry.href)}
    >
      {entry.icon}
      {entry.label}
      {entry.trailing !== undefined && <span className="bk-appnav__trailing">{entry.trailing}</span>}
    </Link>
  )

  const servers = { href: '/servers', label: 'Servers', icon: <Box {...ICON} aria-hidden /> }
  const admin = {
    href: '/admin',
    label: 'Admin',
    icon: <ShieldCheck {...ICON} aria-hidden />,
    trailing: alerts.data?.length ? String(alerts.data.length) : undefined,
  }
  const account = { href: '/account', label: 'Account', icon: <UserRound {...ICON} aria-hidden /> }

  return (
    <div className="bk-shell">
      <nav className="bk-appnav bk-on-dark" aria-label="Cubepals">
        <Link href="/servers" className="bk-appnav__brand" aria-label="Cubepals">
          <Lockup />
        </Link>
        <div className="bk-appnav__group">
          {item(servers)}
          {item(account)}
          {me.data?.admin && item(admin)}
        </div>
        {serverId && (
          <div className="bk-appnav__group">
            <div className="bk-appnav__heading">
              <span>{view?.name ?? 'Your server'}</span>
            </div>
            {serverItems.map(item)}
          </div>
        )}
        <div className="bk-appnav__spacer" />
        <div className="bk-appnav__foot">
          <AccountMenu email={user.email} />
          {insightOn && <Feedback placement="right-end" className="bk-appnav__icon" iconOnly />}
        </div>
      </nav>

      <div className="bk-shell__main">
        {view && (
          <div className="bk-shell__topbar">
            <div className="bk-row" style={{ gap: 'var(--space-12)', minWidth: 0 }}>
              <span className="type-heading-xs" style={{ color: 'var(--ink)' }}>
                {view.name}
              </span>
              <StatusPill status={presentStatus(view).pill} {...labelOf(presentStatus(view).label)} />
            </div>
            {/* One Share action, on every page of a server: giving it to someone else is one
                thing, so it lives in one place rather than beside every address. */}
            <ShareButton serverId={view.id} name={view.name} />
          </div>
        )}
        <main className="bk-shell__content">
          {!user.emailVerified && (
            <Suspense>
              <ConfirmEmail email={user.email} />
            </Suspense>
          )}
          {children}
        </main>
        {insightOn && (
          <div className={styles.narrow}>
            <Feedback placement="top" className="bk-btn bk-btn--ghost bk-btn--sm" />
          </div>
        )}
        <SiteFooter />
        <MomentCard />
      </div>

      <nav className="bk-bottombar bk-on-dark" aria-label="Cubepals">
        {[servers, ...serverItems].slice(0, 5).map(item)}
      </nav>
    </div>
  )
}

const labelOf = (label: string | undefined) => (label === undefined ? {} : { label })

/** Until the account confirms its email it can't create servers, so every page says how. */
function ConfirmEmail({ email }: { email: string }) {
  // A confirmation link that failed lands back here with Better Auth's code for why.
  const problem = useSearchParams().get('error')
  const why =
    problem === 'TOKEN_EXPIRED'
      ? 'That confirmation link has expired. '
      : problem === 'INVALID_TOKEN'
        ? 'That confirmation link did not work. '
        : ''
  return (
    <Note tone="info">
      {why}Confirm your email to create servers: open the link we sent to {email}.{' '}
      <ResendConfirmation email={email} />
    </Note>
  )
}
