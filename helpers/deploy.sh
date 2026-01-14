#!/bin/bash

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

set -e

# --- Configuration ---
TERRAFORM_VERSION="1.8.0" # Specify a version for consistency
INSTALL_DIR="$HOME/.local/bin"
TF_DIR="$(dirname "$0")/../tf"

# --- Helper Functions ---
function check_command() {
  if ! command -v "$1" &> /dev/null; then
    echo "Error: '$1' command not found. Please install it and ensure it's in your PATH."
    exit 1
  fi
}

function install_terraform() {
  if command -v terraform &> /dev/null && terraform version | grep -q "v${TERRAFORM_VERSION}"; then
    echo "Terraform v${TERRAFORM_VERSION} is already installed."
    return
  fi

  echo "Terraform not found or wrong version. Installing Terraform v${TERRAFORM_VERSION}..."
  mkdir -p "${INSTALL_DIR}"
  
  local os_arch
  os_arch="$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m)"
  case "${os_arch}" in
    linux_x86_64) TERRAFORM_ARCH="linux_amd64" ;;
    darwin_x86_64) TERRAFORM_ARCH="darwin_amd64" ;;
    darwin_arm64) TERRAFORM_ARCH="darwin_arm64" ;;
    *)
      echo "Unsupported OS/architecture: ${os_arch}"
      exit 1
      ;;
  esac

  TERRAFORM_ZIP="terraform_${TERRAFORM_VERSION}_${TERRAFORM_ARCH}.zip"
  TERRAFORM_URL="https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/${TERRAFORM_ZIP}"

  curl -LO "${TERRAFORM_URL}"
  unzip -o "${TERRAFORM_ZIP}" -d "${INSTALL_DIR}"
  rm "${TERRAFORM_ZIP}"
  
  # Verify installation
  if ! command -v terraform &> /dev/null; then
     echo "Please add ${INSTALL_DIR} to your PATH."
     exit 1
  fi
  echo "Terraform installed successfully."
}

# --- Main Script ---

# 1. Check prerequisites
check_command "gcloud"
check_command "gsutil"
check_command "unzip"
check_command "curl"
check_command "jq"
check_command "node"

# 2. Install Terraform
install_terraform

# 3. Validate input and mode

# Parse options (only --help supported). We use subcommands for modes: deploy (default), destroy, upload
while [[ "$1" =~ ^- && ! "$1" == "--" ]]; do
  case $1 in
    -h | --help )
      echo "Usage: $0 [destroy|upload] <gcp_project_id>"
      echo "  upload                   Upload test/files/dcm/*.dcm to the GCS bucket (separate from deploy)."
      echo "  destroy                  Destroy all previously created assets."
      echo "  --help, -h               Show this help message."
      exit 0
      ;;
  esac
  shift
done

if [ "$1" == "destroy" ]; then
  MODE="destroy"
  shift
elif [ "$1" == "upload" ]; then
  MODE="upload"
  shift
else
  MODE="deploy"
fi

if [ -z "$1" ]; then
  echo "Usage: $0 [destroy|upload] <gcp_project_id>"
  exit 1
fi

PROJECT_ID="$1"

# 4. Create GCS bucket for Terraform state
TF_STATE_BUCKET="${PROJECT_ID}-dcm2bq-tfstate"
echo "Configuring Terraform state bucket: gs://${TF_STATE_BUCKET}"
if ! gcloud storage ls "gs://${TF_STATE_BUCKET}" &> /dev/null; then
  echo "Creating GCS bucket for Terraform state..."
  gcloud storage buckets create --project="${PROJECT_ID}" "gs://${TF_STATE_BUCKET}"
  gcloud storage buckets update --versioning "gs://${TF_STATE_BUCKET}"
else
  echo "GCS bucket for Terraform state already exists."
fi

# 5. Create backend.tf file
cat > "${TF_DIR}/backend.tf" << EOL
terraform {
  backend "gcs" {
    bucket = "${TF_STATE_BUCKET}"
    prefix = "terraform/state"
  }
}
EOL

echo "Terraform backend configured."

# 6. Deploy or Destroy Terraform
cd "${TF_DIR}"
echo "Initializing Terraform..."
terraform init

if [ "$MODE" == "destroy" ]; then
  echo "Destroying infrastructure..."
  terraform destroy -auto-approve -var="project_id=${PROJECT_ID}"
  echo "Cleanup complete."
  exit 0
fi

if [ "$MODE" == "deploy" ]; then
  echo "Deploying infrastructure..."
  terraform apply -auto-approve -var="project_id=${PROJECT_ID}"
fi

if [ "$MODE" == "upload" ]; then
  # Upload-only mode: find bucket from Terraform outputs and upload test files
  echo "Uploading test DICOM files to the GCS bucket for project ${PROJECT_ID}..."
  BUCKET_NAME=$(terraform output -raw gcs_bucket_name 2>/dev/null)
  if [ -z "$BUCKET_NAME" ]; then
    echo "Could not determine the GCS bucket name from Terraform output. Ensure Terraform state exists and the project is correct."
    exit 1
  fi
  gcloud storage cp ../test/files/dcm/*.dcm "gs://$BUCKET_NAME/"
  echo "Upload complete."
  exit 0
fi

# 7. Update test/testconfig.json
DATASET_ID=$(terraform output -raw bq_dataset_id)
TABLE_ID=$(terraform output -raw bq_metadata_table_id)
EMBEDDINGS_TABLE_ID=$(terraform output -raw bq_embeddings_table_id 2>/dev/null || terraform output -raw bq_embeddings_table 2>/dev/null || true)
PROCESSED_DATA_BUCKET=$(terraform output -raw gcs_processed_data_bucket_name 2>/dev/null || true)
TEST_CONFIG_FILE="../test/testconfig.json"
TEMP_JSON=$(mktemp)

# Create testconfig.json from defaults if it doesn't exist
if [ ! -f "$TEST_CONFIG_FILE" ]; then
  # Use node to export the defaults module to a JSON file
  node -e "const defaults = require('../src/config.defaults.js'); console.log(JSON.stringify(defaults, null, 2));" > "$TEST_CONFIG_FILE"
fi

jq \
  --arg project_id "$PROJECT_ID" \
  --arg dataset_id "$DATASET_ID" \
  --arg table_id "$TABLE_ID" \
  --arg embeddings_table_id "$EMBEDDINGS_TABLE_ID" \
  --arg gcs_bucket_path "gs://${PROCESSED_DATA_BUCKET}" \
  '.gcpConfig.projectId = $project_id | .gcpConfig.bigQuery.datasetId = $dataset_id | .gcpConfig.bigQuery.metadataTableId = $table_id | .gcpConfig.bigQuery.embeddingsTableId = $embeddings_table_id | .gcpConfig.embeddings.gcsBucketPath = $gcs_bucket_path' \
  "$TEST_CONFIG_FILE" > "$TEMP_JSON" && mv "$TEMP_JSON" "$TEST_CONFIG_FILE"

echo "Updated test/testconfig.json."
