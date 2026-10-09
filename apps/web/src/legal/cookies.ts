/**
 * The cookie notice: every cookie and browser-storage key {brand} sets, all of them needed for
 * the service to work, which is why the site asks for no consent. Its analytics (PostHog,
 * cookieless) store nothing, and it says so. A new cookie that isn't needed (analytics that store
 * something, ads) needs consent asked first, and a line here, before it ships.
 */
import type { Policy } from './policy'

export const COOKIES: Policy = {
  slug: 'cookies',
  title: 'Cookies',
  description: 'The few cookies {brand} uses, all of them needed to make it work.',
  summary: [
    'We only use cookies that {brand} needs to work, like keeping you signed in.',
    'No advertising or tracking cookies, so there is nothing to accept or turn off.',
    'We count how {brand} is used without cookies and without storing anything on your device.',
  ],
  sections: [
    {
      id: 'what',
      heading: '1. The cookies we use',
      blocks: [
        'Cookies are small files a website keeps in your browser. These are all the ones {brand} sets. They are only sent to {brand} itself.',
        {
          table: {
            head: ['Cookie', 'What it does', 'How long'],
            rows: [
              [
                'session_token (its name starts with the site’s prefix)',
                'Keeps you signed in. Scripts on the page can’t read it.',
                '7 days from when you last used {brand}, or until you sign out',
              ],
              [
                'dont_remember',
                'Set only if you sign in without staying signed in, so the session ends when you close your browser.',
                'Until you close your browser',
              ],
              [
                'state (while signing in with Google or GitHub)',
                'Makes sure the sign-in that comes back is the one you started, to stop forged sign-ins.',
                '10 minutes',
              ],
            ],
          },
        },
        'These are strictly necessary for a service you asked for, so the law doesn’t require us to ask for your consent to them.',
      ],
    },
    {
      id: 'storage',
      heading: '2. Other things kept in your browser',
      blocks: [
        'On a server’s page, {brand} remembers in your browser’s local storage that you dismissed a tip (for example “invite your first friend” or suggested mods), so it doesn’t show it again. It holds only the word “done” and the server it belongs to, and never leaves your browser.',
        'To count which pages are visited and which errors the site hits, {brand} uses PostHog in a mode that sets no cookie and keeps nothing in your browser’s storage. It can’t follow you from one day to the next, records no screens, and sends no name, email or IP address.',
      ],
    },
    {
      id: 'third-parties',
      heading: '3. Other websites',
      blocks: [
        'When you browse modpacks, your browser loads their pictures from Modrinth, which sees your IP address as any website you load something from does. {brand} doesn’t add any tracking to it. Payment pages are Polar’s, and use Polar’s own cookies under [Polar’s policies](https://polar.sh/legal/privacy).',
      ],
    },
    {
      id: 'control',
      heading: '4. Your choices',
      blocks: [
        'You can delete or block cookies in your browser’s settings. If you block the sign-in cookie, you won’t be able to sign in. If we ever want to use a cookie that isn’t needed for {brand} to work, we will ask you first and add it here.',
      ],
    },
  ],
}
