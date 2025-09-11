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
UPLOAD_TEST_DATA=false

# Parse arguments
while [[ "$1" =~ ^- && ! "$1" == "--" ]]; do
  case $1 in
    -u | --upload-test-data ) UPLOAD_TEST_DATA=true ;;
    -h | --help )
      echo "Usage: $0 [--upload-test-data|-u] [destroy] <gcp_project_id>"
      echo "  --upload-test-data, -u   Upload test/files/dcm/*.dcm to the GCS bucket after deploy."
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
else
  MODE="deploy"
fi

if [ -z "$1" ]; then
  echo "Usage: $0 [--upload-test-data|-u] [destroy] <gcp_project_id>"
  exit 1
fi
PROJECT_ID="$1"

# 4. Create GCS bucket for Terraform state
TF_STATE_BUCKET="${PROJECT_ID}-dcm2bq-tfstate"
echo "Configuring Terraform state bucket: gs://${TF_STATE_BUCKET}"
if ! gsutil ls "gs://${TF_STATE_BUCKET}" &> /dev/null; then
  echo "Creating GCS bucket for Terraform state..."
  gsutil mb -p "${PROJECT_ID}" "gs://${TF_STATE_BUCKET}"
  gsutil versioning set on "gs://${TF_STATE_BUCKET}"
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

echo "Deploying infrastructure..."
terraform apply -auto-approve -var="project_id=${PROJECT_ID}"

# 7. Upload test DICOM files to the new GCS bucket if flag is supplied
BUCKET_NAME=$(terraform output -raw dicom_bucket_name 2>/dev/null || terraform output -raw bucket_name 2>/dev/null)
if [ -z "$BUCKET_NAME" ]; then
  echo "Could not determine the GCS bucket name from Terraform output."
elif [ "$UPLOAD_TEST_DATA" = true ]; then
  echo "Uploading test DICOM files to gs://$BUCKET_NAME ..."
  gsutil -m cp ../test/files/dcm/*.dcm "gs://$BUCKET_NAME/"
fi

# 8. Update test/testconfig.json
DATASET_ID=$(terraform output -raw bq_dataset_id)
TABLE_ID=$(terraform output -raw bq_metadata_table_id)
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
  '.gcpConfig.projectId = $project_id | .gcpConfig.bigQuery.datasetId = $dataset_id | .gcpConfig.bigQuery.tableId = $table_id' \
  "$TEST_CONFIG_FILE" > "$TEMP_JSON" && mv "$TEMP_JSON" "$TEST_CONFIG_FILE"

echo "Updated test/testconfig.json."
