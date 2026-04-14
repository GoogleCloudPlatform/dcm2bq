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

# Single-stage runtime image
FROM node:24-trixie-slim
ENV NODE_ENV=production
ENV PATH=/usr/local/bin:${PATH}

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates ffmpeg libstdc++6 \
    libpng16-16 libxml2 zlib1g \
    && rm -rf /var/lib/apt/lists/*

# Use the repo-managed dcmnorm binary and place it on PATH.
COPY bin/dcmnorm /usr/local/bin/dcmnorm
RUN chmod 755 /usr/local/bin/dcmnorm

# Install npm dependencies
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application code
COPY src ./src
COPY helpers ./helpers

# Set up permissions
RUN chown -R node /usr/src/app

USER node
CMD ["node", "src/index.js", "service"]
