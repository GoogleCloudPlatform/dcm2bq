#!/bin/bash
#
# Copyright 2026 Google LLC
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

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker CLI is required for smoke tests"
  exit 1
fi

echo "Running Docker admin UI smoke test..."
cd "$PROJECT_ROOT"
DOCKER_SMOKE_TEST=true npx mocha --colors --timeout 900000 test/integration/docker-admin-ui.integration.js "$@"