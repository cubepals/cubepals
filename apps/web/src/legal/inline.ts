/**
 * The little markup a policy's sentences use, read into pieces a page renders: `[words](/path)`
 * for a link, `**words**` for the few that must stand out, and `{token}` for what the operator
 * file says (who runs the service, how to reach them). Nothing else is markup, so a sentence
 * reads the same in the source as on the page.
 */

/** The operator's details a sentence can name. */
export const TOKENS = [
  'brand',
  'domain',
  'playDomain',
  'name',
  'address',
  'country',
  'law',
  'emailProvider',
  'emailProviderWhere',
  'support',
  'privacy',
  'legal',
] as const
export type Token = (typeof TOKENS)[number]

export type Piece =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'token'; token: Token }

const PATTERN = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\{([A-Za-z]+)\}/g

/** A sentence in pieces. A `{word}` that isn't a token stays as the text it is. */
export function piecesOf(sentence: string): Piece[] {
  const pieces: Piece[] = []
  let at = 0
  const text = (until: number) => {
    if (until > at) pieces.push({ kind: 'text', text: sentence.slice(at, until) })
  }
  for (const match of sentence.matchAll(PATTERN)) {
    const [whole, linkText, href, strong, token] = match
    const start = match.index
    if (token !== undefined && !(TOKENS as readonly string[]).includes(token)) continue
    text(start)
    if (linkText !== undefined && href !== undefined) pieces.push({ kind: 'link', text: linkText, href })
    else if (strong !== undefined) pieces.push({ kind: 'strong', text: strong })
    else pieces.push({ kind: 'token', token: token as Token })
    at = start + whole.length
  }
  text(sentence.length)
  return pieces
}

/**
 * A sentence as plain text, for a page's title or description: links keep their words, tokens
 * become what `say` makes of them.
 */
export function plainOf(sentence: string, say: (token: Token) => string): string {
  return piecesOf(sentence)
    .map((piece) => (piece.kind === 'token' ? say(piece.token) : piece.text))
    .join('')
}
