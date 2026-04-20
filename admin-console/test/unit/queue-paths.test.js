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