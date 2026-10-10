# SPDX-FileCopyrightText: 2026 The Cubepals Authors
#
# SPDX-License-Identifier: AGPL-3.0-only

# One fleet node on Hetzner Cloud (docs/fleet-operations.md §2): a server on the deployment's
# private network, a firewall that keeps its public side shut, and cloud-init that runs the join
# line `bun scripts/fleet.ts add` minted for it. blocklyd works out the rest on the host.
#
# The line runs once, at first boot, and its token works once, within the hour. A later apply
# without it changes nothing here (user_data is read only at creation): the node is in already.
#
# Not for the private network itself: one per deployment, which the stack makes or is given.

terraform {
  required_version = ">= 1.11"
  required_providers {
    hcloud = { source = "hetznercloud/hcloud" }
  }
}

variable "name" {
  description = "The server's name, and so the host's name, which the fleet lists the node by."
  type        = string
}

variable "location" {
  description = "A Hetzner location: fsn1, nbg1, hel1, ash, hil or sin."
  type        = string
}

variable "type" {
  description = "A Hetzner server type, such as ccx33."
  type        = string
}

variable "network_id" {
  description = "The deployment's private network, with a subnet in this location's zone."
  type        = number
}

variable "private_range" {
  description = "The private network's range: the only source the node's API and game ports admit."
  type        = string
}

variable "join_line" {
  description = "The line `fleet.ts token` prints, run as root at first boot. Empty: nothing joins."
  type        = string
  sensitive   = true
  default     = ""
}

variable "ssh_keys" {
  description = "SSH keys already in the project, for root. With none, Hetzner emails a root password."
  type        = list(string)
  default     = []
}

variable "api_port" {
  description = "blocklyd's API port (api.listen)."
  type        = number
  default     = 7443
}

variable "port_range" {
  description = "blocklyd's network.port_range: the game, console and status ports."
  type        = tuple([number, number])
  default     = [42000, 42999]
}

variable "edge_sources" {
  description = "Public addresses of an edge that reaches nodes over the internet; none when it is on the private network."
  type        = list(string)
  default     = []
}

locals {
  ports = "${var.port_range[0]}-${var.port_range[1]}"
  # The private network's interface can come up a little after cloud-init starts, so the line is
  # tried again for a few minutes. Running it again on a host that joined changes nothing.
  user_data = var.join_line == "" ? join("\n", [
    "#!/bin/sh",
    "echo 'blockly: this host was made without a join line. Run bun scripts/fleet.ts token <region> and paste its line here, as root.' >&2",
    "",
    ]) : join("\n", [
    "#!/bin/sh",
    "for try in $(seq 1 30); do",
    "  (${var.join_line}) && exit 0",
    "  echo \"blockly: joining didn't work yet (try $try of 30); trying again in 10 seconds\" >&2",
    "  sleep 10",
    "done",
    "exit 1",
    "",
  ])
}

# Hetzner's firewalls filter only the public side: traffic on the private network always passes.
# So the rules from the private range say what the node serves there, and in effect the public
# side admits nothing, unless the edge is out on the internet.
resource "hcloud_firewall" "node" {
  name   = var.name
  labels = { blockly = "fleet-node" }

  rule {
    description = "blocklyd's API, for the control plane"
    direction   = "in"
    protocol    = "tcp"
    port        = tostring(var.api_port)
    source_ips  = [var.private_range]
  }

  rule {
    description = "game, console and status ports, for the edge and the control plane"
    direction   = "in"
    protocol    = "tcp"
    port        = local.ports
    source_ips  = [var.private_range]
  }

  dynamic "rule" {
    for_each = length(var.edge_sources) > 0 ? [1] : []
    content {
      description = "game ports, for an edge on the internet"
      direction   = "in"
      protocol    = "tcp"
      port        = local.ports
      source_ips  = var.edge_sources
    }
  }
}

resource "hcloud_server" "node" {
  name         = var.name
  server_type  = var.type
  location     = var.location
  image        = "ubuntu-24.04"
  ssh_keys     = var.ssh_keys
  firewall_ids = [hcloud_firewall.node.id]
  user_data    = local.user_data
  labels       = { blockly = "fleet-node" }

  # A public address stays, for the host's own way out (Docker, images, the archive store).
  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }

  network {
    network_id = var.network_id
  }

  lifecycle {
    # The join line is spent at first boot, and a new one would rebuild the host.
    ignore_changes = [user_data, image, ssh_keys]
  }
}

output "id" {
  value = hcloud_server.node.id
}

output "private_ip" {
  value = one(hcloud_server.node.network[*].ip)
}

output "public_ipv4" {
  value = hcloud_server.node.ipv4_address
}
