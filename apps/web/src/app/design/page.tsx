'use client'

import { Palette, Play, RotateCw, Square, Swords } from 'lucide-react'
import Image from 'next/image'
import { notFound } from 'next/navigation'
import { useEffect, useState } from 'react'
import {
  Badge,
  Button,
  Card,
  Console,
  CopyField,
  DangerZone,
  EmptyState,
  FormRow,
  FormSection,
  ICON,
  Modal,
  Note,
  PlayerFace,
  PlayerRow,
  ProvisioningPanel,
  ServerCard,
  Skeleton,
  StatusPill,
  SuggestField,
  Tabs,
  TextField,
  Toggle,
} from '../../ui'

/**
 * Every component, in the states it can be in, for development only. The quickest way to see a
 * change to the design system across the product before any screen uses it.
 */
/** Names whose stand-in faces show the range. */
const FACE_NAMES = [
  'Steve',
  'Alex',
  'Griefer',
  'moss_walker',
  'Pixelpaw',
  'NoorBuilds',
  'kai_redstone',
  'Sunny',
  'ZuriMines',
  'efe',
  'Makena',
  'ari_ari',
]

export default function DesignGallery() {
  if (process.env.NODE_ENV === 'production') notFound()
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('light')
  const [toggle, setToggle] = useState(true)
  const [tab, setTab] = useState<'all' | 'chat'>('all')
  const [modal, setModal] = useState(false)
  const [progress, setProgress] = useState(35)
  const [mode, setMode] = useState<'survival' | 'creative'>('survival')
  const [party, setParty] = useState('4')
  const [player, setPlayer] = useState('')

  // Previews a theme here only; leaving the page puts back the one the layout chose.
  useEffect(() => {
    const root = document.documentElement
    const chosen = root.getAttribute('data-theme')
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
    return () => {
      if (chosen === null) root.removeAttribute('data-theme')
      else root.setAttribute('data-theme', chosen)
    }
  }, [theme])

  return (
    <div className="bk-page" style={{ paddingBlock: 'var(--space-48)' }}>
      <div
        className="bk-stack"
        style={{ gap: 'var(--space-48)', maxWidth: 'var(--width-content)', margin: '0 auto' }}
      >
        <header
          className="bk-row bk-wrap"
          style={{ justifyContent: 'space-between', gap: 'var(--space-16)' }}
        >
          <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
            Design system
          </h1>
          <Tabs
            label="Theme"
            value={theme}
            onChange={setTheme}
            items={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </header>

        <Section title="Buttons">
          <div className="bk-row bk-wrap" style={{ gap: 'var(--space-12)' }}>
            <Button variant="primary" icon={<Play {...ICON} aria-hidden />}>
              Start server
            </Button>
            <Button variant="secondary" icon={<Square {...ICON} aria-hidden />}>
              Stop server
            </Button>
            <Button variant="outline" icon={<RotateCw {...ICON} aria-hidden />}>
              Restart
            </Button>
            <Button variant="ghost">Cancel</Button>
            <Button variant="danger">Delete server</Button>
            <Button variant="primary" disabled>
              Disabled
            </Button>
            <Button variant="primary" size="sm">
              Join server
            </Button>
          </div>
          {/* A save from press to landing: waiting on the server, then how it went. */}
          <div className="bk-row bk-wrap" style={{ gap: 'var(--space-12)' }}>
            <Button variant="primary" disabled>
              Save changes
            </Button>
            <Button variant="primary" busy="Applying your changes">
              Save changes
            </Button>
            <Button variant="primary" done="Saved">
              Save changes
            </Button>
            <Button variant="primary" failed="Didn’t save">
              Save changes
            </Button>
            <Button variant="outline" size="sm" done="Added">
              Add
            </Button>
          </div>
        </Section>

        <Section title="Status">
          <div className="bk-row bk-wrap" style={{ gap: 'var(--space-12)' }}>
            <StatusPill status="online" />
            <StatusPill status="starting" />
            <StatusPill status="settingUp" />
            <StatusPill status="stopped" />
            <StatusPill status="sleeping" />
            <StatusPill status="crashed" />
            <StatusPill status="suspended" />
            <StatusPill status="info" label="Update available" />
          </div>
          <div className="bk-row bk-wrap" style={{ gap: 'var(--space-8)' }}>
            <Badge mono>26.3</Badge>
            <Badge>Vanilla</Badge>
            <Badge tone="grass">Operator</Badge>
            <Badge tone="info">Update available</Badge>
            <Badge tone="danger">Not compatible</Badge>
            <Badge tone="outline">Survival</Badge>
          </div>
          <Note tone="info">Restart the server to load the new mod.</Note>
          <Note tone="danger">That name is taken — try adding a word.</Note>
        </Section>

        <Section title="Forms">
          <FormSection
            title="Who can join"
            description="Anyone with the address, or only the people you add."
            actions={
              <>
                <Button variant="ghost">Cancel</Button>
                <Button variant="primary">Save</Button>
              </>
            }
          >
            <Toggle label="Only people I add can join" checked={toggle} onChange={setToggle} />
            <SuggestField
              label="Add a player"
              placeholder="Minecraft name"
              autoComplete="off"
              spellCheck={false}
              value={player}
              onChange={(event) => setPlayer(event.target.value)}
              onPick={setPlayer}
              suggestions={[
                { value: 'Alex', note: 'Playing now' },
                { value: 'Steve' },
                { value: 'Sunny_Builds' },
                { value: 'Notch' },
              ]}
              trailing={<Button variant="outline">Add</Button>}
            />
            <TextField
              label="Server address"
              mono
              defaultValue="sunset-valley"
              error="That address is taken — try adding a word."
            />
            <FormRow
              label="Keep the server awake"
              description="It sleeps after 15 quiet minutes and wakes when someone joins."
              control={<Toggle ariaLabel="Keep awake" checked={false} onChange={() => {}} />}
            />
            <CopyField value="sunset-valley.play.localhost" />
          </FormSection>
        </Section>

        <Section title="Choices">
          <fieldset className="bk-choices">
            <legend className="bk-visually-hidden">Game mode</legend>
            {(
              [
                [
                  'survival',
                  'Survival',
                  'Gather, build and stay alive together.',
                  <Swords key="i" size={24} strokeWidth={1.75} aria-hidden />,
                ],
                [
                  'creative',
                  'Creative',
                  'Unlimited blocks. Build whatever you imagine.',
                  <Palette key="i" size={24} strokeWidth={1.75} aria-hidden />,
                ],
              ] as const
            ).map(([value, title, description, icon]) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                className="bk-choice"
                onClick={() => setMode(value)}
              >
                <span className="bk-choice__icon">{icon}</span>
                <span className="bk-choice__title">{title}</span>
                <span className="bk-choice__desc">{description}</span>
              </button>
            ))}
          </fieldset>
          <fieldset className="bk-chips">
            <legend className="bk-visually-hidden">How many players</legend>
            {['4', '10', '20', 'more'].map((size) => (
              <label
                key={size}
                className="bk-chip bk-num"
                title={size === '20' ? 'Needs a bigger plan' : undefined}
              >
                <input
                  type="radio"
                  name="gallery-party"
                  value={size}
                  checked={party === size}
                  disabled={size === '20'}
                  onChange={() => setParty(size)}
                />
                {size === 'more' ? 'More' : size}
              </label>
            ))}
          </fieldset>
        </Section>

        <Section title="Provisioning">
          <ProvisioningPanel
            title="Building your world"
            eta="About 40 seconds left"
            progress={progress}
            steps={[
              { label: 'Picking a place', state: progress > 25 ? 'done' : 'active' },
              {
                label: 'Getting Minecraft 26.3',
                state: progress > 50 ? 'done' : progress > 25 ? 'active' : 'todo',
              },
              { label: 'Starting it up', state: progress > 75 ? 'done' : progress > 50 ? 'active' : 'todo' },
              {
                label: 'Creating your world',
                state: progress >= 100 ? 'done' : progress > 75 ? 'active' : 'todo',
              },
            ]}
            live={<span className="bk-prov__live">Preparing spawn area: 83%</span>}
          >
            <div className="bk-row" style={{ gap: 'var(--space-12)' }}>
              <Button onClick={() => setProgress((p) => Math.max(0, p - 30))}>Back</Button>
              <Button onClick={() => setProgress((p) => Math.min(100, p + 30))}>Advance</Button>
            </div>
          </ProvisioningPanel>
        </Section>

        <Section title="Servers">
          <div className="bk-grid bk-grid--three">
            <ServerCard
              href="#"
              name="Sunset Valley"
              status="online"
              image="/imagery/cover-cherry.jpg"
              version="26.3"
              loader="Vanilla"
              detail="3 / 10 players"
              address="sunset-valley.play.localhost"
            />
            <ServerCard
              href="#"
              name="Creative Island"
              status="sleeping"
              image="/imagery/cover-snow.jpg"
              version="1.21.11"
              loader="Fabric"
              detail="Wakes up when someone joins"
              address="creative-island.play.localhost"
            />
            <div className="bk-server" aria-busy>
              <div className="bk-server__media" />
              <div className="bk-server__body">
                <Skeleton width="60%" height={18} />
                <Skeleton width="40%" />
                <Skeleton width="80%" />
              </div>
            </div>
          </div>
        </Section>

        <Section title="Cards and players">
          <div className="bk-grid">
            <Card
              title="Players"
              description="Nobody’s online right now. Send your friends the address."
              href="#"
            />
            <Card title="Who can join" description="Only people you add — 3 players so far." href="#" />
          </div>
          <div className="bk-list" style={{ maxWidth: 'var(--width-form)' }}>
            <PlayerRow
              name="Steve"
              meta="Playing now"
              badge={<Badge tone="grass">Operator</Badge>}
              action={
                <Button variant="ghost" size="sm">
                  Remove
                </Button>
              }
            />
            <PlayerRow
              name="Alex"
              meta="Added when the server starts"
              action={
                <Button variant="ghost" size="sm">
                  Remove
                </Button>
              }
            />
            <PlayerRow
              name="Griefer"
              meta="The server did not accept this"
              metaTone="danger"
              online={false}
            />
          </div>
          <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
            Faces come from each player's skin. Without one, a face is drawn from the name, the same one every
            time:
          </p>
          <div className="bk-row" style={{ gap: 'var(--space-8)', flexWrap: 'wrap' }}>
            {FACE_NAMES.map((name) => (
              <PlayerFace key={name} name={name} />
            ))}
          </div>
        </Section>

        <Section title="Console">
          <Tabs
            label="Example"
            value={tab}
            onChange={setTab}
            items={[
              { value: 'all', label: 'All' },
              { value: 'chat', label: 'Chat', count: 2 },
            ]}
          />
          <Console
            lines={[
              { id: '1', time: '21:04:11', text: 'Done (4.213s)! For help, type "help"', level: 'info' },
              { id: '2', time: '21:04:30', text: 'Steve joined the game', level: 'info' },
              { id: '3', time: '21:04:41', text: '<Steve> anyone want to build a castle?', level: 'chat' },
              { id: '4', time: '21:05:02', text: "Can't keep up! Is the server overloaded?", level: 'warn' },
              { id: '5', time: '21:05:07', text: 'Exception in thread "Server thread"', level: 'error' },
            ]}
            onSubmit={async () => {}}
          />
        </Section>

        <Section title="Empty and danger">
          <Card>
            <EmptyState
              art={<Image src="/imagery/feature-lakeside.jpg" alt="" width={132} height={132} />}
              title="Let's make your first world"
              description="It takes about a minute, and your friends can join as soon as it is up."
              action={<Button variant="primary">Create a server</Button>}
            />
          </Card>
          <DangerZone
            items={[
              {
                label: 'Delete server',
                description: 'The world and everything in it goes away. You can restore it for a few days.',
                action: (
                  <Button variant="danger" onClick={() => setModal(true)}>
                    Delete server
                  </Button>
                ),
              },
            ]}
          />
          <Modal
            open={modal}
            onClose={() => setModal(false)}
            title={
              <>
                Delete <strong>Sunset Valley</strong>?
              </>
            }
            actions={
              <>
                <Button variant="ghost" onClick={() => setModal(false)}>
                  Cancel
                </Button>
                <Button variant="danger">Delete server</Button>
              </>
            }
          >
            The server stops and its address stops working. You can restore it for a few days.
          </Modal>
        </Section>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bk-stack" style={{ gap: 'var(--space-20)' }}>
      <h2 className="type-heading-md" style={{ color: 'var(--ink)' }}>
        {title}
      </h2>
      {children}
    </section>
  )
}
