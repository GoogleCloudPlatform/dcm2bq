/*
 Copyright 2025 Google LLC

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

      https://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
 */

const assert = require('assert');

const { buildReprocessGeneration } = require('../../backend/src/reprocess-generation');

describe('buildReprocessGeneration', () => {
  it('never matches the original real GCS generation it replaces', () => {
    const originalGeneration = '1700000000000123';
    const synthetic = buildReprocessGeneration(Date.now(), 0);

    assert.notEqual(synthetic, originalGeneration);
  });

  it('produces distinct generations for every item in the same reprocess batch', () => {
    const batchStamp = Date.now();
    const generations = Array.from({ length: 25 }, (_, i) => buildReprocessGeneration(batchStamp, i));

    assert.equal(new Set(generations).size, generations.length);
  });

  it('does not collide across separate reprocess requests using the same batch stamp', () => {
    // Two admin operators could trigger reprocess in the same millisecond;
    // the random nonce must still keep the two batches from colliding.
    const batchStamp = Date.now();
    const firstBatch = Array.from({ length: 10 }, (_, i) => buildReprocessGeneration(batchStamp, i));
    const secondBatch = Array.from({ length: 10 }, (_, i) => buildReprocessGeneration(batchStamp, i));

    const overlap = firstBatch.filter((value) => secondBatch.includes(value));
    assert.deepEqual(overlap, []);
  });
});
