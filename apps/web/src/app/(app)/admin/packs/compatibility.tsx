// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Templates against the newest release Cubepals offers: which keep up, which a tested version
 * carries, and which lag behind and why. Under them, every version Cubepals tested past what its
 * catalog lists, with when. Admins only; players never see any of it.
 *
 * It only reads. Records are added by reviewing them in the code (app/curation/tested.ts), and
 * moving a world forward stays its owner's decision.
 */
'use client'

import type { TemplateCompatibilityAdminView, TestedVersionAdminView } from '@blockly/contracts'
import { useQuery } from '@tanstack/react-query'
import { messageOf, useTRPC } from '../../../../lib/api'
import { Badge, FormRow, FormSection, Note, Skeleton } from '../../../../ui'

export function Compatibility() {
  const trpc = useTRPC()
  const view = useQuery(trpc.admin.compatibility.queryOptions())
  if (view.isError) return <Note tone="danger">{messageOf(view.error)}</Note>
  if (view.isPending) return <Skeleton width="100%" height={120} />
  return (
    <>
      <FormSection
        title="Templates"
        description="Each template with plugins, against the newest Minecraft Cubepals offers for its server type."
      >
        {view.data.templates.map((template) => (
          <TemplateRow key={template.key} template={template} />
        ))}
      </FormSection>
      <FormSection
        title="Tested by Cubepals"
        description="Versions that ran on a Minecraft their catalog doesn't list. Each covers that exact version only; added by reviewing them in the code (app/curation/tested.ts)."
      >
        {view.data.tested.length === 0 ? (
          <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
            None yet.
          </p>
        ) : (
          view.data.tested.map((record) => (
            <TestedRow key={`${record.name}@${record.versionLabel}:${record.gameVersion}`} record={record} />
          ))
        )}
      </FormSection>
    </>
  )
}

const STATUS: Record<
  TemplateCompatibilityAdminView['status'],
  { label: string; tone: 'grass' | 'info' | 'danger' }
> = {
  current: { label: 'Up to date', tone: 'grass' },
  covered: { label: 'Tested by Cubepals', tone: 'info' },
  lagging: { label: 'Lagging', tone: 'danger' },
}

function TemplateRow({ template }: { template: TemplateCompatibilityAdminView }) {
  const status = STATUS[template.status]
  return (
    <>
      <FormRow
        label={
          <span className="bk-row" style={{ gap: 'var(--space-8)' }}>
            {template.title} <Badge tone={status.tone}>{status.label}</Badge>
          </span>
        }
        description={`${template.loaderLabel} ${template.newest}${template.tested
          .map((record) => ` · ${record.name} ${record.versionLabel} tested on ${record.testedOn}`)
          .join('')}`}
        control={null}
      />
      {template.behind.length > 0 && (
        <Note tone="info">
          Held back by{' '}
          {template.behind
            .map(
              (plugin) =>
                `${plugin.name} (lists ${plugin.newestListed === null ? 'no release' : `up to ${plugin.newestListed}`})`,
            )
            .join(', ')}
          . Test it on {template.loaderLabel} {template.newest}, then add a record.
        </Note>
      )}
    </>
  )
}

function TestedRow({ record }: { record: TestedVersionAdminView }) {
  return (
    <FormRow
      label={`${record.name} ${record.versionLabel} on ${record.loaderLabel} ${record.gameVersion}`}
      description={`Tested on ${record.testedOn} by ${record.testedBy}, on ${record.build}. ${record.evidence}`}
      control={null}
    />
  )
}
