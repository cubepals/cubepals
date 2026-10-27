// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * Who could join the server a world came from (docs/world-import.md § Who can join): its
 * whitelist and operators as a list its owner lets in from, its bans, and whether only the
 * whitelist joins. Nobody is let in until they say so. Shown where a world is brought for a new
 * server and to an existing one; what is done with the choice is theirs, not this list's.
 */
import { MOST_WORLD_PEOPLE, type PeopleChoice, type WorldPeople } from '@blockly/contracts'
import { Button, PlayerFace, Toggle } from '../../ui'

/** One player of that server, with whether they operated it. */
interface Person {
  uuid: string
  name: string
  operator: boolean
}

/** Everyone on its whitelist or operating it, once each, whitelist first. */
function everyone(people: NonNullable<WorldPeople>): Person[] {
  const operators = new Set(people.operators.map((p) => p.uuid))
  const seen = new Map<string, Person>()
  for (const p of [...people.whitelist, ...people.operators])
    if (!seen.has(p.uuid)) seen.set(p.uuid, { ...p, operator: operators.has(p.uuid) })
  return [...seen.values()]
}

export function WorldPeopleChoice({
  people,
  choice,
  disabled,
  onChange,
}: {
  people: NonNullable<WorldPeople>
  choice: PeopleChoice
  disabled?: boolean
  onChange: (next: PeopleChoice) => void
}) {
  const players = everyone(people)
  const letIn = new Set(choice.letIn)
  const operators = new Set(choice.operators)
  const set = (uuid: string, on: boolean, list: Set<string>) => {
    const next = new Set(list)
    if (on) next.add(uuid)
    else next.delete(uuid)
    return [...next]
  }
  const toggleIn = (uuid: string, on: boolean) =>
    onChange({
      ...choice,
      letIn: set(uuid, on, letIn),
      // Only someone let in operates it.
      operators: on ? choice.operators : set(uuid, false, operators),
    })
  const banned = people.bans.map((ban) => ban.name)
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-12)' }}>
      <h2 className="type-heading-sm">Who can join</h2>
      {players.length > 0 && (
        <>
          <p className="type-body-sm">
            Its server let {players.length === 1 ? 'this player' : `these ${players.length} players`} in.
            Choose who comes here too; nobody does until you say.
          </p>
          <ul
            className="bk-stack"
            style={{ gap: 'var(--space-8)', listStyle: 'none', padding: 0, margin: 0 }}
          >
            {players.map((player) => (
              <li
                key={player.uuid}
                className="bk-row"
                style={{ gap: 'var(--space-12)', alignItems: 'center' }}
              >
                <PlayerFace name={player.name} uuid={player.uuid} size={28} />
                <span className="type-body" style={{ flex: 1, minWidth: 0 }}>
                  {player.name}
                </span>
                {player.operator && (
                  <Toggle
                    label="Operator"
                    checked={operators.has(player.uuid)}
                    disabled={disabled || !letIn.has(player.uuid)}
                    onChange={(on) => onChange({ ...choice, operators: set(player.uuid, on, operators) })}
                  />
                )}
                <Toggle
                  ariaLabel={`Let ${player.name} in`}
                  checked={letIn.has(player.uuid)}
                  disabled={disabled}
                  onChange={(on) => toggleIn(player.uuid, on)}
                />
              </li>
            ))}
          </ul>
          {letIn.size < players.length && (
            <div>
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() =>
                  onChange({ ...choice, letIn: players.slice(0, MOST_WORLD_PEOPLE).map((p) => p.uuid) })
                }
              >
                Let everyone in
              </Button>
            </div>
          )}
        </>
      )}
      <Toggle
        label="Only players let in can join"
        // Off while nobody is let in: a whitelist of nobody would keep everyone out, you too.
        checked={choice.whitelistOn && letIn.size > 0}
        disabled={disabled || letIn.size === 0}
        onChange={(on) => onChange({ ...choice, whitelistOn: on })}
      />
      {banned.length > 0 && (
        <Toggle
          label={`Keep its ${banned.length === 1 ? 'ban' : `${banned.length} bans`}: ${banned.join(', ')}`}
          checked={choice.keepBans}
          disabled={disabled}
          onChange={(on) => onChange({ ...choice, keepBans: on })}
        />
      )}
    </div>
  )
}
