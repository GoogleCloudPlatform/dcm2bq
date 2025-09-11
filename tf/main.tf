resource "google_cloud_run_v2_service_iam_member" "allow_cloudrun_sa_invoke" {
  project  = google_cloud_run_v2_service.dcm2bq_service.project
  location = google_cloud_run_v2_service.dcm2bq_service.location
  name     = google_cloud_run_v2_service.dcm2bq_service.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.cloudrun_sa.email}"
}
output "dicom_bucket_name" {
  value = local.bucket_name
}
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

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

resource "random_string" "bucket_suffix" {
  length  = 8
  special = false
  upper   = false
}

resource "google_storage_bucket" "dicom_bucket" {
  count = var.create_gcs_bucket ? 1 : 0

  name                        = var.gcs_bucket_name == "" ? "dcm2bq-dicom-bucket-${random_string.bucket_suffix.result}" : var.gcs_bucket_name
  location                    = var.region
  force_destroy               = true
  uniform_bucket_level_access = true
}

data "google_storage_bucket" "existing_dicom_bucket" {
  count = var.create_gcs_bucket ? 0 : 1
  name  = var.gcs_bucket_name
}

locals {
  bucket_name = var.create_gcs_bucket ? google_storage_bucket.dicom_bucket[0].name : data.google_storage_bucket.existing_dicom_bucket[0].name
}

resource "google_pubsub_topic" "gcs_events" {
  name = "dcm2bq-gcs-events"
}

resource "google_storage_notification" "bucket_notification" {
  bucket         = local.bucket_name
  payload_format = "JSON_API_V1"
  topic          = google_pubsub_topic.gcs_events.id
  event_types    = ["OBJECT_FINALIZE", "OBJECT_DELETE", "OBJECT_ARCHIVE", "OBJECT_METADATA_UPDATE"]
}

resource "google_bigquery_dataset" "dicom_dataset" {
  dataset_id = "${var.bq_dataset_id}_${random_string.bucket_suffix.result}"
  location   = var.region
}

resource "google_bigquery_table" "metadata_table" {
  deletion_protection = false
  dataset_id = google_bigquery_dataset.dicom_dataset.dataset_id
  table_id   = "${var.bq_metadata_table_id}_${random_string.bucket_suffix.result}"
  schema = file("${path.module}/init.schema.json")
}

resource "google_bigquery_table" "metadata_view" {
  deletion_protection = false
  dataset_id = google_bigquery_dataset.dicom_dataset.dataset_id
  table_id   = "metadata_view_${random_string.bucket_suffix.result}"
  view {
    query = <<EOT
SELECT
  * EXCEPT(_row_id)
FROM (
  SELECT
    ROW_NUMBER() OVER (PARTITION BY path, version ORDER BY timestamp DESC) AS _row_id,
    *
  FROM
    `${google_bigquery_dataset.dicom_dataset.dataset_id}.${google_bigquery_table.metadata_table.table_id}`
)
WHERE
  _row_id = 1
  AND metadata IS NOT NULL
EOT
    use_legacy_sql = false
  }
}

resource "google_pubsub_topic" "dead_letter_topic" {
  name = "dcm2bq-dead-letter-events"
}

resource "google_bigquery_table" "dead_letter_table" {
  deletion_protection = false
  dataset_id = google_bigquery_dataset.dicom_dataset.dataset_id
  table_id   = var.bq_dead_letter_table_id
  schema = jsonencode([
    {
      name = "data"
      type = "BYTES"
    },
    {
      name = "attributes"
      type = "STRING"
    },
    {
      name = "message_id"
      type = "STRING"
    },
    {
      name = "subscription_name"
      type = "STRING"
    },
    {
      name = "publish_time"
      type = "TIMESTAMP"
    }
  ])
}

resource "google_pubsub_subscription" "dead_letter_subscription" {
  provider = google-beta
  name     = "dcm2bq-dead-letter-bq-subscription"
  topic    = google_pubsub_topic.dead_letter_topic.name

  bigquery_config {
    table = "${google_bigquery_table.dead_letter_table.project}:${google_bigquery_table.dead_letter_table.dataset_id}.${google_bigquery_table.dead_letter_table.table_id}"
    use_topic_schema = false
    write_metadata = true
  }
}

resource "google_service_account" "cloudrun_sa" {
  account_id   = "dcm2bq-cloudrun-sa"
  display_name = "dcm2bq Cloud Run Service Account"
}

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

resource "google_cloud_run_v2_service" "dcm2bq_service" {
  deletion_protection = false
  name     = "dcm2bq-service"
  location = var.region

  template {
    service_account = google_service_account.cloudrun_sa.email
    containers {
      image = var.dcm2bq_image
      env {
        name  = "DCM2BQ_CONFIG"
        value = jsonencode({
          gcpConfig = {
            projectId = var.project_id
            location  = var.region
            bigQuery = {
              datasetId = var.bq_dataset_id
              tableId   = var.bq_metadata_table_id
            }
            embeddings = {
              enabled = true
              model   = "multimodalembedding@001"
              summarizeText = {
                enabled = true
                model   = "gemini-2.5-flash-lite"
              }
            }
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
        })
      }
    }
  }
}

resource "google_cloud_run_v2_service_iam_member" "allow_pubsub_invoke" {
  project  = google_cloud_run_v2_service.dcm2bq_service.project
  location = google_cloud_run_v2_service.dcm2bq_service.location
  name     = google_cloud_run_v2_service.dcm2bq_service.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:service-${data.google_project.project.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

data "google_project" "project" {}

resource "google_pubsub_subscription" "gcs_to_cloudrun" {
  name  = "dcm2bq-gcs-to-cloudrun-subscription"
  topic = google_pubsub_topic.gcs_events.name

  push_config {
    push_endpoint = google_cloud_run_v2_service.dcm2bq_service.uri
    oidc_token {
      service_account_email = google_service_account.cloudrun_sa.email
    }
  }

  dead_letter_policy {
    dead_letter_topic = google_pubsub_topic.dead_letter_topic.id
    max_delivery_attempts = 5
  }

  depends_on = [google_cloud_run_v2_service_iam_member.allow_pubsub_invoke]
}

resource "google_project_iam_member" "gcs_pubsub_publisher" {
  project = var.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:service-${data.google_project.project.number}@gs-project-accounts.iam.gserviceaccount.com"
}

resource "google_project_iam_member" "pubsub_bq_writer" {
  project = var.project_id
  role    = "roles/bigquery.dataEditor"
  member  = "serviceAccount:service-${data.google_project.project.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}