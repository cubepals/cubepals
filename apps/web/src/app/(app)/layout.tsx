import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { currentSession } from '../../lib/session'
import { AppFrame } from './frame'

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await currentSession()
  if (session === null) redirect('/sign-in')
  return <AppFrame user={session.user}>{children}</AppFrame>
}
