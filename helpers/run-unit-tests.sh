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

# Helper script to run unit tests with mocked GCP services
# Usage: ./helpers/run-unit-tests.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "Running unit tests with mocked GCP services..."
echo ""

# Verify node_modules exists
if [ ! -d "$PROJECT_ROOT/node_modules" ]; then
    echo "Error: node_modules not found. Please run 'npm install' first."
    exit 1
fi

# Set up mock config and run mocha directly
export DCM2BQ_CONFIG="$(node -p "JSON.stringify(require('$PROJECT_ROOT/test/test-config.js'))")"

cd "$PROJECT_ROOT"
npx mocha --colors --bail --timeout 30000 test/*.test.js

echo ""
echo "Unit tests completed successfully!"
