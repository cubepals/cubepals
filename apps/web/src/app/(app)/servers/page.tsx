'use client'

import { noop, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import Image from 'next/image'
import { useEffect } from 'react'
import { messageOf, useTRPC } from '../../../lib/api'
import { coverFor, presentStatus } from '../../../lib/present'
import { Button, EmptyState, ICON, ServerCard, Skeleton } from '../../../ui'
import { usePrefetch } from '../prefetch'
import styles from './first-world.module.css'

export default function ServersPage() {
  const trpc = useTRPC()
  const servers = useQuery(trpc.servers.list.queryOptions())
  const trash = useQuery(trpc.servers.trash.queryOptions())
  const trashed = trash.data?.length ?? 0
  const overview = useQuery(trpc.account.overview.queryOptions())
  const creating = overview.data?.features.find((f) => f.feature === 'create_server')
  // Creating a server is one click from here: its choices are fetched now, not after the click.
  const queries = useQueryClient()
  useEffect(() => {
    queries.query(trpc.servers.createOptions.queryOptions()).catch(noop)
  }, [queries, trpc])
  // Every server shown here is one press from its page: that page opens on what the list already
  // holds, and what else it waits on is asked for now.
  const prefetch = usePrefetch()
  useEffect(() => {
    for (const server of servers.data ?? []) prefetch.page(`/servers/${server.id}`)
  }, [servers.data, prefetch])

  return (
    <>
      <header className="bk-row bk-wrap" style={{ justifyContent: 'space-between', gap: 'var(--space-16)' }}>
        <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
          Your servers
        </h1>
        <div className="bk-row bk-wrap" style={{ gap: 'var(--space-8)' }}>
          {trashed > 0 && (
            <Button variant="ghost" href="/servers/trash" icon={<Trash2 {...ICON} aria-hidden />}>
              Trash ({trashed})
            </Button>
          )}
          {servers.data &&
            servers.data.length > 0 &&
            // Once the plan's servers are all made, the button stays, dimmed, and says why.
            (creating?.available === false ? (
              <span className="bk-row bk-wrap" style={{ gap: 'var(--space-12)', justifyContent: 'flex-end' }}>
                <span className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
                  {creating.message}
                </span>
                <Button variant="primary" disabled icon={<Plus {...ICON} aria-hidden />}>
                  Create a server
                </Button>
              </span>
            ) : (
              <Button variant="primary" href="/servers/new" icon={<Plus {...ICON} aria-hidden />}>
                Create a server
              </Button>
            ))}
        </div>
      </header>

      {servers.isPending ? (
        <div className="bk-grid bk-grid--three" aria-busy>
          {[0, 1].map((i) => (
            <div key={i} className="bk-server">
              <div className="bk-server__media" />
              <div className="bk-server__body">
                <Skeleton width="60%" height={18} />
                <Skeleton width="40%" />
                <Skeleton width="80%" />
              </div>
            </div>
          ))}
        </div>
      ) : servers.isError ? (
        <EmptyState
          danger
          title="We could not load your servers"
          description={messageOf(servers.error)}
          action={
            <Button variant="primary" onClick={() => servers.refetch()}>
              Try again
            </Button>
          }
        />
      ) : servers.data.length === 0 ? (
        <section className={styles.firstWorld} aria-labelledby="first-world">
          <div className={styles.words}>
            <h2 id="first-world" className={`type-display-lg ${styles.title}`}>
              <span>Let's make</span>{' '}
              <span>
                your <span className={styles.accent}>first world</span>
              </span>
            </h2>
            <p className={`type-body-lg ${styles.copy}`}>
              Vanilla, mods, or a modpack. Cubepals handles the setup.
            </p>
            <Button variant="primary" size="lg" href="/servers/new">
              Create a server
            </Button>
            <p className={`type-body-sm ${styles.note}`}>Your friends can join as soon as it’s up.</p>
          </div>
          <div className={styles.art}>
            <Image
              src="/imagery/chunk-awake.png"
              alt=""
              width={1660}
              height={1400}
              sizes="(max-width: 1023px) min(440px, 100vw), 620px"
            />
          </div>
        </section>
      ) : (
        <div className="bk-grid bk-grid--three">
          {servers.data.map((server) => {
            const status = presentStatus(server)
            return (
              <ServerCard
                key={server.id}
                href={`/servers/${server.id}`}
                name={server.name}
                status={status.pill}
                {...(status.label ? { statusLabel: status.label } : {})}
                image={coverFor(server.id)}
                version={server.gameVersion}
                loader={
                  server.loader === 'vanilla'
                    ? 'Vanilla'
                    : server.loader[0]?.toUpperCase() + server.loader.slice(1)
                }
                pack={server.modpack}
                detail={status.detail}
                address={server.joinAddress}
              />
            )
          })}
        </div>
      )}
    </>
  )
}
