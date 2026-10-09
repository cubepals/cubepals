# The archive store (§15.4, optional per deployment): an R2 bucket, open to presigned uploads
# from the web origin. Its S3 credentials are an R2 API token made in the dashboard and handed to
# the control plane as ARCHIVE_S3_ACCESS_KEY_ID / ARCHIVE_S3_SECRET_ACCESS_KEY secrets.

terraform {
  required_version = ">= 1.11"
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare" }
  }
}

variable "account_id" { type = string }

variable "bucket" {
  description = "ARCHIVE_S3_BUCKET."
  type        = string
}

variable "web_origin" {
  description = "WEB_CANONICAL_ORIGIN: browsers PUT uploads straight into the bucket from it."
  type        = string
}

resource "cloudflare_r2_bucket" "archive" {
  account_id = var.account_id
  name       = var.bucket
}

resource "cloudflare_r2_bucket_cors" "archive" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.archive.name
  rules = [{
    allowed = {
      methods = ["PUT"]
      origins = [var.web_origin]
      headers = ["*"]
    }
    max_age_seconds = 3600
  }]
}

output "endpoint" {
  description = "ARCHIVE_S3_ENDPOINT."
  value       = "https://${var.account_id}.r2.cloudflarestorage.com"
}
