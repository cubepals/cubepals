/**
 * What a world download holds. An archive is the server's whole disk, kept that way for restores,
 * moves and stored worlds; what its owner downloads is the part that is theirs to take: each
 * world with its datapacks, the settings and configs, and the lists of who may join. Mojang's
 * server jar, the loader's libraries and the mod and plugin jars stay out, since Blockly may not
 * hand them on; a server that starts with the world installs them again. Only paths are judged
 * here; the archive is read and rewritten by a port.
 */

import { isAddedJar } from './uploads.ts'

/** What a download leaves out, by path in the archive, and why. Everything else goes in. */
export const LEFT_OUT_OF_DOWNLOADS: readonly { path: RegExp; why: string }[] = [
  {
    path: /\.jar$/i,
    why: 'Mojang’s server jar, a loader’s launcher, installer or shim, each mod and plugin, and the copies Paper remaps',
  },
  { path: /^libraries(\/|$)/, why: 'what the server jar unpacks and a loader installs to run' },
  { path: /^versions(\/|$)/, why: 'the game the server jar unpacks' },
  { path: /^cache(\/|$)/, why: 'Paper’s copy of Mojang’s jar' },
  {
    path: /^\.[^/]/,
    why: 'Fabric’s and Quilt’s copies of the game (.fabric/, .quilt/) and the image’s records of what it installed',
  },
  {
    path: /^cubepals-download\.txt$/,
    why: 'the note an earlier download carried, written again for this one',
  },
]

/** Whether an entry of an archive, by its path without a leading `./`, goes in a download. */
export const inWorldDownload = (path: string): boolean =>
  !LEFT_OUT_OF_DOWNLOADS.some((rule) => rule.path.test(path))

/** The note at the top of every download: what it holds, and the mods and plugins it left out. */
export const DOWNLOAD_NOTE = 'cubepals-download.txt'

export function downloadNote(leftOutJars: readonly string[]): string {
  const lines = [
    'Your world from Cubepals, with its settings and lists.',
    '',
    'Minecraft’s server, its loader, and the mods and plugins aren’t in it: they aren’t ours to give out. A Cubepals server gets them again when it starts with this world.',
  ]
  if (leftOutJars.length > 0) lines.push('', 'Played with:', ...leftOutJars)
  return `${lines.join('\n')}\n`
}

/** The mods and plugins a download's note says it left out, so an upload knows them. */
export const jarsInNote = (note: string): string[] =>
  note
    .split('\n')
    .map((line) => line.trim())
    .filter(isAddedJar)
