import { Check } from 'lucide-react'
import type { ReactNode } from 'react'

/** The seven server states people see, plus a tone for notices. Never a bare dot. */
export type PillStatus =
  | 'online'
  | 'starting'
  | 'settingUp'
  | 'stopped'
  | 'sleeping'
  | 'crashed'
  | 'suspended'
  | 'info'

const TONE: Record<PillStatus, string> = {
  online: 'online',
  starting: 'starting',
  settingUp: 'starting',
  stopped: 'offline',
  sleeping: 'sleeping',
  crashed: 'danger',
  suspended: 'danger',
  info: 'info',
}

const WORD: Record<PillStatus, string> = {
  online: 'Online',
  starting: 'Starting',
  settingUp: 'Setting up',
  stopped: 'Stopped',
  sleeping: 'Sleeping',
  crashed: 'Crashed',
  suspended: 'Suspended',
  info: 'Notice',
}

export function StatusPill({ status, label }: { status: PillStatus; label?: string }) {
  const pulse = status === 'starting' || status === 'settingUp'
  return (
    <span
      className={['bk-status', `bk-status--${TONE[status]}`, pulse && 'bk-status--pulse']
        .filter(Boolean)
        .join(' ')}
    >
      <span className="bk-status__dot" aria-hidden />
      {label ?? WORD[status]}
    </span>
  )
}

export interface ProvisioningStep {
  label: string
  state: 'todo' | 'active' | 'done'
}

export function ProvisioningPanel({
  title,
  eta,
  progress,
  steps,
  heading = 'h1',
  live,
  children,
}: {
  /** A sentence in product words: "Building your world". */
  title: string
  /** `h2` where the panel sits under a page's own title. */
  heading?: 'h1' | 'h2'
  eta?: string
  /** 0–100. Omit when progress is genuinely unknown; the steps carry it instead. */
  progress?: number
  steps: ProvisioningStep[]
  /** One quiet line under the step it is on, showing it's alive: see `BootLine`. */
  live?: ReactNode
  children?: ReactNode
}) {
  return (
    <section className="bk-prov" aria-live="polite">
      <header>
        {heading === 'h1' ? (
          <h1 className="bk-prov__title">{title}</h1>
        ) : (
          <h2 className="bk-prov__title">{title}</h2>
        )}
        {eta && <p className="bk-prov__eta">{eta}</p>}
      </header>
      {progress !== undefined && (
        <div
          className="bk-prov__bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress)}
        >
          <div className="bk-prov__fill" style={{ '--progress': progress } as React.CSSProperties} />
        </div>
      )}
      <ol className="bk-prov__steps">
        {steps.map((step) => (
          <li key={step.label} className={`bk-prov__step bk-prov__step--${step.state}`}>
            <span className="bk-prov__mark" aria-hidden>
              <Check className="bk-prov__check" size={14} strokeWidth={3} />
            </span>
            <span className="bk-prov__text">
              <span>
                {step.label}
                <span className="bk-visually-hidden">
                  {step.state === 'done' ? ' (done)' : step.state === 'active' ? ' (now)' : ''}
                </span>
              </span>
              {step.state === 'active' && live}
            </span>
          </li>
        ))}
      </ol>
      {children}
    </section>
  )
}
