# SPDX-FileCopyrightText: 2026 The Cubepals Authors
#
# SPDX-License-Identifier: AGPL-3.0-only

# The edge (§12, infra/fly/edge.toml): the app, its public addresses, which the play domains'
# wildcard records point at, how it reaches the control plane, and the certificate a browser
# opening a play address is answered with.

terraform {
  required_version = ">= 1.11"
  required_providers {
    fly = { source = "ampbase-io/fly" }
  }
}

variable "org" { type = string }
variable "edge_app" { type = string }

variable "control_url" {
  description = "CONTROL_URL: the control plane's internal listener on the private network."
  type        = string
}

variable "edge_token" {
  description = "EDGE_TOKEN, the same value the control plane has."
  type        = string
  sensitive   = true
}

variable "edge_token_version" {
  description = "A non-secret marker that changes with the token."
  type        = string
}

variable "play_domains" {
  description = "PLAY_DOMAIN, then each of PLAY_DOMAIN_ALIASES: <slug>.<domain> reaches the edge."
  type        = list(string)
}

variable "web_origin" {
  description = "WEB_CANONICAL_ORIGIN: where a play address opened in a browser is sent."
  type        = string
}

resource "fly_app" "edge" {
  name = var.edge_app
  org  = var.org
}

# Minecraft clients dial a hostname on TCP 25565; a dedicated IPv4 keeps them off shared addresses
# that other apps' ports could collide with.
resource "fly_ip" "v4" {
  app  = fly_app.edge.name
  type = "public_v4"
}

resource "fly_ip" "v6" {
  app  = fly_app.edge.name
  type = "public_v6"
}

resource "fly_secret" "control_url" {
  app              = fly_app.edge.name
  name             = "CONTROL_URL"
  value_wo         = var.control_url
  value_wo_version = var.control_url
}

resource "fly_secret" "edge_token" {
  app              = fly_app.edge.name
  name             = "EDGE_TOKEN"
  value_wo         = var.edge_token
  value_wo_version = var.edge_token_version
}

# Where a play address opened in a browser goes (apps/edge/browser-redirect.ts). Neither is secret,
# but the edge reads its settings as Fly secrets, as it does CONTROL_URL.
resource "fly_secret" "web_origin" {
  app              = fly_app.edge.name
  name             = "WEB_CANONICAL_ORIGIN"
  value_wo         = var.web_origin
  value_wo_version = var.web_origin
}

resource "fly_secret" "play_domains" {
  app              = fly_app.edge.name
  name             = "PLAY_DOMAINS"
  value_wo         = join(",", var.play_domains)
  value_wo_version = join(",", var.play_domains)
}

# Fly's certificate for every <slug>.<domain>, which its proxy serves on 443 to a browser. A
# wildcard is issued only over DNS-01: the CNAME at its _acme-challenge name, which modules/dns
# makes, hands the challenge to Fly.
resource "fly_cert" "play" {
  for_each = toset(var.play_domains)
  app      = fly_app.edge.name
  hostname = "*.${each.key}"
}

output "ipv4" {
  value = fly_ip.v4.address
}

output "ipv6" {
  value = fly_ip.v6.address
}

output "play_challenges" {
  description = "Each play domain's DNS-01 challenge record: a CNAME from name to target."
  value = { for domain, cert in fly_cert.play : domain => {
    name   = cert.acme_challenge_name
    target = cert.acme_challenge_target
  } }
}
