// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from 'next'
import { PRIVATE } from '../../../../lib/site'
import { inviteCodeOf, invitedTo, needsLine, playingLine, publicUrl } from '../../status'
import { InviteView } from './view'

/**
 * An invitation pasted into a chat says who it is for before anyone opens it. Where Blockly
 * couldn't answer just then, it says nothing but its own name: a busy minute is not an invite
 * that expired, and a chat keeps the preview it was first shown. Invites are private by design, so
 * no search engine lists or follows one, whatever it answers.
 */
export async function generateMetadata({ params }: { params: Promise<{ code: string }> }): Promise<Metadata> {
  return { ...(await previewOf((await params).code)), robots: PRIVATE }
}

async function previewOf(opened: string): Promise<Metadata> {
  const code = inviteCodeOf(opened)
  if (code === null) return { title: 'This link isn’t quite right' }
  const status = await invitedTo(code)
  if (status === 'unanswered') return {}
  if (status === 'missing') return { title: 'This invite has expired' }
  // A pack to install is what a friend needs to know before anything else about the server.
  const description = [needsLine(status), status.description || playingLine(status)].filter(Boolean).join(' ')
  const title = `You’re invited to ${status.name}`
  const image = await publicUrl(`/api/public/invites/${code}/card.png`)
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: 'website',
      images: [{ url: image, width: 1200, height: 630, alt: status.name }],
    },
  }
}

export default async function Page({ params }: { params: Promise<{ code: string }> }) {
  return <InviteView code={inviteCodeOf((await params).code)} />
}
