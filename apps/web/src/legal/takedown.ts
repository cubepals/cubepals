// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Content and copyright: how to tell us about something on {brand} that is illegal or infringes
 * a right, and how a server's owner can answer. Built to meet the EU Digital Services Act's
 * notice and action rules and the US DMCA's notice and counter-notice, in one process.
 */
import type { Policy } from './policy'

export const TAKEDOWN: Policy = {
  slug: 'takedown',
  title: 'Content and copyright',
  description: 'How to report illegal or infringing content on {brand}, and how to answer a report.',
  summary: [
    'To report something that infringes your copyright or is illegal, email {legal} with the details below.',
    'We look at every notice, act on valid ones, and tell both sides what we did and why.',
    'If your content was removed by mistake, you can send a counter-notice.',
  ],
  sections: [
    {
      id: 'contact',
      heading: '1. Where to send notices',
      blocks: [
        'Email {legal}. This is our single point of contact for notices about content, for users and for authorities, in English.',
        'We have no office or company in the EU. Authorities can contact us directly at {legal}.',
        'For a server listing that breaks our rules but isn’t illegal (for example, it isn’t suitable for everyone), the Report button on its public page is quickest.',
      ],
    },
    {
      id: 'notice',
      heading: '2. What a notice must include',
      blocks: [
        'So that we can act quickly, please include:',
        {
          steps: [
            'where the content is: the server’s address or public page link, and what on it (a name, a description, a build, a file or a mod);',
            'why you believe it is illegal or infringes your rights. For copyright, say which work is yours and how it is being copied;',
            'your name and email address (you can leave these out only if you are reporting sexual content involving children);',
            'a statement that you believe in good faith that the information in your notice is accurate and complete;',
            'for copyright notices, a statement that you are the owner of the rights or authorised to act for them, under penalty of perjury, and your physical or electronic signature.',
          ],
        },
      ],
    },
    {
      id: 'action',
      heading: '3. What we do with it',
      blocks: [
        {
          list: [
            'We confirm we received your notice, and look at it carefully and without bias.',
            'If we decide the content is illegal or infringes your rights, or breaks our [Acceptable Use Policy](/legal/acceptable-use), we remove it or block access to it. That might mean removing a listing, removing a file or mod, stopping a server, or suspending an account for repeat or serious cases.',
            'We tell the server’s owner what we did, which content it concerns, why, whether it was based on a notice, and how they can challenge it. We tell you what we decided.',
            'We close the accounts of people who repeatedly infringe other people’s rights.',
            'If we believe a life or someone’s safety is at risk, we tell the police.',
          ],
        },
        'Worlds and servers are not public unless their owner publishes them. We don’t look through private worlds, but we act on notices about them like any other.',
      ],
    },
    {
      id: 'counter',
      heading: '4. If your content was removed',
      blocks: [
        'If you think we got it wrong, reply to our email or write to {legal} within six months. Tell us what was removed and why you think it shouldn’t have been. A person, not an automated system, reviews it, and we tell you the outcome.',
        'For copyright removals, you can send a counter-notice that includes:',
        {
          steps: [
            'what was removed and where it was before;',
            'a statement, under penalty of perjury, that you believe in good faith it was removed by mistake or because it was misidentified;',
            'your name, address and phone number, and that you agree to the courts named in our [Terms](/legal/terms#law) (or, if you live outside them, of where we are) and to accept legal papers from the person who sent the notice;',
            'your physical or electronic signature.',
          ],
        },
        'We forward a valid counter-notice to the person who sent the original notice. Unless they tell us within 10 to 14 working days that they have started court action, we may put the content back.',
        'You also keep any right you have to go to a court or an out-of-court dispute settlement body.',
      ],
    },
    {
      id: 'mods',
      heading: '5. Mods and modpacks',
      blocks: [
        'Most mods and modpacks on {brand} servers are downloaded from where their authors published them, such as Modrinth, under their authors’ licences. If you are a mod author and think {brand} uses your work in a way your licence doesn’t allow, email {legal} and we will look at it straight away.',
      ],
    },
    {
      id: 'misuse',
      heading: '6. Misuse of this process',
      blocks: [
        'Please don’t send notices you know are false or make them to harass someone. If someone repeatedly sends notices that are clearly unfounded, we may stop processing their notices for a while, after warning them.',
      ],
    },
  ],
}
