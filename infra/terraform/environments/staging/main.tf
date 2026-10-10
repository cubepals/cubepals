# SPDX-FileCopyrightText: 2026 The Cubepals Authors
#
# SPDX-License-Identifier: AGPL-3.0-only

# The staging environment. Values decided in the repository are in config.auto.tfvars.json; the
# rest arrive at apply time (docs/configuration.md):
#   terraform init -backend-config=backend.hcl
#   TF_VAR_secrets='{…}' TF_VAR_secret_versions='{…}' TF_VAR_operator_settings='{…}' \
#   TF_VAR_cloudflare_account_id=… TF_VAR_cloudflare_zone_id=… terraform apply
# with FLY_API_TOKEN (an org token for the staging org) and CLOUDFLARE_API_TOKEN.
# The staging that runs today is scripts/staging.ts's, which makes its own apps, records and web
# Worker without Terraform; this environment is the same stack as production's, kept valid.
# Fleet nodes are listed in fleet-nodes.auto.tfvars.json; `bun scripts/fleet.ts add` adds one, with
# its join line in TF_VAR_fleet_join_lines and HCLOUD_TOKEN as TF_VAR_hcloud_token.

terraform {
  required_version = ">= 1.11"
  required_providers {
    fly        = { source = "ampbase-io/fly", version = "0.3.0" }
    cloudflare = { source = "cloudflare/cloudflare", version = "5.25.0" }
    hcloud     = { source = "hetznercloud/hcloud", version = "1.70.0" }
  }
  # State in an R2 bucket of the operator's, named in backend.hcl.
  backend "s3" {}
}

provider "fly" {
  org_slug = var.fly_org
}

provider "cloudflare" {}

# The fleet's Hetzner project. Until fleet-nodes.auto.tfvars.json lists a node, nothing calls it,
# so a stand-in of the length the provider checks lets every other apply go on without a token.
provider "hcloud" {
  token = var.hcloud_token != "" ? var.hcloud_token : "0000000000000000000000000000000000000000000000000000000000000000"
}

variable "fly_org" { type = string }
variable "fly_machine_limit" { type = number }
variable "settings" { type = map(string) }
variable "secret_names" { type = list(string) }
variable "web" {
  type = object({
    # As apps/web/wrangler.jsonc names staging's Worker.
    worker  = optional(string, "blockly-web-staging")
    proxied = optional(bool, false)
  })
  default = {}
}

variable "operator_settings" {
  type    = map(string)
  default = {}
}

variable "secrets" {
  type      = map(string)
  sensitive = true
}

variable "secret_versions" { type = map(string) }
variable "cloudflare_account_id" { type = string }
variable "cloudflare_zone_id" { type = string }

variable "fleet_nodes" {
  type = map(object({ location = string, type = string }))
}

variable "fleet_join_lines" {
  type      = map(string)
  sensitive = true
  default   = {}
}

variable "hcloud_token" {
  description = "The Hetzner Cloud project's API token, once a fleet node is listed."
  type        = string
  sensitive   = true
  default     = ""
  validation {
    condition     = var.hcloud_token != "" || length(var.fleet_nodes) == 0
    error_message = "fleet-nodes.auto.tfvars.json lists a node: set TF_VAR_hcloud_token to the Hetzner project's API token."
  }
}

variable "fleet_hetzner" {
  type = object({
    network_id   = optional(number)
    ip_range     = optional(string, "10.0.0.0/16")
    ssh_keys     = optional(list(string), [])
    edge_sources = optional(list(string), [])
  })
  default = {}
}

module "environment" {
  source                = "../../stack"
  fly_org               = var.fly_org
  fly_machine_limit     = var.fly_machine_limit
  settings              = var.settings
  operator_settings     = var.operator_settings
  secret_names          = var.secret_names
  secrets               = var.secrets
  secret_versions       = var.secret_versions
  cloudflare_account_id = var.cloudflare_account_id
  cloudflare_zone_id    = var.cloudflare_zone_id
  web                   = var.web
  fleet_nodes           = var.fleet_nodes
  fleet_join_lines      = var.fleet_join_lines
  fleet_hetzner         = var.fleet_hetzner
}

output "apps" {
  value = module.environment.apps
}

output "edge_addresses" {
  value = module.environment.edge_addresses
}

output "realtime_ipv4" {
  value = module.environment.realtime_ipv4
}

output "fleet_nodes" {
  value = module.environment.fleet_nodes
}
