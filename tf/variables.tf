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

variable "gcs_bucket_name" {
  description = "Name of the GCS bucket for DICOM files. If not provided, a new one is created."
  type        = string
  default     = ""
}

variable "create_gcs_bucket" {
  description = "Set to true to create a new GCS bucket."
  type        = bool
  default     = true
}

variable "bq_dataset_id" {
  description = "The BigQuery dataset ID."
  type        = string
  default     = ""
}

variable "bq_metadata_table_id" {
  description = "The BigQuery table ID for DICOM metadata."
  type        = string
  default     = ""
}

variable "bq_dead_letter_table_id" {
  description = "The BigQuery table ID for dead-letter Pub/Sub messages."
  type        = string
  default     = ""
}

variable "dcm2bq_image" {
  description = "The Docker image for the dcm2bq service."
  type        = string
  default     = "jasonklotzer/dcm2bq:1.1.2"
}
