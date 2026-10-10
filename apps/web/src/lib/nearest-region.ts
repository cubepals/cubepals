// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which region a new server starts in: the one nearest the player, by the country their request
 * came from. Nearest is rough network distance, as a ranking of the regions Blockly knows the place
 * of (`eu` in Frankfurt, `us` in Virginia). A region it doesn't know the place of is never picked
 * this way, only by hand; a country it doesn't know, or none at all, starts at the first region.
 *
 * It decides a default and nothing more: the player sees it in the create page's bar and can
 * change it there, and the country is not kept.
 */

/** North, Central and South America and the Caribbean: closer to Virginia than to Frankfurt. */
const AMERICAS = `US CA MX GT BZ SV HN NI CR PA CU DO HT JM PR BS BB TT AG DM GD KN LC VC AW CW BQ SX
  KY BM TC VG VI GP MQ BL MF PM CO VE EC PE BO BR PY UY AR CL GY SR GF FK`

/** Europe, the Middle East, Africa and South Asia: closer to Frankfurt than to Virginia. */
const EMEA = `AD AL AT AX BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI
  LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM UA VA XK
  AE BH IL IQ IR JO KW LB OM PS QA SA SY TR YE AM AZ GE KZ KG TJ TM UZ AF IN PK BD LK NP BT MV
  DZ AO BJ BW BF BI CV CM CF TD KM CG CD CI DJ EG GQ ER SZ ET GA GM GH GN GW KE LS LR LY MG MW ML
  MR MU MA MZ NA NE NG RW ST SN SC SL SO ZA SS SD TZ TG TN UG ZM ZW EH RE YT SH`

/** Each country's known regions, nearest first. */
const RANKING = new Map<string, readonly string[]>([
  ...AMERICAS.split(/\s+/).map((country) => [country, ['us', 'eu']] as const),
  ...EMEA.split(/\s+/).map((country) => [country, ['eu', 'us']] as const),
])

/**
 * The region a new server starts in, given the player's country (ISO 3166 alpha-2, as
 * `cf-ipcountry` says it) and the regions offered, in their configured order. `nearest`
 * says it was worked out from where the player is, rather than being the first by default.
 */
export function startingRegion(
  country: string | null,
  offered: readonly string[],
): { key: string; nearest: boolean } | null {
  const ranked = RANKING.get(country?.trim().toUpperCase() ?? '')?.find((key) => offered.includes(key))
  if (ranked !== undefined) return { key: ranked, nearest: true }
  const first = offered[0]
  return first === undefined ? null : { key: first, nearest: false }
}
