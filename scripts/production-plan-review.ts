// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What one saved production plan may change, read as `terraform show -json` gives it. Terraform
 * plans what its configuration says, and an older checkout's configuration says older things: a
 * nightly from before PLAY_IPV4 points the play names' wildcard back at the edge's anycast address
 * and gives the Fly apps PLAY_IPV4 as a secret. A plan is refused when it
 *
 * - points a play name's wildcard (modules/dns `play_v4`, `play_v6`) anywhere but where the
 *   settings say: PLAY_IPV4 when it is set, else the edge's own address; replaces one, which leaves
 *   its players without an address in between; or removes one whose domain is still listed;
 * - gives the Fly apps a setting the stack keeps for Terraform alone (`terraform_only` in
 *   stack/main.tf), or removes one the settings still give a value.
 *
 * The settings are the ones the plan was made with. The Fly secrets in a plan are write-only, so
 * no secret's value is read; what it says names records, secrets and public addresses only.
 *
 * Not for which commit may deploy: production-guard.ts decides that, and runs this.
 */

/** One resource's planned change, as Terraform's JSON plan format (1.x) gives it. */
export type ResourceChange = {
  address: string
  module_address?: string
  type: string
  name: string
  index?: unknown
  change: {
    actions: string[]
    before: Record<string, unknown> | null
    after: Record<string, unknown> | null
    after_unknown?: Record<string, unknown>
  }
}

type PlannedModule = {
  address?: string
  resources?: { address: string; type: string; name: string; values?: Record<string, unknown> }[]
  child_modules?: PlannedModule[]
}

export type Plan = {
  format_version: string
  variables?: Record<string, { value?: unknown }>
  planned_values?: { root_module?: PlannedModule }
  resource_changes?: ResourceChange[]
}

/** The settings stack/main.tf keeps for Terraform alone (`terraform_only`), from the stack's text. */
export function terraformOnly(stack: string): string[] {
  const list = /^\s*terraform_only\s*=\s*\[([^\]]*)\]/m.exec(stack)
  if (!list)
    throw new Error('stack/main.tf no longer says which settings are Terraform’s own (terraform_only).')
  return [...(list[1] ?? '').matchAll(/"([^"]+)"/g)].map((name) => name[1] as string)
}

/** Every resource a module plans, its children's included. */
function resourcesOf(module: PlannedModule | undefined): NonNullable<PlannedModule['resources']> {
  return [...(module?.resources ?? []), ...(module?.child_modules ?? []).flatMap(resourcesOf)]
}

/** The edge's own address of one family as the plan will leave it; null while it isn't known yet. */
function edgeAddress(plan: Plan, family: 'v4' | 'v6'): string | null {
  const ip = resourcesOf(plan.planned_values?.root_module).find(
    (r) => r.type === 'fly_ip' && r.address.endsWith(`module.edge.fly_ip.${family}`),
  )
  return typeof ip?.values?.address === 'string' ? ip.values.address : null
}

const changes = (actions: readonly string[]) => !actions.every((a) => a === 'no-op' || a === 'read')

/** What is wrong with one wildcard record's change; null when it goes where the settings say. */
function wildcardProblem(
  change: ResourceChange,
  domains: readonly string[],
  want: { address: string | null; from: string },
): string | null {
  const { actions, after, after_unknown } = change.change
  const domain = String(change.index)
  if (actions.includes('delete') && actions.includes('create'))
    return `${change.address}: replaced, which leaves ${domain}'s players without an address in between.`
  if (actions.includes('delete'))
    return domains.includes(domain)
      ? `${change.address}: removed, while ${domain} is still a play domain.`
      : null
  const content = typeof after?.content === 'string' ? after.content : null
  // The edge's address is made in this same plan: there is nothing yet to compare with.
  if (want.address === null) return null
  if (content === null || after_unknown?.content === true)
    return `${change.address}: would hold an address known only once applied, not ${want.address} (${want.from}).`
  return content === want.address
    ? null
    : `${change.address}: would send ${domain}'s players to ${content}, not ${want.address} (${want.from}).`
}

/** What is wrong with one Fly secret's change; null when nothing is. */
function secretProblem(
  change: ResourceChange,
  settings: Readonly<Record<string, string>>,
  ownOnly: readonly string[],
): string | null {
  const { actions, before, after } = change.change
  const name = String(after?.name ?? before?.name ?? '')
  const app = String(after?.app ?? before?.app ?? '')
  if ((actions.includes('create') || actions.includes('update')) && ownOnly.includes(name))
    return `${change.address}: gives ${app} ${name}, which is Terraform's alone (terraform_only in stack/main.tf).`
  if (
    change.name === 'setting' &&
    actions.length === 1 &&
    actions[0] === 'delete' &&
    !ownOnly.includes(name) &&
    (settings[name] ?? '') !== ''
  )
    return `${change.address}: removes ${name} from ${app}, while the settings give it a value.`
  return null
}

const isWildcard = (change: ResourceChange) =>
  change.type === 'cloudflare_dns_record' &&
  (change.name === 'play_v4' || change.name === 'play_v6') &&
  (change.module_address ?? '').endsWith('module.dns')

/** Where each wildcard should point: PLAY_IPV4 when it is set, else the edge's own address. */
function wanted(plan: Plan, settings: Readonly<Record<string, string>>) {
  return {
    play_v4: settings.PLAY_IPV4
      ? { address: settings.PLAY_IPV4, from: 'PLAY_IPV4' }
      : { address: edgeAddress(plan, 'v4'), from: "the edge's own IPv4" },
    play_v6: { address: edgeAddress(plan, 'v6'), from: "the edge's own IPv6" },
  }
}

/**
 * Everything wrong with a plan, one line each; empty when it may be applied. `ownOnly` is the
 * stack's `terraform_only`, read from main (production-guard.ts), not from the plan's checkout.
 */
export function planProblems(plan: Plan, ownOnly: readonly string[]): string[] {
  if (!/^1\./.test(plan.format_version ?? ''))
    return [`The plan is in Terraform's JSON format ${plan.format_version}; this review reads 1.x.`]
  const settings = (plan.variables?.settings?.value ?? {}) as Record<string, string>
  // As the stack lists them: PLAY_DOMAIN, then each of PLAY_DOMAIN_ALIASES.
  const domains = [settings.PLAY_DOMAIN ?? '', ...(settings.PLAY_DOMAIN_ALIASES ?? '').split(',')].filter(
    (domain) => domain !== '',
  )
  const want = wanted(plan, settings)
  const problemOf = (change: ResourceChange): string | null => {
    if (isWildcard(change)) return wildcardProblem(change, domains, want[change.name as keyof typeof want])
    return change.type === 'fly_secret' ? secretProblem(change, settings, ownOnly) : null
  }
  return (plan.resource_changes ?? [])
    .filter((change) => changes(change.change.actions))
    .map(problemOf)
    .filter((problem): problem is string => problem !== null)
}
