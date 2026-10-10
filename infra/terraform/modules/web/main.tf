# The web app as a Cloudflare Worker (§14, §16): the Worker, the R2 bucket OpenNext keeps Next's
# data cache in, and the routes that send the site's hosts to it. The Worker answers the hosts that
# redirect (www.) itself, so no redirect rule is needed (apps/web/src/lib/before-next.ts).
#
# Only what outlives a deploy is here. The code, its vars and WEB_PROXY_SECRET belong to each
# version, which scripts/lib/web-worker.ts uploads with wrangler, and the Worker's own settings
# (observability, workers.dev) are apps/web/wrangler.jsonc's, which every deploy applies. Terraform
# never manages versions or deployments: it would undo each deploy. A route sees only proxied
# traffic, so until modules/dns proxies the hosts (web_proxied) nothing reaches the Worker by them.

terraform {
  required_version = ">= 1.11"
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare" }
  }
}

variable "account_id" { type = string }

variable "zone_id" {
  description = "The zone holding the site's hosts."
  type        = string
}

variable "worker" {
  description = "The Worker's name, as apps/web/wrangler.jsonc names it for this environment."
  type        = string
}

variable "hosts" {
  description = "The site's host, then the hosts that redirect to it, all answered by the Worker."
  type        = list(string)
}

resource "cloudflare_worker" "web" {
  account_id = var.account_id
  name       = var.worker

  # Terraform holds the Worker's name and nothing else. Every deploy sets its settings from
  # apps/web/wrangler.jsonc and Cloudflare fills in its references and tags, so an update from here
  # would only undo them, and the API refuses the update the provider sends anyway (it carries a
  # trace propagation policy the account doesn't have).
  lifecycle {
    ignore_changes = all
  }
}

# Next's data cache and the prerendered pages (apps/web/open-next.config.ts), bound in
# wrangler.jsonc by this name.
resource "cloudflare_r2_bucket" "cache" {
  account_id = var.account_id
  name       = "${var.worker}-cache"
}

resource "cloudflare_workers_route" "web" {
  for_each = toset(var.hosts)
  zone_id  = var.zone_id
  pattern  = "${each.key}/*"
  script   = cloudflare_worker.web.name
}
