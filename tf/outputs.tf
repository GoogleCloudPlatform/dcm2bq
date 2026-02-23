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

output "gcs_bucket_name" {
  description = "The name of the GCS bucket for DICOM files."
  value       = local.bucket_name
}

output "cloud_run_service_url" {
  description = "The URL of the deployed dcm2bq Cloud Run service."
  value       = google_cloud_run_v2_service.dcm2bq_service.uri
}

output "bigquery_instances_table" {
  description = "The ID of the BigQuery instances table."
  value       = google_bigquery_table.instances_table.id
}

output "bigquery_dead_letter_table" {
  description = "The ID of the BigQuery dead-letter table."
  value       = google_bigquery_table.dead_letter_table.id
}

output "gcs_processed_data_bucket_name" {
  description = "The name of the GCS bucket for processed data (extracted images and text)."
  value       = google_storage_bucket.processed_data_bucket.name
}

output "bq_dataset_id" {
  description = "The ID of the BigQuery dataset."
  value       = google_bigquery_dataset.dicom_dataset.dataset_id
}

output "bq_instances_table_id" {
  description = "The ID of the BigQuery instances table (includes embeddings)."
  value       = google_bigquery_table.instances_table.table_id
}

output "pubsub_topic_name" {
  description = "The name of the main Pub/Sub topic for GCS events."
  value       = google_pubsub_topic.gcs_events.name
}

output "pubsub_dead_letter_topic_name" {
  description = "The name of the dead letter Pub/Sub topic."
  value       = google_pubsub_topic.dead_letter_topic.name
}

output "project_id" {
  description = "The GCP project ID."
  value       = var.project_id
}

output "region" {
  description = "The GCP region."
  value       = var.region
}

output "admin_console_cloud_run_service_url" {
  description = "Cloud Run URL for admin-console service (only when deployed)."
  value       = var.deploy_admin_console ? google_cloud_run_v2_service.admin_console_service[0].uri : null
}

output "admin_console_service_name" {
  description = "Cloud Run service name for admin-console (only when deployed)."
  value       = var.deploy_admin_console ? google_cloud_run_v2_service.admin_console_service[0].name : null
}

output "admin_console_iap_lb_ip" {
  description = "Deprecated: legacy LB-IAP IP is not used with Cloud Run native IAP."
  value       = null
}
