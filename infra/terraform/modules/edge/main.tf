# The edge (§12, infra/fly/edge.toml): the app, its public addresses, which the play domains'
# wildcard records point at, and how it reaches the control plane.

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

output "ipv4" {
  value = fly_ip.v4.address
}

output "ipv6" {
  value = fly_ip.v6.address
}
