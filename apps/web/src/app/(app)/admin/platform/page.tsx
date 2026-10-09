'use client'

import type { PlatformControlsView } from '@blockly/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type SubmitEvent, useState } from 'react'
import { isNotFound, messageOf, useTRPC } from '../../../../lib/api'
import { useNow } from '../../../../lib/hooks'
import { said, useOutcome } from '../../../../lib/outcome'
import { whenTaken } from '../../../../lib/present'
import * as rules from '../../../../lib/rules'
import {
  Badge,
  Button,
  EmptyState,
  FormRow,
  FormSection,
  Modal,
  Note,
  Skeleton,
  TextField,
  Toggle,
} from '../../../../ui'
import { AdminTabs } from '../tabs'

type Controls = Omit<
  PlatformControlsView,
  | 'updatedBy'
  | 'updatedByEmail'
  | 'updatedAt'
  | 'usage'
  | 'signups'
  | 'spend'
  | 'catalogHeardAt'
  | 'playDomains'
  | 'serverCeiling'
  | 'runtimeKeys'
>
type Switch =
  | 'provisioningEnabled'
  | 'startsEnabled'
  | 'publicListingEnabled'
  | 'uploadsEnabled'
  | 'storingEnabled'
  | 'expiringEnabled'

/** Each kill switch, and what turning it off does to everyone at once. */
const SWITCHES: Array<{ key: Switch; label: string; off: string }> = [
  {
    key: 'provisioningEnabled',
    label: 'Creating servers',
    off: 'Nobody can create a server. Servers that exist keep running.',
  },
  {
    key: 'startsEnabled',
    label: 'Starting servers',
    off: 'Stopped servers stay stopped, whether started from the page, by a player joining, or by a restore. Running servers keep running.',
  },
  {
    key: 'publicListingEnabled',
    label: 'Public directory',
    off: 'The directory shows nothing and nobody can publish. Every listing is kept and comes back when it is on.',
  },
  {
    key: 'uploadsEnabled',
    label: 'Uploading mods',
    off: 'Nobody can upload a mod. Mods uploaded before keep working.',
  },
  {
    key: 'storingEnabled',
    label: 'Resting idle worlds',
    off: 'Worlds nobody plays keep their machine and disk. Resting worlds stay resting, and still wake when someone joins.',
  },
  {
    key: 'expiringEnabled',
    label: 'Deleting worlds unplayed for a year',
    off: 'No world is deleted for going unplayed, and nobody is warned. Free worlds are kept until this is on.',
  },
]

const controlsOf = (view: PlatformControlsView): Controls => ({
  provisioningEnabled: view.provisioningEnabled,
  startsEnabled: view.startsEnabled,
  publicListingEnabled: view.publicListingEnabled,
  uploadsEnabled: view.uploadsEnabled,
  storingEnabled: view.storingEnabled,
  expiringEnabled: view.expiringEnabled,
  maxServers: view.maxServers,
  maxRunningServers: view.maxRunningServers,
  maxFreeAccounts: view.maxFreeAccounts,
  dailySpendLimitCents: view.dailySpendLimitCents,
})

/** The platform's kill switches and caps, and the mod catalog's freshness. */
export default function PlatformPage() {
  const trpc = useTRPC()
  const platform = useQuery(trpc.admin.platform.queryOptions())
  if (platform.isError && isNotFound(platform.error))
    return <EmptyState title="Nothing here" description="This page is for Cubepals' admins." />
  return (
    <>
      <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
        Admin
      </h1>
      <AdminTabs />
      {platform.isError && <Note tone="danger">{messageOf(platform.error)}</Note>}
      {platform.data ? (
        <Platform view={platform.data} />
      ) : (
        platform.isPending && <Skeleton width="100%" height={240} />
      )}
    </>
  )
}

function Platform({ view }: { view: PlatformControlsView }) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const now = useNow(60_000)
  const refresh = () => queries.invalidateQueries({ queryKey: trpc.admin.pathKey() })
  const save = useMutation(trpc.admin.setPlatform.mutationOptions({ onSuccess: refresh }))
  const [pausing, setPausing] = useState<(typeof SWITCHES)[number] | null>(null)
  const controls = controlsOf(view)
  const flip = (key: Switch, on: boolean) => {
    const entry = SWITCHES.find((s) => s.key === key)
    // Turning something back on is always safe; pausing it for everyone asks first.
    if (!on && entry) setPausing(entry)
    else save.mutate({ ...controls, [key]: on })
  }

  return (
    <>
      <FormSection
        title="Kill switches"
        description={
          view.updatedBy
            ? `Last changed by ${view.updatedByEmail ?? view.updatedBy}, ${whenTaken(view.updatedAt, now).toLowerCase()}. Changes apply to the next request.`
            : 'Changes apply to the next request.'
        }
      >
        {save.isError && <Note tone="danger">{messageOf(save.error)}</Note>}
        {SWITCHES.map((entry) => (
          <FormRow
            key={entry.key}
            label={entry.label}
            description={controls[entry.key] ? 'On.' : `Paused. ${entry.off}`}
            control={
              <Toggle
                ariaLabel={entry.label}
                checked={controls[entry.key]}
                disabled={save.isPending}
                onChange={(on) => flip(entry.key, on)}
              />
            }
          />
        ))}
      </FormSection>

      <Spend view={view} />
      <Caps view={view} />
      <Catalog view={view} />
      <PlayDomains view={view} />
      <RuntimeKeys view={view} />

      <Modal
        open={pausing !== null}
        onClose={() => setPausing(null)}
        title={`Pause ${pausing?.label.toLowerCase() ?? ''} for everyone?`}
        actions={
          <>
            <Button variant="ghost" onClick={() => setPausing(null)}>
              Keep it on
            </Button>
            <Button
              variant="danger"
              disabled={save.isPending}
              onClick={() => {
                if (pausing)
                  save.mutate({ ...controls, [pausing.key]: false }, { onSettled: () => setPausing(null) })
              }}
            >
              Pause it
            </Button>
          </>
        }
      >
        <p className="type-body">{pausing?.off}</p>
      </Modal>
    </>
  )
}

function Caps({ view }: { view: PlatformControlsView }) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const [servers, setServers] = useState(String(view.maxServers))
  const [running, setRunning] = useState(String(view.maxRunningServers))
  const [accounts, setAccounts] = useState(String(view.maxFreeAccounts))
  const [dollars, setDollars] = useState(String(Math.round(view.dailySpendLimitCents / 100)))
  const saved = useOutcome(undefined)
  const save = useMutation(
    trpc.admin.setPlatform.mutationOptions({
      onSuccess: () => {
        saved.settled()
        return queries.invalidateQueries({ queryKey: trpc.admin.pathKey() })
      },
      onError: () => saved.refused(),
    }),
  )
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    save.mutate({
      ...controlsOf(view),
      maxServers: Number.parseInt(servers, 10),
      maxRunningServers: Number.parseInt(running, 10),
      maxFreeAccounts: Number.parseInt(accounts, 10),
      dailySpendLimitCents: Number.parseInt(dollars, 10) * 100,
    })
  }
  /** Blank passes the rule — nothing is wrong yet — but a cap has to be some number. */
  const set = (value: string) => value.trim() !== '' && rules.wholeNumber(value) === null
  return (
    <FormSection
      title="Caps"
      description={`Cubepals' own limits, above every plan: ${view.usage.servers} ${view.usage.servers === 1 ? 'server' : 'servers'} now, ${view.usage.running} running.`}
    >
      <form onSubmit={submit} className="bk-stack" style={{ gap: 'var(--space-12)' }}>
        <div className="bk-grid" style={{ gap: 'var(--space-16)' }}>
          <TextField
            label="Servers in all"
            inputMode="numeric"
            value={servers}
            error={rules.wholeNumber(servers)}
            help={
              view.serverCeiling === null
                ? 'Creating one past this says Cubepals is full.'
                : `Creating one past this says Cubepals is full. The hosting provider's own limit allows at most ${view.serverCeiling}.`
            }
            onChange={(event) => setServers(event.target.value)}
          />
          <TextField
            label="Running at once"
            inputMode="numeric"
            value={running}
            error={rules.wholeNumber(running)}
            help="Starting one past this says Cubepals is busy."
            onChange={(event) => setRunning(event.target.value)}
          />
          <TextField
            label="Free accounts"
            inputMode="numeric"
            value={accounts}
            error={rules.wholeNumber(accounts)}
            help={`Signing up past this says Cubepals is full, and offers the waitlist. ${view.signups.freeAccounts} now, ${view.signups.waitlist} waiting.`}
            onChange={(event) => setAccounts(event.target.value)}
          />
          <TextField
            label="Daily spend limit, in dollars"
            inputMode="numeric"
            value={dollars}
            error={rules.wholeNumber(dollars)}
            help="Once a day costs more, starting and creating servers turn off, and admins get an email."
            onChange={(event) => setDollars(event.target.value)}
          />
        </div>
        <div className="bk-row" style={{ gap: 'var(--space-8)' }}>
          <Button
            type="submit"
            variant="outline"
            size="sm"
            {...said(saved)}
            disabled={save.isPending || ![servers, running, accounts, dollars].every(set)}
          >
            Save caps
          </Button>
          {save.isError && <span className="type-body-sm">{messageOf(save.error)}</span>}
        </div>
      </form>
    </FormSection>
  )
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

/**
 * What today has cost so far, as the spend watchdog worked it out from recorded play, and whether
 * it paused anything (docs/money-guards.md). Fly's own bill is the truth; this is the early warning.
 */
function Spend({ view }: { view: PlatformControlsView }) {
  const now = useNow(60_000)
  const { spend, dailySpendLimitCents: limit } = view
  if (spend === null)
    return (
      <FormSection
        title="Spend today"
        description="The watchdog hasn't worked out a day yet. It runs every ten minutes."
      >
        {null}
      </FormSection>
    )
  const stale = spend.day !== new Date(now).toISOString().slice(0, 10)
  return (
    <FormSection
      title="Spend today"
      description={`${spend.day}, UTC, as of ${whenTaken(spend.computedAt, now).toLowerCase()}. Worked out from recorded play at the provider's list prices; its own bill is the truth.`}
    >
      {stale && <Note tone="danger">The watchdog hasn't run today. Check that the worker is up.</Note>}
      {spend.trippedAt !== null && (
        <Note tone="danger">
          Past the limit {whenTaken(spend.trippedAt, now).toLowerCase()}: starting and creating servers were
          turned off. Turn them back on above once you've checked Fly's bill.
        </Note>
      )}
      <FormRow
        label={`${money(spend.cents)} of ${money(limit)}`}
        description={`Compute ${money(spend.computeCents)}, disks ${money(spend.storageCents)}, ${spend.runningServers} running now.`}
        control={
          <Badge tone={spend.cents > limit ? 'danger' : spend.cents > limit * 0.8 ? 'info' : 'grass'}>
            {spend.cents > limit ? 'Over' : `${Math.round((spend.cents / Math.max(limit, 1)) * 100)}%`}
          </Badge>
        }
      />
      <FormRow
        label="Machines nobody accounts for"
        description={
          spend.strayMachines === 0
            ? 'None: every machine Fly runs belongs to a running server.'
            : `${spend.strayMachines} running at Fly with no running server behind ${spend.strayMachines === 1 ? 'it' : 'them'}, ${money(spend.strayCents)} today. The orphan sweep stops them.`
        }
        control={<Badge tone={spend.strayMachines === 0 ? 'grass' : 'danger'}>{spend.strayMachines}</Badge>}
      />
    </FormSection>
  )
}

/**
 * The play domains and who joins through each. An alias kept after a domain move can be removed
 * from PLAY_DOMAIN_ALIASES once nobody joins through it (§11).
 */
function PlayDomains({ view }: { view: PlatformControlsView }) {
  const now = useNow(60_000)
  return (
    <FormSection
      title="Play addresses"
      description="Where players join. An old domain kept as an alias can go once nobody joins through it."
    >
      {view.playDomains.map((d) => {
        // An alias nobody joined through for a month has done its job.
        const quiet = d.lastJoinAt === null || now - Date.parse(d.lastJoinAt) > 30 * 86_400_000
        return (
          <FormRow
            key={d.domain}
            label={d.alias ? `${d.domain} (alias)` : d.domain}
            description={
              d.lastJoinAt === null
                ? 'Nobody has joined through it yet.'
                : `${d.joins} ${d.joins === 1 ? 'join' : 'joins'}, the last ${whenTaken(d.lastJoinAt, now).toLowerCase()}.`
            }
            control={
              d.alias ? (
                <Badge tone={quiet ? 'grass' : 'info'}>{quiet ? 'Quiet: can go' : 'In use'}</Badge>
              ) : (
                <Badge tone="outline">Primary</Badge>
              )
            }
          />
        )
      })}
    </FormSection>
  )
}

/** Where a rotation of the runtime key stands, so the old key goes only once nothing needs it. */
function RuntimeKeys({ view }: { view: PlatformControlsView }) {
  const { version, previousVersions, behind } = view.runtimeKeys
  const rotating = previousVersions.length > 0
  const earlier = previousVersions.map((v) => `version ${v}`).join(', ')
  return (
    <FormSection
      title="Runtime key"
      description="Derives every server's console password and mod download links. Rotating it moves each server onto the new key at its next update."
    >
      <FormRow
        label={`Version ${version}`}
        description={
          !rotating
            ? behind === 0
              ? 'Every server runs on it.'
              : `${behind} ${behind === 1 ? 'server runs' : 'servers run'} on an earlier key no longer accepted: restart ${behind === 1 ? 'it' : 'them'}.`
            : behind === 0
              ? `Nothing runs on ${earlier} any more: it can be removed.`
              : `${behind} running ${behind === 1 ? 'server still uses' : 'servers still use'} an earlier key. Keep ${earlier} until this is 0; idle servers move over within minutes.`
        }
        control={
          <Badge tone={rotating ? (behind === 0 ? 'grass' : 'info') : 'outline'}>
            {rotating ? (behind === 0 ? 'Rotated' : 'Rotating') : 'Current'}
          </Badge>
        }
      />
    </FormSection>
  )
}

function Catalog({ view }: { view: PlatformControlsView }) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const now = useNow(60_000)
  const refreshed = useOutcome(undefined)
  const refresh = useMutation(
    trpc.admin.refreshCatalog.mutationOptions({
      onSuccess: () => {
        refreshed.settled()
        return queries.invalidateQueries({ queryKey: trpc.admin.pathKey() })
      },
      onError: () => refreshed.refused(),
    }),
  )
  return (
    <FormSection
      title="Mod catalog"
      description={
        view.catalogHeardAt
          ? `Modrinth last answered a refresh ${whenTaken(view.catalogHeardAt, now).toLowerCase()}. Cubepals asks every hour; trust uses what it last heard.`
          : 'Nothing is tracked yet: no server pins a mod from Modrinth.'
      }
      actions={
        <Button
          variant="outline"
          size="sm"
          {...said(refreshed, { done: 'Refreshed', failed: 'Didn’t refresh' })}
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          {refresh.isPending ? 'Asking Modrinth…' : 'Refresh now'}
        </Button>
      }
    >
      {refresh.isError && <Note tone="danger">{messageOf(refresh.error)}</Note>}
      {refresh.isSuccess && (
        <Note tone="success">
          {refresh.data.changed === 0
            ? 'Refreshed. Nothing changed.'
            : `Refreshed. ${refresh.data.changed} ${refresh.data.changed === 1 ? 'state changed' : 'states changed'}, and listings that pin them are being checked again.`}
        </Note>
      )}
    </FormSection>
  )
}
