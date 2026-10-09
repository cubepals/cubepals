# One Fly organization per environment (§16): its apps' names, and its machine limit, which the
# control plane enforces against platform_controls.maxServers (§19.12): admins set that in the
# database, so the check lives where the number does.

terraform {
  required_version = ">= 1.11"
}

variable "org" {
  description = "The environment's Fly organization slug."
  type        = string
}

variable "deployment_id" {
  description = "DEPLOYMENT_ID: names apps and provider resources, and is the ticket audience."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9-]{2,16}$", var.deployment_id))
    error_message = "A deployment id is 2 to 16 lowercase letters, digits or dashes."
  }
}

variable "machine_limit" {
  description = "The organization's machine limit, as Fly support set it."
  type        = number
}


variable "platform_machines" {
  description = "Machines the platform itself runs: one each of api, worker, realtime and edge."
  type        = number
  default     = 4
}

locals {
  apps = {
    control  = "bly-${var.deployment_id}-control"
    realtime = "bly-${var.deployment_id}-realtime"
    edge     = "bly-${var.deployment_id}-edge"
  }
}

# Restores, exports and relocations briefly run a second machine beside a server's own, so
# each server needs two. The limit must leave room for at least one.
resource "terraform_data" "machine_headroom" {
  input = floor((var.machine_limit - var.platform_machines) / 2)
  lifecycle {
    precondition {
      condition     = var.machine_limit - var.platform_machines >= 2
      error_message = "The org's machine limit (${var.machine_limit}) leaves no room for a server beside the platform's ${var.platform_machines} machines. Ask Fly for a higher limit."
    }
  }
}

output "machine_limit" {
  value = var.machine_limit
}

output "platform_machines" {
  value = var.platform_machines
}

output "org" {
  value = var.org
}

output "apps" {
  description = "The environment's app names."
  value       = local.apps
}
