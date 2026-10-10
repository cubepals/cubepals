// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The emails to a server's owner about what happened to that server: it left the directory over
 * a mod (listings/service.ts), its idle world will be deleted (operations/schedules/expiring.ts),
 * or it was rebuilt from a backup on another computer (operations/handlers/moving.ts).
 */
import { box, type Email, esc, INK, layout, link, MONO, MUTED, OWNER, p, SANS, small } from '../emails.ts'

type Server = { id: string; name: string }

export function listingRemoved(input: {
  server: Server
  mods: ReadonlyArray<{ name: string; why: string }>
  origin: string
}): Email {
  const url = `${input.origin}/servers/${input.server.id}/mods`
  const lines = input.mods.map((m) => `- ${m.name}: ${m.why}`)
  return {
    subject: `“${input.server.name}” left the Cubepals directory`,
    preheader: 'Your server keeps running. Update or remove the mod and the listing comes back.',
    text: [
      `Your server ${input.server.name} is no longer shown in the Cubepals directory, because of a mod it runs:`,
      '',
      ...lines,
      '',
      'Your server keeps running as it is. Update or remove the mod, and the listing comes back on its own:',
      url,
    ].join('\n'),
    html: layout({
      origin: input.origin,
      preheader: 'Your server keeps running. Update or remove the mod and the listing comes back.',
      chip: { label: 'Not listed', tone: 'danger' },
      heading: `“${esc(input.server.name)}” left the directory`,
      body:
        p(
          `Your server <strong style="color:${INK}">${esc(input.server.name)}</strong> is no longer shown in the Cubepals directory, because of a mod it runs:`,
        ) +
        box(
          input.mods
            .map(
              (m) =>
                `<p style="margin:0 0 6px;font:400 15px/1.5 ${SANS};color:${MUTED}"><strong style="font-family:${MONO};color:${INK}">${esc(m.name)}</strong><br>${esc(m.why)}</p>`,
            )
            .join(''),
        ) +
        p(
          'Your server keeps running as it is. Update or remove the mod, and the listing comes back on its own.',
        ),
      action: { label: 'Open mods', url },
      why: OWNER,
    }),
  }
}

export function keepingWorld(input: {
  server: Server
  lastPlayed: string
  goes: string
  origin: string
}): Email {
  const page = `${input.origin}/servers/${input.server.id}`
  const name = esc(input.server.name)
  return {
    subject: `We’re keeping ${input.server.name} until ${input.goes}`,
    preheader: 'Play on it or press Keep it, and it stays.',
    text: [
      `Nobody has played ${input.server.name} since ${input.lastPlayed}. Free worlds are kept for a year after they were last played, so on ${input.goes} it will be deleted.`,
      '',
      `To keep it, play on it, or press Keep it on its page: ${page}`,
      `You can download it there too: ${page}/backups`,
    ].join('\n'),
    html: layout({
      origin: input.origin,
      preheader: 'Play on it or press Keep it, and it stays.',
      chip: { label: `Last played ${input.lastPlayed}`, tone: 'quiet' },
      figure: { name: 'kai-hanging', hang: true },
      heading: `We’re keeping ${name} until ${esc(input.goes)}`,
      body:
        p(
          `Nobody has played <strong style="color:${INK}">${name}</strong> since ${esc(input.lastPlayed)}. Free worlds are kept for a year after they were last played, so on ${esc(input.goes)} it will be deleted.`,
        ) + p('To keep it, play on it, or press Keep it on its page.'),
      action: { label: 'Keep it', url: page },
      after: small(
        `You can download it there too: ${link({ label: 'Download the world', url: `${page}/backups` })}`,
      ),
      why: OWNER,
    }),
  }
}

export function serverRebuilt(input: { server: Server; backupAt: string; origin: string }): Email {
  const page = `${input.origin}/servers/${input.server.id}`
  const name = esc(input.server.name)
  return {
    subject: `“${input.server.name}” was moved after the computer it ran on failed`,
    preheader: `It came back from its backup of ${input.backupAt}.`,
    text: [
      `The computer your server ${input.server.name} ran on stopped answering, so Cubepals moved it to another one in the same place.`,
      '',
      `It came back from its backup of ${input.backupAt}. Anything built or changed in the world after that is gone. Who can join is as you set it.`,
      '',
      page,
    ].join('\n'),
    html: layout({
      origin: input.origin,
      preheader: `It came back from its backup of ${input.backupAt}.`,
      chip: { label: 'Moved', tone: 'online' },
      heading: `${name} was moved to another computer`,
      body:
        p(
          `The computer your server <strong style="color:${INK}">${name}</strong> ran on stopped answering, so Cubepals moved it to another one in the same place.`,
        ) +
        box(
          `<p style="margin:0;font:400 15px/1.5 ${SANS};color:${MUTED}">Restored from the backup of<br><strong style="font-family:${MONO};color:${INK}">${esc(input.backupAt)}</strong></p>`,
        ) +
        p('Anything built or changed in the world after that is gone. Who can join is as you set it.'),
      action: { label: `Open ${input.server.name}`, url: page },
      why: OWNER,
    }),
  }
}
