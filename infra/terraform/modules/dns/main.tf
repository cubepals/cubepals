# DNS for an environment (§11 hostname audit): the web hosts, wildcard A/AAAA records for the play
# domain and each alias to the edge, and the realtime hostname's A record, with no AAAA (§19.6).
# Every record but the web hosts' is DNS-only: Cloudflare's proxy carries neither Minecraft's TCP
# nor WebTransport's UDP. The web hosts are proxied once web_proxied says so, which hands them to
# the Worker's routes (modules/web).

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

variable "realtime_validation" {
  description = "The record Fly checks before it issues the realtime hostname's certificate."
  type = object({
    ownership_name  = string
    ownership_value = string
  })
}

variable "web_hostnames" {
  description = "The web app's domain, then the hosts that redirect to it."
  type        = list(string)
}

variable "web_proxied" {
  description = "Whether the web hosts go through Cloudflare's proxy to the Worker's routes. False leaves them DNS-only."
  type        = bool
  default     = false
}

# Proxied, Cloudflare answers the records itself, with the zone's certificate, and the Worker's
# routes take every path, so the CNAME's target is never asked. DNS-only, browsers go to that
# target, which no longer serves the site. At the zone's apex Cloudflare flattens the CNAME, so one
# record type serves both.
#
# The target is the host that served the site before the Worker. Cloudflare's placeholder for a
# host only a Worker answers is a proxied AAAA to 100:: (staging.ts makes staging's that way), but
# a record's type can't change in place: Terraform would delete each record and make it again,
# and in between the name doesn't resolve, with resolvers keeping that answer for the zone's
# negative-cache time. So the CNAME stays.
resource "cloudflare_dns_record" "web" {
  for_each = toset(var.web_hostnames)
  zone_id  = var.zone_id
  name     = each.key
  type     = "CNAME"
  content  = "cname.vercel-dns.com"
  # A proxied record's TTL is Cloudflare's own ("automatic", 1).
  ttl     = var.web_proxied ? 1 : 300
  proxied = var.web_proxied
  comment = var.web_proxied ? "The web app, through the Worker's routes" : "The web app, DNS-only"
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

# Fly's certificate for the realtime hostname's TCP fallback: with no AAAA record, this TXT shows
# Fly the app owns the name. Fly validates over HTTP-01, never through an _acme-challenge CNAME:
# the realtime role writes its own DNS-01 TXT there, which Cloudflare refuses beside a CNAME.
resource "cloudflare_dns_record" "realtime_ownership" {
  zone_id = var.zone_id
  name    = var.realtime_validation.ownership_name
  type    = "TXT"
  content = "\"${var.realtime_validation.ownership_value}\""
  ttl     = 300
  proxied = false
  comment = "Fly: the realtime app owns this hostname"
}
