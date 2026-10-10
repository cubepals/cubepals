'use client'

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTRPC } from '../../../lib/api'
import { useNow } from '../../../lib/hooks'
import { whenTaken } from '../../../lib/present'
import { NavTabs, Note } from '../../../ui'

/** The admin area's sections, and above them whatever needs an admin right now. */
export function AdminTabs() {
  const pathname = usePathname()
  return (
    <>
      <NavTabs
        label="Admin sections"
        current={pathname}
        items={[
          { href: '/admin', label: 'Accounts' },
          { href: '/admin/servers', label: 'Servers' },
          { href: '/admin/platform', label: 'Platform' },
          { href: '/admin/operations', label: 'Operations' },
          { href: '/admin/audit', label: 'Audit log' },
          { href: '/admin/reports', label: 'Reports' },
          { href: '/admin/allowlist', label: 'Trusted mods' },
          { href: '/admin/packs', label: 'Curated packs' },
          { href: '/admin/coupons', label: 'Coupons' },
        ]}
      />
      <Alerts current={pathname} />
    </>
  )
}

/** Alerts read live: they leave this list as soon as what raised them passes. */
function Alerts({ current }: { current: string }) {
  const trpc = useTRPC()
  const now = useNow(60_000)
  const alerts = useQuery({ ...trpc.admin.alerts.queryOptions(), refetchInterval: 60_000 })
  if (!alerts.data?.length) return null
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
      {alerts.data.map((alert) => (
        <Note key={alert.key} tone="danger">
          {alert.summary} Since {whenTaken(alert.since, now).toLowerCase()}.{' '}
          {alert.href !== current && <Link href={alert.href}>Deal with it</Link>}
        </Note>
      ))}
    </div>
  )
}
