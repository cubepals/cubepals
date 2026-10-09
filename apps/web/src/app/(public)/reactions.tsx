'use client'

import {
  type ListingCardView,
  NOTE_MAX_LENGTH,
  type NotesView,
  type PublicServerView,
  type ReactionsView,
} from '@blockly/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUp, MessageCircle, Star, X } from 'lucide-react'
import { usePathname } from 'next/navigation'
import { type RefObject, type SubmitEvent, useCallback, useEffect, useId, useRef, useState } from 'react'
import { messageOf, useTRPC } from '../../lib/api'
import { timeAgo } from '../../lib/present'
import { noted, shortCount, starred } from '../../lib/reactions'
import * as rules from '../../lib/rules'
import { behindSignIn, useSignedIn } from '../../lib/viewer'
import { Button, Popover, Skeleton } from '../../ui'
import styles from './reactions.module.css'

/** How close to the most a note says the composer starts counting down what is left. */
const COUNT_FROM = 20

/** How long a star that didn't take says why, before it goes by itself. */
const FAILURE_SHOWN_MS = 4000

/**
 * A server's stars and notes, on its card in the directory and on its own page: a guestbook,
 * never a community. Everyone sees the two counts. Someone signed in stars with one press and
 * reads or leaves a line in a small popover; someone signed out is asked to sign in, and that is
 * all. Whatever changes, changes wherever the page holds the server, so its card and its page
 * always say the same.
 */
export function Reactions({ reactions }: { reactions: ReactionsView }) {
  return (
    <div className={styles.reactions}>
      <StarButton reactions={reactions} />
      <NotesButton reactions={reactions} />
    </div>
  )
}

/**
 * Changes one server's reactions wherever the page holds them: every directory search it shows up
 * in, and its own page. Nothing is refetched for a star or a note.
 */
function usePatch() {
  const trpc = useTRPC()
  const queries = useQueryClient()
  return useCallback(
    (serverId: string, change: (view: ReactionsView) => ReactionsView) => {
      queries.setQueriesData<{ listings: ListingCardView[] }>(trpc.listings.browse.queryFilter(), (found) =>
        found === undefined
          ? found
          : {
              ...found,
              listings: found.listings.map((listing) =>
                listing.reactions.serverId === serverId
                  ? { ...listing, reactions: change(listing.reactions) }
                  : listing,
              ),
            },
      )
      queries.setQueriesData<PublicServerView | null>(trpc.sharing.page.queryFilter(), (page) =>
        page?.reactions?.serverId === serverId ? { ...page, reactions: change(page.reactions) } : page,
      )
    },
    [queries, trpc],
  )
}

function StarButton({ reactions }: { reactions: ReactionsView }) {
  const signedIn = useSignedIn()
  const trpc = useTRPC()
  const queries = useQueryClient()
  const patch = usePatch()
  const { serverId, stars } = reactions
  // One server's presses go to the API one after another, wherever the page shows its star, so
  // the last press is also the last one stored.
  const star = useMutation(trpc.listings.star.mutationOptions({ scope: { id: `star:${serverId}` } }))
  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const noun = stars === 1 ? 'star' : 'stars'

  // Why a star didn't take is said for a moment and goes by itself: there is nothing in it to press.
  useEffect(() => {
    if (!open || failure === null) return
    const timer = setTimeout(() => setOpen(false), FAILURE_SHOWN_MS)
    return () => clearTimeout(timer)
  }, [open, failure])

  // An owner doesn't star their own server: the count is there, with nothing to press.
  if (reactions.yours)
    return (
      <span className={styles.count}>
        <Star size={16} strokeWidth={1.75} aria-hidden />
        <span className="type-caption bk-num">{shortCount(stars)}</span>
        <span className="bk-visually-hidden">{noun}</span>
      </span>
    )

  const press = async () => {
    const on = !reactions.starred
    setOpen(false)
    // A directory or page fetch already under way would land on top of the press and undo it.
    await Promise.all([
      queries.cancelQueries(trpc.listings.browse.queryFilter()),
      queries.cancelQueries(trpc.sharing.page.queryFilter()),
    ])
    // Shown at once, then put right by the API's own count when it answers.
    patch(serverId, (view) => starred(view, on))
    star.mutate(
      { serverId, starred: on },
      {
        // Given to `mutate`, these run for the latest press only, so an earlier answer arriving
        // late can't undo a later press.
        onSuccess: (next) =>
          patch(serverId, (view) => ({ ...view, stars: next.stars, starred: next.starred })),
        // What the page shows goes back to what the API kept, fetched rather than guessed: after
        // presses that failed in a row, undoing one would show a star nobody stored.
        onError: (error) => {
          void queries.invalidateQueries(trpc.listings.browse.queryFilter())
          void queries.invalidateQueries(trpc.sharing.page.queryFilter())
          setFailure(messageOf(error))
          setOpen(true)
        },
      },
    )
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label="Star"
      alert={signedIn}
      anchor={(reference) => (
        <button
          type="button"
          className={styles.button}
          {...reference(
            signedIn
              ? {
                  'aria-label': `Star, ${stars} ${noun}`,
                  'aria-pressed': reactions.starred,
                  onClick: () => void press(),
                }
              : { 'aria-label': `Star, ${stars} ${noun}` },
          )}
        >
          <span className="bk-swap" aria-hidden>
            <Star size={16} strokeWidth={1.75} data-shown={!reactions.starred} />
            <Star size={16} strokeWidth={1.75} fill="currentColor" data-shown={reactions.starred} />
          </span>
          <span className="type-caption bk-num">{shortCount(stars)}</span>
        </button>
      )}
    >
      {signedIn ? <p className="type-body-sm">{failure}</p> : <AskToSignIn line="Sign in to star it." />}
    </Popover>
  )
}

function NotesButton({ reactions }: { reactions: ReactionsView }) {
  const signedIn = useSignedIn()
  const [open, setOpen] = useState(false)
  // Held here rather than in the popover, so a note half written survives a press elsewhere.
  const [draft, setDraft] = useState('')
  const composer = useRef<HTMLInputElement>(null)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label="Notes"
      initialFocus={signedIn ? composer : undefined}
      anchor={(reference) => (
        <button
          type="button"
          className={styles.button}
          {...reference({ 'aria-label': `Notes, ${reactions.notes}` })}
        >
          <MessageCircle size={16} strokeWidth={1.75} aria-hidden />
          <span className="type-caption bk-num">{shortCount(reactions.notes)}</span>
        </button>
      )}
    >
      {signedIn ? (
        <Notes serverId={reactions.serverId} draft={draft} onDraft={setDraft} composer={composer} />
      ) : (
        <AskToSignIn line="Sign in to leave a note." />
      )}
    </Popover>
  )
}

/** The latest few notes, newest first, and a line to leave one of your own. */
function Notes({
  serverId,
  draft,
  onDraft,
  composer,
}: {
  serverId: string
  draft: string
  onDraft: (draft: string) => void
  composer: RefObject<HTMLInputElement | null>
}) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const patch = usePatch()
  const ids = useId()
  const notes = useQuery(trpc.listings.notes.queryOptions({ serverId }))
  const [problem, setProblem] = useState<string | null>(null)
  const put = (next: NotesView) => {
    queries.setQueryData(trpc.listings.notes.queryKey({ serverId }), next)
    patch(serverId, (view) => noted(view, next.total))
  }
  const add = useMutation(
    trpc.listings.addNote.mutationOptions({
      onSuccess: (next) => {
        put(next)
        onDraft('')
      },
    }),
  )
  const remove = useMutation(trpc.listings.deleteNote.mutationOptions({ onSuccess: put }))

  // The count beside the icon follows the notes as they were last fetched, so it never
  // disagrees with the list it opens.
  const total = notes.data?.total
  useEffect(() => {
    if (total !== undefined) patch(serverId, (view) => noted(view, total))
  }, [patch, serverId, total])

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (add.isPending) return
    const wrong = rules.note(draft)
    setProblem(wrong)
    if (wrong === null) add.mutate({ serverId, body: draft.trim() })
  }

  const now = Date.now()
  const left = NOTE_MAX_LENGTH - draft.length
  // What is wrong with the note written; a delete that failed is said too, but isn't the field's.
  const invalid = problem ?? (add.isError ? messageOf(add.error) : null)
  const said = invalid ?? (remove.isError ? messageOf(remove.error) : null)
  const field = `${ids}-note`
  const error = `${ids}-error`
  const more = notes.data ? notes.data.total - notes.data.notes.length : 0

  return (
    <div className={styles.panel}>
      {notes.isPending ? (
        <Skeleton width="100%" height={40} />
      ) : notes.isError ? (
        <p className={`type-body-sm ${styles.quiet}`}>{messageOf(notes.error)}</p>
      ) : notes.data.notes.length === 0 ? (
        <p className={`type-body-sm ${styles.quiet}`}>No notes yet.</p>
      ) : (
        <ul className={styles.notes}>
          {notes.data.notes.map((note) => (
            <li key={note.id} className={styles.note}>
              <p className={`type-body-sm ${styles.body}`} dir="auto">
                {note.body}
              </p>
              <span className={`type-caption ${styles.meta}`}>
                {note.yours ? 'You · ' : note.byOwner ? 'Owner · ' : ''}
                {timeAgo(note.at, now)}
              </span>
              {note.canDelete && (
                <button
                  type="button"
                  className={styles.remove}
                  aria-label="Delete note"
                  aria-disabled={remove.isPending || undefined}
                  onClick={() => {
                    if (!remove.isPending) remove.mutate({ noteId: note.id })
                  }}
                >
                  <X size={14} strokeWidth={1.75} aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {more > 0 && <p className={`type-caption ${styles.quiet}`}>and {more} more</p>}
      <form className={styles.composer} onSubmit={submit}>
        <label htmlFor={field} className="bk-visually-hidden">
          Leave a note
        </label>
        <input
          ref={composer}
          id={field}
          className={styles.input}
          value={draft}
          maxLength={NOTE_MAX_LENGTH}
          placeholder="Leave a note"
          autoComplete="off"
          dir="auto"
          // Read-only rather than disabled while it sends, so focus stays in the field.
          readOnly={add.isPending}
          aria-invalid={invalid !== null || undefined}
          aria-describedby={invalid !== null ? error : undefined}
          onChange={(event) => {
            onDraft(event.target.value)
            setProblem(null)
            if (add.isError) add.reset()
            if (remove.isError) remove.reset()
          }}
        />
        {left <= COUNT_FROM && <span className={`type-caption bk-num ${styles.left}`}>{left}</span>}
        <button
          type="submit"
          className={styles.send}
          aria-label="Send note"
          aria-disabled={add.isPending || undefined}
        >
          <ArrowUp size={16} strokeWidth={2} aria-hidden />
        </button>
      </form>
      {said !== null && (
        <p id={error} className={`type-caption ${styles.error}`} role="alert">
          {said}
        </p>
      )}
    </div>
  )
}

/** All someone signed out is told: this takes an account, and where to sign in to come back here. */
function AskToSignIn({ line }: { line: string }) {
  const here = usePathname()
  return (
    <div className={styles.ask}>
      <p className="type-body-sm">{line}</p>
      <Button variant="outline" size="sm" href={behindSignIn(false, here)}>
        Sign in
      </Button>
    </div>
  )
}
