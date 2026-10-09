/**
 * Why a request was refused, in the order AccessPolicy checks them. The web app words each one
 * differently: "Not available on this Blockly deployment" is not "Upgrade your plan".
 */
export const DENIAL_CODES = [
  'deployment_unsupported',
  'platform_paused',
  'account_suspended',
  'restricted',
  'email_unverified',
  'not_entitled',
  'limit_reached',
  'rate_limited',
] as const
export type DenialCode = (typeof DENIAL_CODES)[number]

/**
 * Whether someone can use a feature here and now, and if not, why: the answer the same policy
 * gives when they try, so what a page offers and what the API allows can't disagree (§15.4).
 */
export type Availability = { available: true } | { available: false; code: DenialCode; message: string }

/** Every refusal the API can explain, beyond "you are not signed in" and "no such thing". */
export const APP_ERROR_CODES = [
  ...DENIAL_CODES,
  'invalid_transition',
  'slug_taken',
  'slug_invalid',
  'confirmation_mismatch',
  'unknown_player',
  'server_not_running',
  'command_refused',
  'invalid_choice',
  'invalid_settings',
  'invalid_name',
  'version_downgrade',
  'mods_conflict',
  'changed_meanwhile',
  'revoked_artifacts',
  'catalog_unavailable',
  'invalid_upload',
  'billing_unavailable',
] as const
export type AppErrorCode = (typeof APP_ERROR_CODES)[number]

export interface AppErrorData {
  appCode: AppErrorCode
}
