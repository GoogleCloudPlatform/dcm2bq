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

const {
  parseQueuePathsText,
  queuePathsForProcessing,
} = require('../../backend/src/queue-paths');

describe('queue-paths helpers', () => {
  it('parses plain-text path files and ignores comments', () => {
    const parsed = parseQueuePathsText([
      '',
      '# comment',
      '  gs://bucket-a/file-a.dcm  ',
      'projects/p/locations/l/datasets/d/dicomStores/s/dicomWeb/studies/1',
      '   ',
    ].join('\n'));

    assert.deepEqual(parsed, [
      'gs://bucket-a/file-a.dcm',
      'projects/p/locations/l/datasets/d/dicomStores/s/dicomWeb/studies/1',
    ]);
  });

  it('queues paths and emits batch progress updates', async () => {
    const publishedMessages = [];
    const progressEvents = [];

    const pubsubTopic = {
      async publishMessage(message) {
        if (message.data?.toString('utf8') === 'gs://bucket-a/bad.dcm') {
          throw new Error('unexpected raw gcs payload');
        }
        publishedMessages.push(message);
      },
    };

    const result = await queuePathsForProcessing({
      paths: [
        'gs://bucket-a/file-a.dcm',
        'projects/p/locations/l/datasets/d/dicomStores/s/dicomWeb/studies/1',
        'not-a-supported-path',
      ],
      pubsubTopic,
      requeueSource: 'test-suite',
      collectResults: true,
      progressBatchSize: 2,
      publishGcsRequeueMessage: async (topic, bucket, object, source) => {
        publishedMessages.push({ topic, bucket, object, source, kind: 'gcs' });
      },
      onProgress: async (detail) => {
        progressEvents.push(detail);
      },
    });

    assert.equal(result.totalPathCount, 3);
    assert.equal(result.succeededCount, 2);
    assert.equal(result.failedCount, 1);
    assert.equal(result.results.length, 3);
    assert.deepEqual(progressEvents.map((event) => event.stage), ['started', 'item_batch', 'item_batch', 'completed']);
    assert.equal(progressEvents[1].processedPaths, 2);
    assert.equal(progressEvents[2].processedPaths, 3);
    assert.equal(progressEvents[2].failedCount, 1);

    assert.equal(publishedMessages.length, 2);
    assert.equal(publishedMessages[0].bucket, 'bucket-a');
    assert.equal(publishedMessages[0].object, 'file-a.dcm');
    assert.equal(publishedMessages[1].data.toString('utf8'), 'projects/p/locations/l/datasets/d/dicomStores/s/dicomWeb/studies/1');
  });
});