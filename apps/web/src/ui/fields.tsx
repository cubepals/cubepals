'use client'

import { type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes, useId } from 'react'

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** The input itself, for whatever has to measure or anchor to it. */
  ref?: Ref<HTMLInputElement>
  label: string
  help?: ReactNode
  /** Replaces `help` and sets the invalid style. Write the fix, not the rule. */
  error?: string | null
  optional?: boolean
  /** For addresses, seeds and other values people copy. */
  mono?: boolean
  trailing?: ReactNode
  /** An icon inside the field's leading edge, where a search says what it is without a word. */
  leading?: ReactNode
}

export function TextField({
  label,
  help,
  error,
  optional,
  mono,
  trailing,
  leading,
  className,
  id,
  ...input
}: TextFieldProps) {
  const generated = useId()
  const inputId = id ?? generated
  const note = `${inputId}-note`
  return (
    <div className={['bk-field', error && 'bk-field--invalid', className].filter(Boolean).join(' ')}>
      <label className="bk-field__label" htmlFor={inputId}>
        {label} {optional && <span className="bk-field__optional">(optional)</span>}
      </label>
      <div className={['bk-affixed', leading && 'bk-affixed--leading'].filter(Boolean).join(' ')}>
        {leading && (
          <span className="bk-affixed__lead" aria-hidden>
            {leading}
          </span>
        )}
        <input
          id={inputId}
          className={['bk-input', mono && 'bk-input--mono'].filter(Boolean).join(' ')}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || help ? note : undefined}
          {...input}
        />
        {trailing}
      </div>
      {error ? (
        <p id={note} className="bk-field__error" role="alert">
          {error}
        </p>
      ) : help ? (
        <p id={note} className="bk-field__help">
          {help}
        </p>
      ) : null}
    </div>
  )
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string
  help?: string
  options: Array<{ value: string; label: string; disabled?: boolean }>
}

export function Select({ label, help, options, id, ...select }: SelectProps) {
  const generated = useId()
  const selectId = id ?? generated
  return (
    <div className="bk-field">
      <label className="bk-field__label" htmlFor={selectId}>
        {label}
      </label>
      <select id={selectId} className="bk-selectctl" {...select}>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      {help && <p className="bk-field__help">{help}</p>}
    </div>
  )
}

export interface ToggleProps {
  checked: boolean
  onChange: (next: boolean) => void
  label?: string
  ariaLabel?: string
  disabled?: boolean
}

export function Toggle({ checked, onChange, label, ariaLabel, disabled }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      className="bk-toggle"
      aria-checked={checked}
      aria-label={label ? undefined : ariaLabel}
      aria-disabled={disabled || undefined}
      onClick={() => !disabled && onChange(!checked)}
    >
      <span className="bk-toggle__track">
        <span className="bk-toggle__knob" />
      </span>
      {label && <span className="bk-toggle__label">{label}</span>}
    </button>
  )
}

export interface CheckboxProps {
  checked: boolean
  onChange: (next: boolean) => void
  /** What ticking it says, in the person's own words. May hold links. */
  children: ReactNode
  /** Said under the box, with the invalid style. Write the fix, not the rule. */
  error?: string | null
  /** The invalid style alone, where the words are said once for several boxes. */
  invalid?: boolean
}

/** A box someone ticks to say something themselves: an agreement, never a setting (that's Toggle). */
export function Checkbox({ checked, onChange, children, error, invalid }: CheckboxProps) {
  const id = useId()
  const note = `${id}-note`
  const wrong = Boolean(error) || invalid === true
  return (
    <div className={['bk-check', wrong && 'bk-check--invalid'].filter(Boolean).join(' ')}>
      <input
        id={id}
        type="checkbox"
        className="bk-check__box"
        checked={checked}
        aria-invalid={wrong ? true : undefined}
        aria-describedby={error ? note : undefined}
        onChange={(event) => onChange(event.target.checked)}
      />
      <label htmlFor={id} className="bk-check__label">
        {children}
      </label>
      {error && (
        <p id={note} className="bk-field__error bk-check__error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export function FormSection({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
  children?: ReactNode
}) {
  return (
    <section className="bk-formsection">
      <header>
        <h2 className="bk-formsection__title">{title}</h2>
        {description && <p className="bk-formsection__desc">{description}</p>}
      </header>
      {children && <div className="bk-formsection__body">{children}</div>}
      {actions && <footer className="bk-formsection__foot">{actions}</footer>}
    </section>
  )
}

export function FormRow({
  label,
  description,
  control,
  why,
}: {
  label: ReactNode
  description?: ReactNode
  control: ReactNode
  /** Why the row can't be picked: it is dimmed, and this line, which isn't, says so. */
  why?: string | undefined
}) {
  return (
    <div className={why === undefined ? 'bk-formrow' : 'bk-formrow bk-formrow--dimmed'}>
      <div>
        <div className="bk-formrow__label">{label}</div>
        {description && <p className="bk-formrow__desc">{description}</p>}
        {why !== undefined && <p className="bk-formrow__why">{why}</p>}
      </div>
      {control}
    </div>
  )
}
