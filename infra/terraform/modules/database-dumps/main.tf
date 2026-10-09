# Production's nightly database dumps (.github/workflows/database-dump.yml): a private R2 bucket
# that deletes each dump 30 days after it was written. No app reads it. Its S3 credentials are an
# R2 API token made in the dashboard for this bucket alone, kept in production.env and handed to the
# workflow's GitHub environment by production.ts.

terraform {
  required_version = ">= 1.11"
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare" }
  }
}

variable "account_id" { type = string }

variable "bucket" { type = string }

variable "keep_days" {
  description = "How long a dump is kept."
  type        = number
  default     = 30
}

# The database is in eu-central-1, and its dumps stay in Western Europe beside it.
resource "cloudflare_r2_bucket" "dumps" {
  account_id = var.account_id
  name       = var.bucket
  location   = "weur"
}

# These rules replace R2's default one, so an upload left unfinished is still cleared after a day.
resource "cloudflare_r2_bucket_lifecycle" "dumps" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.dumps.name
  rules = [{
    id         = "Delete dumps after ${var.keep_days} days"
    enabled    = true
    conditions = { prefix = "" }
    delete_objects_transition = {
      condition = { type = "Age", max_age = var.keep_days * 86400 }
    }
    abort_multipart_uploads_transition = {
      condition = { type = "Age", max_age = 86400 }
    }
  }]
}
