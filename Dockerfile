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




FROM node:24-slim
ENV NODE_ENV=production
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
    cd /usr/src/app && rm -rf /tmp/dcmtk
# Remove build dependencies to keep the image small
RUN apt-get purge -y build-essential cmake git libpng-dev libtiff-dev libxml2-dev zlib1g-dev && \
    apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /usr/src/app
RUN chown -R node /usr/src/app
RUN npm install --production --silent
USER node
CMD ["node", "src/index.js", "service"]
