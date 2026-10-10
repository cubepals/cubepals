// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The web app's build: the /api rewrite to the control plane, standalone output for self-hosting,
 * and what PostHog needs from the build (the environment, the version, source maps).
 */
import { join } from 'node:path'
import type { NextConfig } from 'next'
import { indexable } from './src/lib/site'
import { apiUpstream } from './src/lib/upstream'

/**
 * The self-hosted image (apps/web/Dockerfile) builds a standalone server, traced from the
 * repository root so the workspace packages come along. The Worker build (OpenNext) doesn't.
 */
const standalone = process.env.NEXT_OUTPUT === 'standalone'

/**
 * Source maps for PostHog's errors, built only when scripts/sourcemaps.ts will upload them and
 * delete them after: with its key and project, never otherwise.
 */
const sourceMaps = Boolean(process.env.POSTHOG_PERSONAL_API_KEY && process.env.POSTHOG_PROJECT_ID)

/**
 * Which deployment built this, by its own id as the control plane reads it (DEPLOYMENT_ID): every
 * PostHog event carries it, so staging's and local ones stay out of production's charts.
 */
const environment =
  process.env.DEPLOYMENT_ID === 'prod'
    ? 'production'
    : process.env.DEPLOYMENT_ID === 'staging'
      ? 'staging'
      : 'development'

/**
 * Browsers call /api on this origin and the rewrite forwards it to the control plane, so cookies
 * stay host-only and the bundle names no API address.
 */
export default {
  poweredByHeader: false,
  // No generated AGENTS.md or CLAUDE.md in the app directory.
  agentRules: false,
  reactStrictMode: true,
  ...(standalone ? { output: 'standalone', outputFileTracingRoot: join(process.cwd(), '../..') } : {}),
  transpilePackages: ['@blockly/contracts'],
  productionBrowserSourceMaps: sourceMaps,
  env: {
    BLOCKLY_ENVIRONMENT: environment,
    // The commit a deploy builds from: scripts/lib/web-worker.ts sets it.
    BLOCKLY_VERSION: (process.env.GIT_COMMIT_SHA ?? 'dev').slice(0, 12),
  },
  // `bun run dev:lan` opens the dev server to other devices; Next refuses its dev resources to any
  // origin not named here, which would leave a phone with a page and no scripts.
  ...(process.env.NEXT_ALLOWED_DEV_ORIGINS
    ? { allowedDevOrigins: process.env.NEXT_ALLOWED_DEV_ORIGINS.split(',') }
    : {}),
  // Types are checked by the workspace's `bun run typecheck`, not during the build.
  typescript: { ignoreBuildErrors: true },
  // The /api rewrite and src/lib/before-next.ts's sign-in paths then agree on case: /API/auth/… is
  // a 404, not a way to the control plane around it.
  experimental: { caseSensitiveRoutes: true },
  // Every deployment but production says noindex on every response, files and images too, which
  // the pages' own robots meta can't reach.
  async headers() {
    return indexable() ? [] : [{ source: '/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex' }] }]
  },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUpstream()}/api/:path*` }]
  },
} satisfies NextConfig
