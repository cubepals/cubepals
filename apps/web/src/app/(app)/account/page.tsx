'use client'

import { type AccountOverviewView, UPGRADE_REASONS, type UpgradeReason } from '@blockly/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter, useSearchParams } from 'next/navigation'
import { type ReactNode, Suspense, useEffect, useRef, useState } from 'react'
import { messageOf, useTRPC } from '../../../lib/api'
import { checkoutHref } from '../../../lib/checkout'
import { useOutcome } from '../../../lib/outcome'
import { dayOf, loaderLabel } from '../../../lib/present'
import {
  Button,
  FormRow,
  FormSection,
  LoadFailed,
  Modal,
  Note,
  PageSkeleton,
  PlanCard,
  ProgressBar,
  Skeleton,
  Tip,
} from '../../../ui'
import { PlusOffer } from '../plus-offer'

/** The signed-in person's plan: what it allows, what they use of it, and upgrading or managing it. */
export default function AccountPage() {
  // The plan section reads the query string (a return from billing), which needs a boundary.
  return (
    <Suspense fallback={<AccountSkeleton />}>
      <Account />
    </Suspense>
  )
}

function Account() {
  const trpc = useTRPC()
  const me = useQuery(trpc.account.me.queryOptions())
  const overview = useQuery(trpc.account.overview.queryOptions())
  // Both are drawn with the page from the server, or asked for before its link was followed; this
  // is for when neither had the chance.
  if (me.isPending || overview.isPending) return <AccountSkeleton email={me.data?.email} />
  if (me.isError) return <LoadFailed error={messageOf(me.error)} onRetry={() => me.refetch()} />
  if (overview.isError)
    return <LoadFailed error={messageOf(overview.error)} onRetry={() => overview.refetch()} />
  return (
    <>
      <header className="bk-stack" style={{ gap: 'var(--space-8)' }}>
        <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
          Account
        </h1>
        <Who>
          {me.data.name ? `${me.data.name} · ` : ''}
          {me.data.email}
        </Who>
      </header>
      {overview.data.standing.status !== 'active' && (
        <Note tone="danger">
          {overview.data.standing.status === 'suspended'
            ? `Your account is suspended${overview.data.standing.reason ? `: ${overview.data.standing.reason}` : ''}. Your servers can't start until it's restored.`
            : 'This account is closed.'}
        </Note>
      )}
      <Plan overview={overview.data} />
      <Play overview={overview.data} />
      <Includes overview={overview.data} />
      <Plans overview={overview.data} />
    </>
  )
}

/** The line under the heading: who is signed in. */
function Who({ children }: { children: ReactNode }) {
  return (
    <p className="type-body" style={{ color: 'var(--ink-muted)' }}>
      {children}
    </p>
  )
}

/** The account page before its data: its heading, then its plan, its play and what it includes. */
function AccountSkeleton({ email }: { email?: string | undefined }) {
  return (
    <PageSkeleton
      title="Account"
      lead={email === undefined ? <Skeleton width={220} height={24} /> : <Who>{email}</Who>}
      sections={[0, 1, 4]}
    />
  )
}

const title = (plan: string) => `${plan[0]?.toUpperCase() ?? ''}${plan.slice(1)}`

/** Money, as people write it: "$4.20". */
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

/**
 * This month's play, and what happens when it runs out. Nobody should ever be surprised on the
 * 1st, so the warning arrives long before the money does, and what Blockly may charge past the
 * included block is the owner's own number — zero until they say otherwise.
 */
function Play({ overview }: { overview: AccountOverviewView }) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const { usage: u, entitlements: e } = overview
  const again = () => void queries.invalidateQueries({ queryKey: trpc.account.overview.queryKey() })
  // Each choice saves as it is made, and its line says so for a moment.
  const kicked = useOutcome(undefined)
  const afk = useMutation(
    trpc.account.setAfkKick.mutationOptions({
      onSuccess: () => {
        again()
        kicked.settled()
        setNeverAsked(false)
      },
    }),
  )
  // Never kicking is the costliest choice, so it is asked about, never a default.
  const [neverAsked, setNeverAsked] = useState(false)
  const kicksAfter = overview.settings.afkKickMinutes ?? e.playerIdleKickMinutes
  if (e.includedUnits === null) return null
  const included = e.includedUnits
  const used = Math.min(1, u.unitsThisMonth / included)
  const share = Math.round(used * 100)
  const left = Math.max(0, included - u.unitsThisMonth)
  // An hour on a large server counts two; said only to someone whose month shows it.
  const doubled = u.unitsThisMonth > u.hoursThisMonth

  return (
    <FormSection
      title="Play this month"
      description={`${u.unitsThisMonth} of ${included} hours played. It resets on the 1st.`}
    >
      <ProgressBar onPaper value={share} label={`${share}% of this month's play`} />
      {share >= 100 ? (
        <UsedUp overview={overview} included={included} />
      ) : share >= 80 ? (
        <Note tone="info">
          {left} hours left this month.
          {u.extra.may ? ' Nothing more is charged unless you allow it below.' : ''}
        </Note>
      ) : share >= 50 ? (
        <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
          Halfway through this month's play. Nothing to do; this is so the end of the month is never a
          surprise.
        </p>
      ) : null}
      {doubled && (
        <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
          {u.hoursThisMonth} hours on the clock: a large server counts two for each hour it runs.
        </p>
      )}
      {e.mayBuyMore && <ExtraPlay overview={overview} />}
      {e.mayChooseAfkKick && (
        <FormRow
          label="Kick players who stand still"
          description={`${kicked.said === 'done' ? 'Saved. ' : ''}${
            kicksAfter === 0
              ? 'Off: somebody idle keeps your server awake and spends your play time until they leave.'
              : 'Somebody idle in a loaded world still spends your play time. Cubepals kicks them; they can join again straight away.'
          }`}
          control={
            <select
              className="bk-input bk-num"
              style={{ inlineSize: 'auto' }}
              value={kicksAfter}
              disabled={afk.isPending}
              onChange={(event) => {
                const minutes = Number(event.target.value)
                if (minutes === 0) setNeverAsked(true)
                else afk.mutate({ minutes })
              }}
            >
              {[10, 15, 30, 60].map((minutes) => (
                <option key={minutes} value={minutes}>
                  After {minutes} minutes
                </option>
              ))}
              <option value={0}>Never</option>
            </select>
          }
        />
      )}
      <Modal
        open={neverAsked}
        onClose={() => setNeverAsked(false)}
        title="Never kick players who stand still?"
        actions={
          <>
            <Button variant="ghost" onClick={() => setNeverAsked(false)}>
              Keep kicking them
            </Button>
            <Button variant="primary" disabled={afk.isPending} onClick={() => afk.mutate({ minutes: 0 })}>
              {afk.isPending ? 'Saving…' : 'Never kick'}
            </Button>
          </>
        }
      >
        <p>
          Somebody idle keeps your server awake, so it keeps using your play time for as long as they stay,
          even when nobody is playing. It is the most expensive way to run a server.
        </p>
      </Modal>
      {afk.isError && <Note tone="danger">{messageOf(afk.error)}</Note>}
    </FormSection>
  )
}

/** Extra play as the page says it: the limit that counts now, and what extra hours came to. */
const extraOf = (u: AccountOverviewView['usage']) => ({
  /** What the owner allowed, as far as it counts now: none while extra play is off. */
  allowedNow: u.extra.may ? Math.min(u.extraUnitsAllowed, u.extra.ceiling) : 0,
  billed: money(Math.round(u.extra.countedUnits * u.unitCents)),
  /** Hours as the emails say them: to a tenth, never the thousandths they are counted in. */
  hours: Math.round(u.extra.countedUnits * 10) / 10,
})

/** The month's included play is used: on extra hours now, or asleep until the 1st, and why. */
function UsedUp({ overview, included }: { overview: AccountOverviewView; included: number }) {
  const x = overview.usage.extra
  const { allowedNow, billed, hours } = extraOf(overview.usage)
  // An upgrade only: with an admin's own hours on the account, a cheaper plan can have more.
  const more = overview.plans.find(
    (p) =>
      (p.entitlements.includedUnits ?? 0) > included &&
      p.entitlements.monthlyPriceCents > overview.entitlements.monthlyPriceCents,
  )
  if (allowedNow > 0)
    return (
      <Note tone="info">
        {`You're on extra hours: ${hours} so far this month, ${billed}, billed with your Plus payments. Servers sleep once you reach the ${allowedNow} you allowed.`}
      </Note>
    )
  return (
    <>
      <Note tone="info">
        {`You've played this month's ${included} hours. Your servers sleep until the 1st${x.may ? ', unless you allow some extra play below' : ''}.`}
        {x.countedUnits > 0
          ? ` Your ${hours} extra hours this month, ${billed}, are billed with your Plus payments.`
          : ''}
      </Note>
      {more && (
        <PlusOffer
          why={`${title(more.key)} has ${more.entitlements.includedUnits} hours a month.`}
          plan={more.key}
          reason="hours"
          next="/account"
        />
      )}
    </>
  )
}

/**
 * The owner's own limit on extra play, from the choices under their ceiling, saved as it is
 * picked; or, while extra play is off for them, the one sentence that says why.
 */
function ExtraPlay({ overview }: { overview: AccountOverviewView }) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const allowed = useOutcome(undefined)
  const allow = useMutation(
    trpc.account.allowExtraPlay.mutationOptions({
      onSuccess: () => {
        void queries.invalidateQueries({ queryKey: trpc.account.overview.queryKey() })
        allowed.settled()
      },
    }),
  )
  const u = overview.usage
  const x = u.extra
  if (!x.may)
    return x.why === null ? null : (
      <FormRow label="Extra play" description={x.why} control={<span className="type-body">Off</span>} />
    )
  const later =
    x.nextCeiling === null
      ? ''
      : ` Up to ${x.ceiling} hours a month until your first renewal is paid, then up to ${x.nextCeiling}.`
  return (
    <>
      <FormRow
        label="Extra play you allow"
        description={`${allowed.said === 'done' ? 'Saved. ' : ''}Past what your plan includes, ${money(u.unitCents)} an hour, added to your next Plus payment. Cubepals stops your servers at this number, so nothing costs more than you said.${later}`}
        control={
          <div className="bk-row" style={{ gap: 'var(--space-8)', alignItems: 'center' }}>
            <select
              className="bk-input bk-num"
              style={{ inlineSize: 'auto' }}
              value={extraOf(u).allowedNow}
              disabled={allow.isPending}
              onChange={(event) => allow.mutate({ units: Number(event.target.value) })}
            >
              {x.choices.map((units) => (
                <option key={units} value={units}>
                  {units === 0 ? 'None' : `${units} hours · up to ${money(units * u.unitCents)}`}
                </option>
              ))}
            </select>
          </div>
        }
      />
      {allow.isError && <Note tone="danger">{messageOf(allow.error)}</Note>}
    </>
  )
}

/**
 * Money owed from a payment that didn't go through: what it blocks, and how it is paid. One the
 * provider can no longer collect is paid here at once; one it still tries is paid by fixing the
 * card in Manage billing.
 */
function Owed({ extra }: { extra: AccountOverviewView['usage']['extra'] }) {
  const trpc = useTRPC()
  const settle = useMutation(
    trpc.billing.settle.mutationOptions({ onSuccess: ({ url }) => window.location.assign(url) }),
  )
  if (extra.owedCents === 0) return null
  return (
    <>
      <Note tone="danger">
        {`You owe ${money(extra.owedCents)} from a payment that didn’t go through. Your servers can’t start until it’s paid${extra.settleCents > 0 ? '' : ' in Manage billing'}. Your worlds are safe, and you can still download them.`}
      </Note>
      {extra.settleCents > 0 && (
        <div className="bk-row">
          <Button variant="primary" disabled={settle.isPending} onClick={() => settle.mutate()}>
            {`Pay ${money(extra.settleCents)}`}
          </Button>
        </div>
      )}
      {settle.isError && <Note tone="danger">{messageOf(settle.error)}</Note>}
    </>
  )
}

function Plan({ overview }: { overview: AccountOverviewView }) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const router = useRouter()
  const params = useSearchParams()
  const billing = overview.features.find((f) => f.feature === 'billing')
  const portal = useMutation(
    trpc.billing.portal.mutationOptions({ onSuccess: ({ url }) => window.location.assign(url) }),
  )
  const refresh = useMutation(
    trpc.billing.refresh.mutationOptions({
      onSettled: () => queries.invalidateQueries({ queryKey: trpc.account.pathKey() }),
    }),
  )
  // Back from the provider's pages: read its word now rather than wait for its webhook, then go
  // on to where the person was when they chose to pay. A refusal stays here, where it is shown.
  const asked = useRef(false)
  useEffect(() => {
    if (asked.current || params.get('from') !== 'billing' || !billing?.available) return
    asked.current = true
    const next = params.get('next')
    router.replace('/account')
    refresh.mutate(undefined, {
      onSuccess: () => {
        if (next !== null && /^\/(?![/\\])/.test(next)) router.replace(next)
      },
    })
  }, [params, billing, refresh, router])

  // Chose a plan before they had an account, or from a page without one to show: carry on to
  // the checkout page for it, once, rather than ask them to choose again here.
  const continued = useRef(false)
  useEffect(() => {
    const plan = params.get('get')
    if (continued.current || plan === null || !billing?.available || plan === overview.plan.key) return
    continued.current = true
    const said = params.get('reason')
    const reason = UPGRADE_REASONS.find((known): known is UpgradeReason => known === said) ?? 'account'
    router.replace(checkoutHref({ plan, reason, next: '/servers' }))
  }, [params, billing, router, overview.plan.key])

  const billed = overview.plan.billed
  const paying = billed !== null && billed.status !== 'ended' && billed.planKey === overview.plan.key
  const failure = portal.error ?? refresh.error
  return (
    <FormSection
      title={`${title(overview.plan.key)} plan`}
      description={
        paying && billed.pastDueUntil
          ? `Your last payment didn’t go through. Update your card in Manage billing by ${dayOf(billed.pastDueUntil)} to keep ${title(overview.plan.key)}.`
          : paying && billed.periodEnd
            ? billed.cancelAtPeriodEnd
              ? `Ends on ${dayOf(billed.periodEnd)}; then you're on Free.`
              : `Renews on ${dayOf(billed.periodEnd)}.`
            : overview.plan.key !== 'free'
              ? 'Given to this account by Cubepals.'
              : 'Free, for as long as you like. No card.'
      }
      actions={
        billing?.available && billed !== null ? (
          <Button variant="outline" disabled={portal.isPending} onClick={() => portal.mutate()}>
            Manage billing
          </Button>
        ) : undefined
      }
    >
      {billing && !billing.available && billing.code === 'deployment_unsupported' && (
        <p className="type-body" style={{ color: 'var(--ink-muted)' }}>
          Plans on this Cubepals are set by whoever runs it.
        </p>
      )}
      {billing && !billing.available && billing.code !== 'deployment_unsupported' && (
        <Note tone="info">{billing.message}</Note>
      )}
      <Owed extra={overview.usage.extra} />
      {refresh.isPending && <p className="type-body-sm">Checking your payment…</p>}
      {failure && <Note tone="danger">{messageOf(failure)}</Note>}
    </FormSection>
  )
}

const minutes = (n: number | null) => (n === null ? 'Never' : `After ${n} minutes empty`)
const afkKick = (n: number) => (n === 0 ? 'Never' : `After ${n} minutes idle`)
/** A stretch of time as people say it: "4 hours", "90 minutes". */
const stretch = (n: number) => (n % 60 === 0 ? `${n / 60} hours` : `${n} minutes`)
const days = (n: number) =>
  n % 30 === 0 ? `${n / 30} month${n === 30 ? '' : 's'}` : n % 7 === 0 ? `${n / 7} weeks` : `${n} days`

/**
 * The plan in the few things people choose on, and everything else behind "Plan details" for
 * whoever wants it: nothing here is a limit to learn before playing.
 */
function Includes({ overview }: { overview: AccountOverviewView }) {
  const trpc = useTRPC()
  const plans = useQuery(trpc.billing.plans.queryOptions())
  const e = overview.entitlements
  const u = overview.usage
  const mine = plans.data?.find((p) => p.key === overview.plan.key)
  const row = (label: string, value: string, note?: ReactNode) => (
    <FormRow
      key={label}
      label={label}
      description={note}
      control={<span className="type-body bk-num">{value}</span>}
    />
  )
  const uploads = overview.features.find((f) => f.feature === 'upload_mod')
  return (
    <FormSection title="Your plan" description="What it includes, and how much of it you use now.">
      {row('Servers', `${u.servers} of ${e.maxServers}`)}
      {mine && row('Players', `Up to ${e.settingCaps?.maxPlayers ?? mine.maxPlayers}`)}
      {row('Mods', e.mayUseMods ? 'Mods, plugins and modpacks' : 'Minecraft as it comes')}
      {row(
        'Backups',
        e.backupPolicy.archiveEnabled ? 'Daily, and a weekly download' : 'Daily, and a download once a day',
      )}
      <details>
        <summary className="type-body-sm bk-disclosure">Plan details</summary>
        <div className="bk-stack" style={{ gap: 0, marginBlockStart: 'var(--space-12)' }}>
          {row('Running at once', `${u.running} of ${e.maxRunning}`)}
          {row('Server sizes', e.sizeLabels.join(', '))}
          {row('Server types', e.allowedLoaders.map(loaderLabel).join(', '))}
          {row('Sleeps when nobody plays', minutes(e.idleShutdownAfterMinutes))}
          {row(
            'Kicks players who go idle',
            afkKick(overview.settings.afkKickMinutes ?? e.playerIdleKickMinutes),
            <Tip tip="Servers wake up on their own when someone joins, so a sleeping one is nothing to worry about. Sleeping while nobody plays is what keeps your hours for playing.">
              So a server nobody is playing on can sleep.
            </Tip>,
          )}
          {e.maxSessionMinutes !== null &&
            row('Runs for', stretch(e.maxSessionMinutes), 'Start it again whenever you want.')}
          {e.settingCaps !== null &&
            row(
              'View and simulation distance',
              `${e.settingCaps.viewDistance} and ${e.settingCaps.simulationDistance} chunks`,
            )}
          {row('Backups kept', `${e.backupPolicy.snapshotsKept}`)}
          {e.backupPolicy.archiveEnabled &&
            row('Weekly downloads kept', `${e.backupPolicy.archiveRetentionDays} days`)}
          {row(
            'Your own mods',
            uploads?.available ? 'Yes' : 'No',
            uploads?.available ? undefined : uploads?.message,
          )}
          {row(
            'A world nobody plays',
            `Rests after ${days(e.storeAfterIdleDays)}`,
            'Joining wakes it; it takes a couple of minutes.',
          )}
          {row(
            'Kept',
            e.deleteAfterIdleDays === null
              ? 'For as long as you have this plan'
              : `A year after it was last played`,
            e.deleteAfterIdleDays === null
              ? undefined
              : 'You’re emailed twice before, with a way to keep it.',
          )}
          {row('Deleted servers kept', `${e.trashRetentionDays} days`)}
        </div>
      </details>
    </FormSection>
  )
}

/** The plans side by side, as the pricing page shows them, with the way to change plan. */
function Plans({ overview }: { overview: AccountOverviewView }) {
  const trpc = useTRPC()
  const plans = useQuery(trpc.billing.plans.queryOptions())
  const sells = overview.features.find((f) => f.feature === 'billing')?.available === true
  if (plans.data === undefined || plans.data.length < 2) return null
  return (
    <FormSection title="Plans">
      <div className="bk-plans">
        {plans.data.map((plan) => (
          <PlanCard
            key={plan.key}
            plan={plan}
            current={plan.key === overview.plan.key}
            action={
              sells && plan.monthlyPriceCents > 0 && plan.key !== overview.plan.key ? (
                <Button variant="primary" href={checkoutHref({ plan: plan.key, reason: 'account' })}>
                  Get {plan.name}
                </Button>
              ) : undefined
            }
          />
        ))}
      </div>
    </FormSection>
  )
}
