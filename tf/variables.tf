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

variable "project_id" {
  description = "The GCP project ID."
  type        = string
}

variable "region" {
  description = "The GCP region for deployment."
  type        = string
  default     = "us-central1"
}

variable "create_gcs_bucket" {
  description = "Set to true to create a new GCS bucket."
  type        = bool
  default     = true
}

variable "gcs_bucket_name" {
  description = "Name of the GCS bucket for DICOM files. If not provided, a new one is created."
  type        = string
  default     = ""
}

variable "bq_dataset_id" {
  description = "The BigQuery dataset ID."
  type        = string
  default     = ""
}

variable "bq_instances_table_id" {
  description = "BigQuery table id for DICOM instances"
  type        = string
  default     = ""
}

variable "bq_dead_letter_table_id" {
  description = "The BigQuery table ID for dead-letter Pub/Sub messages."
  type        = string
  default     = ""
}

variable "dcm2bq_image" {
  description = "The Docker image for the dcm2bq service. Must be provided via deploy.sh or -var flag with version from dcm2bq package.json."
  type        = string
}

variable "bq_location" {
  description = "BigQuery dataset location (multi-region like US)"
  type        = string
  default     = "US"
}

variable "debug_mode" {
  description = "Enable debug mode with verbose logging in Cloud Run service"
  type        = bool
  default     = false
}

variable "create_embedding_input" {
  description = "Create embedding input files (extract images/text to GCS)"
  type        = bool
  default     = true
}

variable "create_embeddings" {
  description = "Generate vector embeddings from extracted content"
  type        = bool
  default     = true
}

variable "deploy_admin_console" {
  description = "Deploy standalone admin-console service"
  type        = bool
  default     = true
}

variable "admin_console_image" {
  description = "The Docker image for the admin-console service. Must be provided via deploy.sh or -var flag with version from admin-console package.json."
  type        = string
}

variable "admin_console_service_name" {
  description = "Cloud Run service name for admin-console"
  type        = string
  default     = "dcm2bq-admin-console"
}

variable "admin_console_bq_instances_view_id" {
  description = "BigQuery instances view for admin-console (format: projectId.dataset.table)"
  type        = string
  default     = ""
}

variable "admin_console_bq_dead_letter_table_id" {
  description = "BigQuery dead letter table for admin-console (format: projectId.dataset.table)"
  type        = string
  default     = ""
}
