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

# Install runtime dependencies (dcmnorm-node statically links its codecs, incl. FFmpeg,
# so it only needs libstdc++ at runtime)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

# Install npm dependencies
WORKDIR /usr/src/app
COPY package*.json ./
COPY dcmnorm ./dcmnorm
RUN npm ci --omit=dev

# Copy application code
COPY src ./src
COPY helpers ./helpers

# Set up permissions
RUN chown -R node /usr/src/app

USER node
CMD ["node", "src/index.js", "service"]
