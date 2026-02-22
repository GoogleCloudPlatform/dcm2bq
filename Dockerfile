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

# Stage 1: Build stage
FROM node:24-slim AS builder
WORKDIR /usr/src/app
COPY . .

# Install all build and runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates build-essential cmake git libpng-dev libtiff-dev libxml2-dev zlib1g-dev \
    libgdcm-tools libpng16-16 libxml2 zlib1g \
    && rm -rf /var/lib/apt/lists/*

# Build and install DCMTK v3.6.9 from source
WORKDIR /tmp
RUN git clone --branch DCMTK-3.6.9 https://github.com/DCMTK/dcmtk.git && \
    cd dcmtk && mkdir build && cd build && \
    cmake .. -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local && \
    make -j$(nproc) && make install && \
    rm -rf /tmp/dcmtk

# Install npm dependencies
WORKDIR /usr/src/app
RUN npm ci --omit=dev

# Stage 2: Runtime stage
FROM node:24-slim
ENV NODE_ENV=production

# Install only runtime dependencies (not build tools)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libgdcm-tools libpng16-16 libxml2 zlib1g \
    && rm -rf /var/lib/apt/lists/*

# Copy DCMTK installation from builder
COPY --from=builder /usr/local /usr/local

# Copy application code and node_modules from builder
WORKDIR /usr/src/app
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/src ./src
COPY --from=builder /usr/src/app/helpers ./helpers
COPY --from=builder /usr/src/app/assets ./assets
COPY --from=builder /usr/src/app/tag-lookup.min.json ./
COPY --from=builder /usr/src/app/package*.json ./

# Set up permissions
RUN chown -R node /usr/src/app

USER node
CMD ["node", "src/index.js", "service"]
