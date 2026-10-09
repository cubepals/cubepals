import type { Metadata } from 'next'
import { pageMetadata, UNLISTED } from '../../../lib/site'
import { Directory } from './directory'

/** The directory's page: its title and description, and kept out of search for now. */
export const metadata: Metadata = {
  ...pageMetadata({
    title: 'Find a server',
    description:
      'Servers people run on Cubepals and chose to share. Open one to see how to join; a sleeping server wakes up when you do.',
    path: '/browse',
  }),
  robots: UNLISTED,
}

export default function BrowsePage() {
  return <Directory />
}
