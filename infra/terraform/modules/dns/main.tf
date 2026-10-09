# DNS for an environment (§11 hostname audit): the web hosts to Vercel, wildcard A/AAAA records
# for the play domain and each alias to the edge, and the realtime hostname's A record, with no
# AAAA (§19.6). Every record is DNS-only: Cloudflare's proxy carries neither Minecraft's TCP nor
# WebTransport's UDP, and Vercel issues the web hosts' certificates itself.

terraform {
  required_version = ">= 1.11"
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare" }
  }
}

variable "zone_id" {
  description = "The Cloudflare zone holding the environment's hostnames."
  type        = string
}

variable "play_domains" {
  description = "PLAY_DOMAIN, then each of PLAY_DOMAIN_ALIASES: <slug>.<domain> reaches the edge."
  type        = list(string)
}

variable "edge_ipv4" { type = string }
variable "edge_ipv6" { type = string }

variable "realtime_hostname" { type = string }
variable "realtime_ipv4" { type = string }

variable "web_hostnames" {
  description = "The web app's domain, then the hosts that redirect to it, all served by the Vercel project."
  type        = list(string)
}

# Vercel's own name for every project's domains. At the zone's apex Cloudflare flattens it into
# the addresses it resolves to, so one record type serves both cubepals.com and a subdomain.
resource "cloudflare_dns_record" "web" {
  for_each = toset(var.web_hostnames)
  zone_id  = var.zone_id
  name     = each.key
  type     = "CNAME"
  content  = "cname.vercel-dns.com"
  ttl      = 300
  proxied  = false
  comment  = "The web app, on Vercel"
}

resource "cloudflare_dns_record" "play_v4" {
  for_each = toset(var.play_domains)
  zone_id  = var.zone_id
  name     = "*.${each.key}"
  type     = "A"
  content  = var.edge_ipv4
  ttl      = 300
  proxied  = false
  comment  = "Minecraft players join <slug>.${each.key} through the edge"
}

resource "cloudflare_dns_record" "play_v6" {
  for_each = toset(var.play_domains)
  zone_id  = var.zone_id
  name     = "*.${each.key}"
  type     = "AAAA"
  content  = var.edge_ipv6
  ttl      = 300
  proxied  = false
  comment  = "Minecraft players join <slug>.${each.key} through the edge"
}

resource "cloudflare_dns_record" "realtime" {
  zone_id = var.zone_id
  name    = var.realtime_hostname
  type    = "A"
  content = var.realtime_ipv4
  ttl     = 300
  proxied = false
  comment = "Realtime: WebTransport over UDP on this IPv4 only, so no AAAA"
}
