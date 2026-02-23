# Copyright 2025 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

terraform {
  required_version = ">= 1.0"
  required_providers {
    google      = { source = "hashicorp/google", version = "~> 7.0" }
    google-beta = { source = "hashicorp/google-beta", version = "~> 7.0" }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

data "google_project" "project" {}

# Enable required APIs
resource "google_project_service" "cloudrun_api" {
  service            = "run.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "pubsub_api" {
  service            = "pubsub.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "storage_api" {
  service            = "storage.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "bigquery_api" {
  service            = "bigquery.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "aiplatform_api" {
  service            = "aiplatform.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "compute_api" {
  service            = "compute.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "iap_api" {
  service            = "iap.googleapis.com"
  disable_on_destroy = false
}

data "google_storage_bucket" "existing_dicom_bucket" {
  count = var.create_gcs_bucket ? 0 : 1
  name  = var.gcs_bucket_name
}

resource "random_string" "bucket_suffix" {
  length  = 8
  special = false
  upper   = false
}

locals {
  bucket_name = var.create_gcs_bucket ? google_storage_bucket.dicom_bucket[0].name : data.google_storage_bucket.existing_dicom_bucket[0].name

  # Build embedding configuration dynamically based on flags
  embedding_config = var.create_embedding_input ? {
    input = merge(
      {
        gcsBucketPath = "gs://${google_storage_bucket.processed_data_bucket.name}"
        summarizeText = {
          model     = "gemini-2.5-flash-lite"
          maxLength = 1024
        }
      },
      var.create_embeddings ? {
        vector = {
          model = "multimodalembedding@001"
        }
      } : {}
    )
  } : {}

  # Complete DCM2BQ configuration
  dcm2bq_config = {
    gcpConfig = {
      projectId = var.project_id
      location  = var.region
      bigQuery = {
        datasetId        = google_bigquery_dataset.dicom_dataset.dataset_id
        instancesTableId = google_bigquery_table.instances_table.table_id
      }
      embedding = local.embedding_config
    }
    dicomParser = {}
    jsonOutput = {
      useArrayWithSingleValue = false
      ignoreGroupLength       = true
      ignoreMetaHeader        = false
      ignorePrivate           = false
      ignoreBinary            = false
      useCommonNames          = true
      explicitBulkDataRoot    = false
    }
  }

  deploy_admin_console = var.deploy_admin_console

  admin_console_instances_view_id = var.admin_console_bq_instances_view_id != "" ? var.admin_console_bq_instances_view_id : "${var.project_id}.${google_bigquery_dataset.dicom_dataset.dataset_id}.${google_bigquery_table.instances_view.table_id}"
  admin_console_instances_table_id = "${var.project_id}.${google_bigquery_dataset.dicom_dataset.dataset_id}.${google_bigquery_table.instances_table.table_id}"
  admin_console_dead_letter_table_id = var.admin_console_bq_dead_letter_table_id != "" ? var.admin_console_bq_dead_letter_table_id : "${var.project_id}.${google_bigquery_dataset.dicom_dataset.dataset_id}.${google_bigquery_table.dead_letter_table.table_id}"
}

# GCS bucket (optional create)
resource "google_storage_bucket" "dicom_bucket" {
  count                       = var.create_gcs_bucket ? 1 : 0
  name                        = var.gcs_bucket_name != "" ? var.gcs_bucket_name : "dcm2bq-dicom-bucket-${random_string.bucket_suffix.result}"
  location                    = var.region
  force_destroy               = true
  uniform_bucket_level_access = true

  versioning {
    enabled = true
  }
}

# GCS bucket for processed data (images and text extracted from DICOM)
# This must be separate from the DICOM bucket to avoid triggering events when processed files are created
resource "google_storage_bucket" "processed_data_bucket" {
  name                        = "dcm2bq-processed-data-${random_string.bucket_suffix.result}"
  location                    = var.region
  force_destroy               = true
  uniform_bucket_level_access = true
}

# BigQuery dataset and tables
resource "google_bigquery_dataset" "dicom_dataset" {
  dataset_id = var.bq_dataset_id != "" ? var.bq_dataset_id : "dicom_${random_string.bucket_suffix.result}"
  # BigQuery dataset location (use bq_location variable, default US)
  location = var.bq_location
}

resource "google_bigquery_table" "instances_table" {
  deletion_protection = false
  dataset_id          = google_bigquery_dataset.dicom_dataset.dataset_id
  table_id            = var.bq_instances_table_id != "" ? var.bq_instances_table_id : "instances"
  schema              = file("${path.module}/init.schema.json")
}

// Fixes issue https://github.com/GoogleCloudPlatform/dcm2bq/issues/23
resource "google_bigquery_table" "instances_view" {
  deletion_protection = false
  dataset_id          = google_bigquery_dataset.dicom_dataset.dataset_id
  table_id            = "instancesView"

  view {
    query          = <<-EOT
      WITH latest_by_path AS (
        SELECT
          ROW_NUMBER() OVER (PARTITION BY path, version ORDER BY timestamp DESC) AS _row_id,
          *
        FROM
          `${google_bigquery_dataset.dicom_dataset.dataset_id}.${google_bigquery_table.instances_table.table_id}`
      )
      SELECT
        l.* EXCEPT(_row_id)
      FROM
        latest_by_path l
      WHERE
        l._row_id = 1
        AND l.metadata IS NOT NULL
        AND NOT EXISTS (
          SELECT
            1
          FROM
            `${google_bigquery_dataset.dicom_dataset.dataset_id}.${google_bigquery_table.instances_table.table_id}` tombstone
          WHERE
            tombstone.path = SPLIT(l.path, '#')[SAFE_OFFSET(0)]
            AND tombstone.version = l.version
            AND tombstone.metadata IS NULL
            AND tombstone.timestamp >= l.timestamp
        )
    EOT
    use_legacy_sql = false
  }
}

resource "google_bigquery_table" "dead_letter_table" {
  deletion_protection = false
  dataset_id          = google_bigquery_dataset.dicom_dataset.dataset_id
  table_id            = var.bq_dead_letter_table_id != "" ? var.bq_dead_letter_table_id : "dead_letter"
  schema = jsonencode([
    { name = "data", type = "BYTES" },
    { name = "attributes", type = "STRING" },
    { name = "message_id", type = "STRING" },
    { name = "subscription_name", type = "STRING" },
    { name = "publish_time", type = "TIMESTAMP" }
  ])
}

# Pub/Sub topics
resource "google_pubsub_topic" "gcs_events" { name = "dcm2bq-gcs-events" }
resource "google_pubsub_topic" "dead_letter_topic" { name = "dcm2bq-dead-letter-events" }

# Grant the GCS service account permission to publish to the Pub/Sub topic
# This service account is automatically created when the Storage API is enabled
resource "google_pubsub_topic_iam_member" "gcs_events_publisher" {
  topic  = google_pubsub_topic.gcs_events.name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:service-${data.google_project.project.number}@gs-project-accounts.iam.gserviceaccount.com"

  depends_on = [
    google_project_service.storage_api,
    google_project_service.pubsub_api
  ]
}

# Service account for Cloud Run
resource "google_service_account" "cloudrun_sa" {
  account_id   = "dcm2bq-cloudrun-sa"
  display_name = "dcm2bq Cloud Run Service Account"
}

resource "google_service_account" "admin_console_sa" {
  count = local.deploy_admin_console ? 1 : 0

  account_id   = "dcm2bq-admin-console-sa"
  display_name = "dcm2bq admin-console Cloud Run Service Account"
}

# IAM grants for admin-console (BigQuery and GCS access)
resource "google_project_iam_member" "admin_console_sa_bq_job_user" {
  count  = local.deploy_admin_console ? 1 : 0
  project = var.project_id
  role    = "roles/bigquery.jobUser"
  member  = "serviceAccount:${google_service_account.admin_console_sa[0].email}"
}

resource "google_project_iam_member" "admin_console_sa_bq_viewer" {
  count  = local.deploy_admin_console ? 1 : 0
  project = var.project_id
  role    = "roles/bigquery.dataViewer"
  member  = "serviceAccount:${google_service_account.admin_console_sa[0].email}"
}

resource "google_project_iam_member" "admin_console_sa_bq_editor" {
  count  = local.deploy_admin_console ? 1 : 0
  project = var.project_id
  role    = "roles/bigquery.dataEditor"
  member  = "serviceAccount:${google_service_account.admin_console_sa[0].email}"
}

resource "google_project_iam_member" "admin_console_sa_gcs_viewer" {
  count  = local.deploy_admin_console ? 1 : 0
  project = var.project_id
  role    = "roles/storage.objectViewer"
  member  = "serviceAccount:${google_service_account.admin_console_sa[0].email}"
}

resource "google_project_iam_member" "admin_console_sa_gcs_writer" {
  count  = local.deploy_admin_console ? 1 : 0
  project = var.project_id
  role    = "roles/storage.objectAdmin"
  member  = "serviceAccount:${google_service_account.admin_console_sa[0].email}"
}

# IAM grants for the Cloud Run service account
resource "google_project_iam_member" "cloudrun_sa_bq_writer" {
  project = var.project_id
  role    = "roles/bigquery.dataEditor"
  member  = "serviceAccount:${google_service_account.cloudrun_sa.email}"
}

resource "google_project_iam_member" "cloudrun_sa_gcs_reader" {
  project = var.project_id
  role    = "roles/storage.objectViewer"
  member  = "serviceAccount:${google_service_account.cloudrun_sa.email}"
}

resource "google_project_iam_member" "cloudrun_sa_gcs_writer" {
  project = var.project_id
  role    = "roles/storage.objectAdmin"
  member  = "serviceAccount:${google_service_account.cloudrun_sa.email}"
}

resource "google_project_iam_member" "cloudrun_sa_vertexai_user" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.cloudrun_sa.email}"
}

# Allow Pub/Sub service to write to BigQuery (used by dead-letter subscription)
resource "google_project_iam_member" "pubsub_bq_writer" {
  project = var.project_id
  role    = "roles/bigquery.dataEditor"
  member  = "serviceAccount:service-${data.google_project.project.number}@gcp-sa-pubsub.iam.gserviceaccount.com"

  depends_on = [google_project_service.pubsub_api]
}


# IAM permissions for dead letter functionality
# Allow Pub/Sub to publish to the dead letter topic
resource "google_pubsub_topic_iam_member" "dead_letter_publisher" {
  topic  = google_pubsub_topic.dead_letter_topic.name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:service-${data.google_project.project.number}@gcp-sa-pubsub.iam.gserviceaccount.com"

  depends_on = [google_project_service.pubsub_api]
}

# Allow Pub/Sub to subscribe to the main subscription (to forward to dead letter)
resource "google_pubsub_subscription_iam_member" "dead_letter_subscriber" {
  subscription = google_pubsub_subscription.gcs_to_cloudrun.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:service-${data.google_project.project.number}@gcp-sa-pubsub.iam.gserviceaccount.com"

  depends_on = [google_pubsub_subscription.gcs_to_cloudrun]
}

# Cloud Run service
resource "google_cloud_run_v2_service" "dcm2bq_service" {
  deletion_protection = false
  name                = "dcm2bq-service-${random_string.bucket_suffix.result}"
  location            = var.region

  depends_on = [google_project_service.cloudrun_api]

  template {
    service_account                  = google_service_account.cloudrun_sa.email
    timeout                          = "3600s" # 1 hour timeout for processing large archive files
    max_instance_request_concurrency = 16      # Process up to 16 files concurrently per instance

    containers {
      image = var.dcm2bq_image
      resources {
        limits = {
          cpu    = "1"   # 1 CPU per instance
          memory = "4Gi" # ~256MB per request with concurrency of 16
        }
      }
      env {
        name  = "DCM2BQ_CONFIG"
        value = jsonencode(local.dcm2bq_config)
      }
      env {
        name  = "DEBUG"
        value = var.debug_mode ? "true" : "false"
      }
    }
  }

  scaling {
    max_instance_count = 100
  }

}

resource "google_cloud_run_v2_service" "admin_console_service" {
  provider = google-beta
  count = local.deploy_admin_console ? 1 : 0

  deletion_protection = false
  name                = "${var.admin_console_service_name}-${random_string.bucket_suffix.result}"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  launch_stage        = "BETA"
  iap_enabled         = true

  depends_on = [
    google_project_service.cloudrun_api,
    google_project_service.iap_api,
  ]

  template {
    service_account = google_service_account.admin_console_sa[0].email
    timeout         = "300s"

    containers {
      image = var.admin_console_image

      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }

      env {
        name  = "BQ_INSTANCES_VIEW_ID"
        value = local.admin_console_instances_view_id
      }

      env {
        name  = "BQ_INSTANCES_TABLE_ID"
        value = local.admin_console_instances_table_id
      }

      env {
        name  = "BQ_DEAD_LETTER_TABLE_ID"
        value = local.admin_console_dead_letter_table_id
      }

      env {
        name  = "BQ_LOCATION"
        value = var.bq_location
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
    }
  }

}

resource "google_cloud_run_v2_service_iam_member" "allow_iap_invoke_admin_console" {
  provider = google-beta
  count = local.deploy_admin_console ? 1 : 0

  project  = google_cloud_run_v2_service.admin_console_service[0].project
  location = google_cloud_run_v2_service.admin_console_service[0].location
  name     = google_cloud_run_v2_service.admin_console_service[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:service-${data.google_project.project.number}@gcp-sa-iap.iam.gserviceaccount.com"
}

# Allow invoker role for Cloud Run
resource "google_cloud_run_v2_service_iam_member" "allow_pubsub_invoke" {
  project  = google_cloud_run_v2_service.dcm2bq_service.project
  location = google_cloud_run_v2_service.dcm2bq_service.location
  name     = google_cloud_run_v2_service.dcm2bq_service.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.cloudrun_sa.email}"
}

# Storage notification to Pub/Sub
# Requires the GCS service account to have publish permission on the topic
resource "google_storage_notification" "bucket_notification" {
  bucket         = local.bucket_name
  payload_format = "JSON_API_V1"
  topic          = google_pubsub_topic.gcs_events.id
  event_types    = ["OBJECT_FINALIZE", "OBJECT_DELETE", "OBJECT_ARCHIVE", "OBJECT_METADATA_UPDATE"]

  depends_on = [
    google_pubsub_topic.gcs_events,
    google_pubsub_topic_iam_member.gcs_events_publisher
  ]
}

# Subscription to push GCS events to Cloud Run
resource "google_pubsub_subscription" "gcs_to_cloudrun" {
  name                       = "dcm2bq-gcs-to-cloudrun-subscription"
  topic                      = google_pubsub_topic.gcs_events.name
  ack_deadline_seconds       = 600      # 10 minutes to process before retry
  message_retention_duration = "86400s" # 1 day

  expiration_policy {
    ttl = ""
  }

  push_config {
    push_endpoint = google_cloud_run_v2_service.dcm2bq_service.uri
    oidc_token { service_account_email = google_service_account.cloudrun_sa.email }
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dead_letter_topic.id
    max_delivery_attempts = 5
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  depends_on = [
    google_cloud_run_v2_service_iam_member.allow_pubsub_invoke,
    google_pubsub_topic.dead_letter_topic,
    google_pubsub_topic_iam_member.dead_letter_publisher
  ]
}

# Dead-letter subscription that writes to BigQuery (requires google-beta)
resource "google_pubsub_subscription" "dead_letter_subscription" {
  provider = google-beta
  name     = "dcm2bq-dead-letter-bq-subscription"
  topic    = google_pubsub_topic.dead_letter_topic.name

  expiration_policy {
    ttl = ""
  }

  bigquery_config {
    table            = "${google_bigquery_table.dead_letter_table.project}:${google_bigquery_table.dead_letter_table.dataset_id}.${google_bigquery_table.dead_letter_table.table_id}"
    use_topic_schema = false
    write_metadata   = true
  }
  depends_on = [google_pubsub_topic.dead_letter_topic, google_project_iam_member.pubsub_bq_writer]
}
