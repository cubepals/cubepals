# One environment, whole: the Fly organization's apps, the control plane's configuration, the
# edge, DNS, the archive bucket, the web app's Worker and the fleet's Hetzner nodes.
# environments/<name> passes its values in.
#
# What is decided lives in each environment's config.auto.tfvars.json and is checked by the
# control plane's own config loader (apps/control/src/config/environments.test.ts). What is not
# known in the repository (account and zone ids, admin emails, the CA terms) arrives as
# `operator_settings`, and every secret as `secrets`, at apply time (docs/configuration.md).
# Fleet nodes are the same: fleet-nodes.auto.tfvars.json lists them, and each new one's join line
# arrives as `fleet_join_lines` (bun scripts/fleet.ts add does both).

terraform {
  required_version = ">= 1.11"
  required_providers {
    fly        = { source = "ampbase-io/fly" }
    cloudflare = { source = "cloudflare/cloudflare" }
    hcloud     = { source = "hetznercloud/hcloud" }
  }
}

variable "fly_org" { type = string }
variable "fly_machine_limit" { type = number }

variable "settings" {
  description = "Non-secret DeploymentConfig values decided in the repository, by variable name."
  type        = map(string)
}

variable "operator_settings" {
  description = "Non-secret values only the operator has: ids, admin emails, accepted terms."
  type        = map(string)
  default     = {}
}

variable "secret_names" {
  description = "Every secret this environment's DeploymentConfig needs."
  type        = list(string)
}

variable "optional_secret_names" {
  description = "Secrets that turn a capability on when given (billing, GitHub sign-in), and are left out otherwise."
  type        = list(string)
  default     = []
}

variable "secrets" {
  description = "The secrets, by name; from the operator's secret store, never committed."
  type        = map(string)
  sensitive   = true
  validation {
    condition     = length(var.secrets) > 0
    error_message = "Pass every secret in secret_names (TF_VAR_secrets, JSON)."
  }
}

variable "secret_versions" {
  description = "A non-secret marker per secret that changes when its value does."
  type        = map(string)
}

variable "cloudflare_account_id" { type = string }
variable "cloudflare_zone_id" { type = string }

variable "web" {
  description = "The web app's Worker, hosts that redirect to its domain, and whether those hosts are proxied to the Worker yet (the cutover from Vercel)."
  type = object({
    worker    = string
    redirects = optional(list(string), [])
    proxied   = optional(bool, false)
  })
}

variable "fleet_nodes" {
  description = "Fleet nodes on Hetzner Cloud, by name: fleet-nodes.auto.tfvars.json, which fleet.ts add and remove keep."
  type        = map(object({ location = string, type = string }))
  default     = {}
  validation {
    condition     = alltrue([for n in values(var.fleet_nodes) : contains(["fsn1", "nbg1", "hel1", "ash", "hil", "sin"], n.location)])
    error_message = "A fleet node's location is one of fsn1, nbg1, hel1, ash, hil or sin."
  }
}

variable "fleet_join_lines" {
  description = "The line fleet.ts token printed, by node name; only a node being made needs one."
  type        = map(string)
  sensitive   = true
  default     = {}
}

variable "fleet_hetzner" {
  description = "Where fleet nodes go: a private network to join (made when not given), SSH keys, an edge's public addresses."
  type = object({
    network_id   = optional(number)
    ip_range     = optional(string, "10.0.0.0/16")
    ssh_keys     = optional(list(string), [])
    edge_sources = optional(list(string), [])
  })
  default = {}
}

module "org" {
  source        = "../modules/fly-org"
  org           = var.fly_org
  deployment_id = var.settings["DEPLOYMENT_ID"]
  machine_limit = var.fly_machine_limit
}

locals {
  api_origin    = "https://${module.org.apps.control}.fly.dev"
  internal_url  = "http://api.process.${module.org.apps.control}.internal:4001"
  realtime_host = var.settings["REALTIME_TLS_HOSTNAME"]
  web_host      = trimprefix(var.settings["WEB_CANONICAL_ORIGIN"], "https://")
  play_domains  = compact(concat([var.settings["PLAY_DOMAIN"]], split(",", lookup(var.settings, "PLAY_DOMAIN_ALIASES", ""))))
  given         = nonsensitive(toset(keys(var.secrets)))
  missing       = setsubtract(toset(var.secret_names), local.given)
  unknown       = setsubtract(local.given, toset(concat(var.secret_names, var.optional_secret_names)))
  # Billing is on with Polar's two secrets and its products, and off with none of them.
  billing_parts = [contains(local.given, "POLAR_ACCESS_TOKEN"), contains(local.given, "POLAR_WEBHOOK_SECRET"), lookup(var.operator_settings, "POLAR_PRODUCTS", "") != ""]
  # An empty setting is left unset, which the control plane reads the same way: Fly keeps no
  # empty secret.
  control_config = { for name, value in merge(var.settings, var.operator_settings, {
    ARTIFACTS_RUNTIME_FACING_URL = local.api_origin
    ARCHIVE_S3_ENDPOINT          = module.archive.endpoint
    # The control plane holds maxServers to what the org's machines allow (§19.12).
    FLY_MACHINE_LIMIT     = tostring(module.org.machine_limit)
    FLY_PLATFORM_MACHINES = tostring(module.org.platform_machines)
    # The realtime role's DNS-01 challenges go in the zone the stack writes records to.
    CLOUDFLARE_ZONE_ID = var.cloudflare_zone_id
  }) : name => value if value != "" }
}

resource "terraform_data" "secrets_complete" {
  input = length(local.missing)
  lifecycle {
    precondition {
      condition     = length(local.missing) == 0
      error_message = "Secrets missing: ${join(", ", local.missing)}."
    }
    precondition {
      condition     = length(local.unknown) == 0
      error_message = "Secrets this environment doesn't use: ${join(", ", local.unknown)}. Check their names."
    }
    precondition {
      condition     = alltrue(local.billing_parts) || !anytrue(local.billing_parts)
      error_message = "Billing needs all three of POLAR_ACCESS_TOKEN, POLAR_WEBHOOK_SECRET (secrets) and POLAR_PRODUCTS (operator_settings), or none of them."
    }
  }
}

module "archive" {
  source     = "../modules/archive"
  account_id = var.cloudflare_account_id
  bucket     = var.settings["ARCHIVE_S3_BUCKET"]
  web_origin = var.settings["WEB_CANONICAL_ORIGIN"]
}

module "control" {
  source            = "../modules/control"
  org               = module.org.org
  control_app       = module.org.apps.control
  realtime_app      = module.org.apps.realtime
  realtime_hostname = local.realtime_host
  settings          = local.control_config
  secrets           = var.secrets
  secret_versions   = var.secret_versions
}

module "edge" {
  source             = "../modules/edge"
  org                = module.org.org
  edge_app           = module.org.apps.edge
  control_url        = local.internal_url
  edge_token         = var.secrets["EDGE_TOKEN"]
  edge_token_version = var.secret_versions["EDGE_TOKEN"]
}

module "dns" {
  source              = "../modules/dns"
  zone_id             = var.cloudflare_zone_id
  play_domains        = local.play_domains
  edge_ipv4           = module.edge.ipv4
  edge_ipv6           = module.edge.ipv6
  realtime_hostname   = local.realtime_host
  realtime_ipv4       = module.control.realtime_ipv4
  realtime_validation = module.control.realtime_validation
  web_hostnames       = concat([local.web_host], var.web.redirects)
  web_proxied         = var.web.proxied
}

# The Worker, its cache bucket and its routes. What it runs, and the values it runs with
# (API_UPSTREAM, WEB_PROXY_SECRET, the build's), come with each deploy (scripts/lib/web-worker.ts).
module "web" {
  source     = "../modules/web"
  account_id = var.cloudflare_account_id
  zone_id    = var.cloudflare_zone_id
  worker     = var.web.worker
  hosts      = concat([local.web_host], var.web.redirects)
}

locals {
  # Hetzner's network zone for each location: a network has one subnet per zone it is used in.
  fleet_zone_of = {
    fsn1 = "eu-central", nbg1 = "eu-central", hel1 = "eu-central"
    ash  = "us-east", hil = "us-west", sin = "ap-southeast"
  }
  fleet_zones       = ["eu-central", "us-east", "us-west", "ap-southeast"]
  fleet_new_network = var.fleet_hetzner.network_id == null && length(var.fleet_nodes) > 0
  fleet_used_zones  = toset([for n in values(var.fleet_nodes) : local.fleet_zone_of[n.location]])
  # Through the subnet, so no node attaches before its zone's subnet exists.
  fleet_network_of = local.fleet_new_network ? {
    for zone, subnet in hcloud_network_subnet.fleet : zone => subnet.network_id
  } : { for zone in local.fleet_zones : zone => var.fleet_hetzner.network_id }
}

resource "hcloud_network" "fleet" {
  count    = local.fleet_new_network ? 1 : 0
  name     = "blockly-${var.settings["DEPLOYMENT_ID"]}-fleet"
  ip_range = var.fleet_hetzner.ip_range
  labels   = { blockly = "fleet-node" }
}

resource "hcloud_network_subnet" "fleet" {
  for_each     = local.fleet_new_network ? local.fleet_used_zones : toset([])
  network_id   = hcloud_network.fleet[0].id
  type         = "cloud"
  network_zone = each.key
  ip_range     = cidrsubnet(var.fleet_hetzner.ip_range, 8, index(local.fleet_zones, each.key))
}

module "fleet_node" {
  source        = "../modules/fleet-node"
  for_each      = var.fleet_nodes
  name          = each.key
  location      = each.value.location
  type          = each.value.type
  network_id    = local.fleet_network_of[local.fleet_zone_of[each.value.location]]
  private_range = var.fleet_hetzner.ip_range
  join_line     = lookup(var.fleet_join_lines, each.key, "")
  ssh_keys      = var.fleet_hetzner.ssh_keys
  edge_sources  = var.fleet_hetzner.edge_sources
}

output "apps" {
  value = module.org.apps
}

output "edge_addresses" {
  value = { ipv4 = module.edge.ipv4, ipv6 = module.edge.ipv6 }
}

output "realtime_ipv4" {
  value = module.control.realtime_ipv4
}

output "fleet_nodes" {
  value = { for name, node in module.fleet_node : name => { id = node.id, private_ip = node.private_ip } }
}
