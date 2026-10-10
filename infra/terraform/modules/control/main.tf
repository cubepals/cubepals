# SPDX-FileCopyrightText: 2026 The Cubepals Authors
#
# SPDX-License-Identifier: AGPL-3.0-only

# The control plane (§16): the control app (api and worker process groups, infra/fly/control.toml)
# and the realtime app (infra/fly/realtime.toml), both running the control image with the same
# DeploymentConfig. Machines come from `fly deploy`; this module owns the apps, the realtime
# app's dedicated IPv4, the certificate Fly serves on its fallback port, and every config value as
# a Fly secret.

terraform {
  required_version = ">= 1.11"
  required_providers {
    fly = { source = "ampbase-io/fly" }
  }
}

variable "org" { type = string }
variable "control_app" { type = string }
variable "realtime_app" { type = string }

variable "realtime_hostname" {
  description = "What browsers dial for realtime: an A record to the dedicated IPv4, and no AAAA."
  type        = string
}

variable "settings" {
  description = "Non-secret DeploymentConfig values, by environment variable name."
  type        = map(string)
}

variable "secrets" {
  description = "Secret DeploymentConfig values, by name. Supplied at apply time, never committed."
  type        = map(string)
  sensitive   = true
}

variable "secret_versions" {
  description = "A non-secret marker per secret that changes when its value does (a date, a key id)."
  type        = map(string)
}

resource "fly_app" "control" {
  name = var.control_app
  org  = var.org
}

resource "fly_app" "realtime" {
  name = var.realtime_app
  org  = var.org
}

# WebTransport's UDP reaches a machine only through a dedicated IPv4 (§2). No IPv6 record is
# published for the hostname, so browsers never try an address without UDP.
resource "fly_ip" "realtime_v4" {
  app  = fly_app.realtime.name
  type = "public_v4"
}

# Fly terminates TLS for the WebSocket fallback on TCP 443, and validates over HTTP-01 on port 80
# (infra/fly/realtime.toml). With no AAAA record it checks ownership through the TXT record its
# outputs below name, which the dns module publishes. The _acme-challenge name is left for the
# realtime role's own DNS-01 certificate.
resource "fly_cert" "realtime" {
  app      = fly_app.realtime.name
  hostname = var.realtime_hostname
}

locals {
  secret_names = nonsensitive(toset(keys(var.secrets)))
  apps         = { control = fly_app.control.name, realtime = fly_app.realtime.name }
  # Every value on both apps: each loads the whole DeploymentConfig at start.
  settings = merge([for key, app in local.apps : { for name, value in var.settings : "${key}/${name}" => { app = app, name = name, value = value } }]...)
  secrets  = merge([for key, app in local.apps : { for name in local.secret_names : "${key}/${name}" => { app = app, name = name } }]...)
}

resource "fly_secret" "setting" {
  for_each         = local.settings
  app              = each.value.app
  name             = each.value.name
  value_wo         = each.value.value
  value_wo_version = each.value.value
}

resource "fly_secret" "secret" {
  for_each         = local.secrets
  app              = each.value.app
  name             = each.value.name
  value_wo         = var.secrets[each.value.name]
  value_wo_version = var.secret_versions[each.value.name]
}

output "realtime_ipv4" {
  value = fly_ip.realtime_v4.address
}

output "realtime_validation" {
  value = {
    ownership_name  = fly_cert.realtime.ownership_name
    ownership_value = fly_cert.realtime.ownership_app_value
  }
}

output "api_origin" {
  description = "Where the web app's /api rewrite goes: API_UPSTREAM."
  value       = "https://${fly_app.control.name}.fly.dev"
}

output "internal_url" {
  description = "The api machines' internal listener, which the edge calls over the private network."
  value       = "http://api.process.${fly_app.control.name}.internal:4001"
}
