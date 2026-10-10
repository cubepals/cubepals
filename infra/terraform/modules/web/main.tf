# The web app on Vercel (§14, §16): the project, its canonical domain and the hosts redirected to
# it, and API_UPSTREAM, which only the server side sees (the /api rewrite and server components).

terraform {
  required_version = ">= 1.11"
  required_providers {
    vercel = { source = "vercel/vercel" }
  }
}

variable "project" {
  description = "The Vercel project's name."
  type        = string
}

variable "repository" {
  description = "The GitHub repository Vercel builds, as owner/name."
  type        = string
}

variable "production_branch" {
  description = "The branch whose deployments are this environment's production."
  type        = string
}

variable "domain" {
  description = "The host in WEB_CANONICAL_ORIGIN."
  type        = string
}

variable "api_upstream" {
  description = "API_UPSTREAM: the control plane's public origin."
  type        = string
}

variable "proxy_secret" {
  description = "WEB_PROXY_SECRET: sent with each browser's address, which the control plane believes only with it."
  type        = string
  sensitive   = true
}

variable "proxy_secret_version" {
  description = "WEB_PROXY_SECRET's marker in secret_versions: a new one sends the value again."
  type        = string
}

variable "redirects" {
  description = "Hosts that redirect to the domain, such as its www. name."
  type        = list(string)
  default     = []
}

variable "deployment_id" {
  description = "DEPLOYMENT_ID, as the control plane has it: the build reads which environment it is from it."
  type        = string
}

variable "posthog_token" {
  description = "PostHog's public project token for the browser; empty sends nothing (production alone sets it)."
  type        = string
  default     = ""
}

variable "previews" {
  description = "Whether this project builds preview deployments (staging does; production doesn't)."
  type        = bool
}

variable "canonical_origin" {
  description = "WEB_CANONICAL_ORIGIN: the site's one address, which links, sitemaps and sign-in are built on."
  type        = string
}

variable "indexable" {
  description = "Whether search engines may index production (production's alone; everything else says noindex)."
  type        = bool
}

variable "posthog_personal_api_key" {
  description = "POSTHOG_PERSONAL_API_KEY: lets a production build upload its source maps; empty uploads none."
  type        = string
  sensitive   = true
  default     = ""
}

variable "posthog_personal_api_key_version" {
  description = "POSTHOG_PERSONAL_API_KEY's marker in web_secret_versions; empty when there is no key."
  type        = string
  default     = ""
}

variable "posthog_project_id" {
  description = "POSTHOG_PROJECT_ID: the project the source maps go to, with the key."
  type        = string
  sensitive   = true
  default     = ""
}

resource "vercel_project" "web" {
  name           = var.project
  framework      = "nextjs"
  root_directory = "apps/web"
  git_repository = {
    type              = "github"
    repo              = var.repository
    production_branch = var.production_branch
  }
  # A project without previews skips every build that isn't its production branch: a preview here
  # would have no control plane to rewrite to. Exit 0 skips the build. It reads VERCEL_ENV, which
  # the build sees only with the system variables exposed; without them every build was skipped.
  ignore_command                                    = var.previews ? null : "[ \"$VERCEL_ENV\" != \"production\" ]"
  automatically_expose_system_environment_variables = true
}

resource "vercel_project_domain" "web" {
  project_id = vercel_project.web.id
  domain     = var.domain
}

# Hosts a person may type instead (www.), sent on to the domain for good.
resource "vercel_project_domain" "redirect" {
  for_each             = toset(var.redirects)
  project_id           = vercel_project.web.id
  domain               = each.key
  redirect             = vercel_project_domain.web.domain
  redirect_status_code = 308
}

# Staging's previews rewrite to staging's control plane, as its production branch does.
resource "vercel_project_environment_variable" "api_upstream" {
  project_id = vercel_project.web.id
  key        = "API_UPSTREAM"
  value      = var.api_upstream
  target     = var.previews ? ["production", "preview"] : ["production"]
  # The control plane's public origin: server-side only, but no secret.
  sensitive = false
}

# The same secret as the control plane's: the web tier's word about each browser's address, which
# sign-in's limits count by.
# Write-only, as the control plane's Fly secrets are: the value never lands in Terraform's state.
# Vercel hands a changed value only to new deployments: redeploy production with the control app.
resource "vercel_project_environment_variable" "proxy_secret" {
  project_id       = vercel_project.web.id
  key              = "WEB_PROXY_SECRET"
  value_wo         = var.proxy_secret
  value_wo_version = parseint(substr(sha256(var.proxy_secret_version), 0, 12), 16)
  target           = var.previews ? ["production", "preview"] : ["production"]
  sensitive        = true
}

# Which header holds the browser's address on Vercel: the one its edge sets and overwrites.
resource "vercel_project_environment_variable" "client_address_header" {
  project_id = vercel_project.web.id
  key        = "WEB_CLIENT_ADDRESS_HEADER"
  value      = "x-real-ip"
  target     = var.previews ? ["production", "preview"] : ["production"]
  sensitive  = false
}

# Which environment built the page, by the deployment's own id: every PostHog event carries it, so
# staging's never count in production's charts. Not a secret.
resource "vercel_project_environment_variable" "deployment_id" {
  project_id = vercel_project.web.id
  key        = "DEPLOYMENT_ID"
  value      = var.deployment_id
  target     = var.previews ? ["production", "preview"] : ["production"]
  sensitive  = false
}

# PostHog's project token, public by design (it ships in every page), read at build time. Only an
# environment that sets it sends anything.
resource "vercel_project_environment_variable" "posthog_token" {
  count      = var.posthog_token == "" ? 0 : 1
  project_id = vercel_project.web.id
  key        = "NEXT_PUBLIC_POSTHOG_TOKEN"
  value      = var.posthog_token
  target     = var.previews ? ["production", "preview"] : ["production"]
  sensitive  = false
}

# The site's own address, for links, the sitemap and sign-in's base URL. Previews use it too: they
# sign in through the canonical origin's callback.
resource "vercel_project_environment_variable" "canonical_origin" {
  project_id = vercel_project.web.id
  key        = "WEB_CANONICAL_ORIGIN"
  value      = var.canonical_origin
  target     = var.previews ? ["production", "preview"] : ["production"]
  sensitive  = false
}

# Only production is indexed; without this every page says noindex.
resource "vercel_project_environment_variable" "indexable" {
  count      = var.indexable ? 1 : 0
  project_id = vercel_project.web.id
  key        = "WEB_INDEXABLE"
  value      = "1"
  target     = ["production"]
  sensitive  = false
}

# The build uploads its source maps to PostHog with these, so production's errors read as source.
# Production builds only, and only when the operator gave both.
resource "vercel_project_environment_variable" "posthog_personal_api_key" {
  count            = var.posthog_personal_api_key_version == "" ? 0 : 1
  project_id       = vercel_project.web.id
  key              = "POSTHOG_PERSONAL_API_KEY"
  value_wo         = var.posthog_personal_api_key
  value_wo_version = parseint(substr(sha256(var.posthog_personal_api_key_version), 0, 12), 16)
  target           = ["production"]
  sensitive        = true
}

resource "vercel_project_environment_variable" "posthog_project_id" {
  count      = var.posthog_personal_api_key_version == "" ? 0 : 1
  project_id = vercel_project.web.id
  key        = "POSTHOG_PROJECT_ID"
  value      = var.posthog_project_id
  target     = ["production"]
  sensitive  = false
}
