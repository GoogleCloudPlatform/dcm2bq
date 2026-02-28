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
FROM node:24-slim
ENV NODE_ENV=production

# Install runtime dependencies and download tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl bzip2 \
    libgdcm-tools libpng16-16 libxml2 zlib1g \
    && rm -rf /var/lib/apt/lists/*

# Install DCMTK v3.6.9 prebuilt static binaries
WORKDIR /tmp
COPY assets/dcmtk-3.6.9-linux-x86_64-static.tar.bz2 ./
RUN tar -xjf dcmtk-3.6.9-linux-x86_64-static.tar.bz2 -C /usr/local --strip-components=1 && \
    rm -f dcmtk-3.6.9-linux-x86_64-static.tar.bz2

# Install npm dependencies
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application code
COPY src ./src
COPY helpers ./helpers
COPY tag-lookup.min.json ./

# Set up permissions
RUN chown -R node /usr/src/app

USER node
CMD ["node", "src/index.js", "service"]
