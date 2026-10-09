import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import Link from 'next/link'
import type { ButtonHTMLAttributes, MouseEventHandler, ReactNode } from 'react'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** `primary` is the one grass fill on a screen. `danger` only inside a DangerZone or its confirmation. */
  variant?:
    | 'primary'
    | 'secondary'
    | 'outline'
    | 'ghost'
    | 'danger'
    | 'inverse'
    /** Dusk: the button that wakes a sleeping world, in that state's own colour. */
    | 'sleeping'
    /** Amber: the work is in flight. An `ActionButton` at work wears it, and a `busy` button. */
    | 'working'
    /** The work finished well, for a moment: an `ActionButton` after it, and a `done` button. */
    | 'done'
  /** `lg` for marketing, `md` in the app, `sm` inside cards and rows. */
  size?: 'sm' | 'md' | 'lg'
  block?: boolean
  icon?: ReactNode
  iconEnd?: ReactNode
  href?: string
  /** No press scale, where motion would distract. */
  static?: boolean
  /**
   * What the server is busy with while this button has to wait for it: the button says so
   * itself, amber with a spinner, "Applying your changes", rather than sitting disabled beside a
   * note, and goes back to its own words once the server is free.
   */
  busy?: string | undefined
  /**
   * The moment after the work it started finished well: a check and a short word, "Saved", in a
   * running server's colour, so a save is seen to land rather than found already done. It takes
   * no press, and goes back to the button's own words when the caller stops showing it.
   */
  done?: string | undefined
  /** The moment after that work failed: the danger colour, a warning and a short word. */
  failed?: string | undefined
  children?: ReactNode
}

export function Button(props: ButtonProps) {
  const {
    variant = 'outline',
    size = 'md',
    block,
    icon,
    iconEnd,
    href,
    static: isStatic,
    busy,
    done,
    failed,
    className,
    children,
    type = 'button',
    ...rest
  } = props
  // A button that can be busy, or say how its work went, changes colour as slowly as a morph.
  const morphs = 'busy' in props || 'done' in props || 'failed' in props
  const working = busy !== undefined
  // Busy first: the server at work again is the newer news than how the last press went.
  const said = working ? busy : (failed ?? done)
  const tone = working ? 'working' : failed !== undefined ? 'danger' : done !== undefined ? 'done' : variant
  const lead = working ? (
    <Loader2 size={16} strokeWidth={1.75} className="bk-spin" aria-hidden />
  ) : failed !== undefined ? (
    <AlertTriangle size={16} strokeWidth={1.75} className="bk-btn__said" aria-hidden />
  ) : done !== undefined ? (
    <Check size={16} strokeWidth={2.25} className="bk-btn__said" aria-hidden />
  ) : (
    icon
  )
  const classes = [
    'bk-btn',
    `bk-btn--${tone}`,
    `bk-btn--${size}`,
    block && 'bk-btn--block',
    lead && 'bk-btn--lead',
    iconEnd && 'bk-btn--trail',
    isStatic && 'bk-btn--static',
    morphs && 'bk-btn--morphing',
    // Busy or saying how it went, not disabled: it keeps its colour and its weight, and takes no press.
    said !== undefined && 'bk-btn--busy',
    className,
  ]
    .filter(Boolean)
    .join(' ')
  const content = (
    <>
      {lead && <span className="bk-btn__icon">{lead}</span>}
      {said ?? children}
      {iconEnd && said === undefined && <span className="bk-btn__icon">{iconEnd}</span>}
    </>
  )
  // Another site opens beside Blockly rather than instead of it.
  if (href !== undefined && /^https?:\/\//.test(href))
    return (
      <a href={href} className={classes} target="_blank" rel="noreferrer" aria-label={rest['aria-label']}>
        {content}
      </a>
    )
  // An app on this computer, by a link of its own (`modrinth://`): the browser hands it over, and
  // the page stays where it is.
  if (href !== undefined && /^[a-z][a-z\d+.-]*:/i.test(href))
    return (
      <a
        href={href}
        className={classes}
        aria-label={rest['aria-label']}
        onClick={rest.onClick as MouseEventHandler<HTMLAnchorElement> | undefined}
      >
        {content}
      </a>
    )
  if (href !== undefined)
    return (
      <Link href={href} className={classes} aria-disabled={rest.disabled || undefined}>
        {content}
      </Link>
    )
  return (
    <button
      type={type}
      className={classes}
      {...rest}
      disabled={said !== undefined ? undefined : rest.disabled}
      aria-disabled={said !== undefined || undefined}
      aria-busy={working || undefined}
      aria-live={morphs ? 'polite' : undefined}
    >
      {content}
    </button>
  )
}
