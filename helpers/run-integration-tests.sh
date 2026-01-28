#!/bin/bash
#
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
#

# Script to run integration tests against real GCP services
# Prerequisites:
# 1. Run ./helpers/deploy.sh to create resources and generate test/testconfig.json
# 2. Authenticate with GCP: gcloud auth application-default login

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if testconfig.json exists
if [ ! -f "test/testconfig.json" ]; then
    echo -e "${RED}Error: test/testconfig.json not found${NC}"
    echo "Please run ./helpers/deploy.sh <project-name> first to create GCP resources and generate the config file"
    exit 1
fi

# Check if authenticated
if ! gcloud auth application-default print-access-token &>/dev/null; then
    echo -e "${YELLOW}Warning: GCP authentication not found${NC}"
    echo "Please run: gcloud auth application-default login"
    exit 1
fi

echo -e "${GREEN}Running integration tests against real GCP services...${NC}"
echo ""

# Run integration tests with proper config
INTEGRATION_TEST=true DCM2BQ_CONFIG_FILE=test/testconfig.json mocha --colors --timeout 120000 test/*.integration.js "$@"

exit_code=$?

if [ $exit_code -eq 0 ]; then
    echo ""
    echo -e "${GREEN}✓ All integration tests passed!${NC}"
else
    echo ""
    echo -e "${RED}✗ Some integration tests failed${NC}"
fi

exit $exit_code
