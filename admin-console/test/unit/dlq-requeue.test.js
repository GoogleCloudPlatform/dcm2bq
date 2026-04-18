const assert = require('assert');

const { requeueDlqMessages, requeueAllDlqMessages } = require('../../backend/src/dlq-requeue');

describe('requeueDlqMessages', () => {
  it('requeues unique files and only deletes successful message ids', async () => {
    const queryCalls = [];
    const publishedMessages = [];

    const bigquery = {
      async query(request) {
        queryCalls.push(request);
        if (/^\s*SELECT/i.test(request.query)) {
          return [[
            {
              message_id: 'msg-1',
              publish_time: '2026-03-17T10:00:00.000Z',
              data: Buffer.from(JSON.stringify({ bucket: 'bucket-a', name: 'file-a.dcm' })).toString('base64'),
            },
            {
              message_id: 'msg-2',
              publish_time: '2026-03-17T11:00:00.000Z',
              data: Buffer.from(JSON.stringify({ bucket: 'bucket-a', name: 'file-a.dcm' })).toString('base64'),
            },
            {
              message_id: 'msg-3',
              publish_time: '2026-03-17T09:00:00.000Z',
              attributes: JSON.stringify({ bucketId: 'bucket-a', objectId: 'missing-file.dcm' }),
            },
            {
              message_id: 'msg-4',
              publish_time: '2026-03-17T08:00:00.000Z',
              data: 'not-json',
            },
          ]];
        }

        return [[]];
      },
    };

    const pubsubTopic = {
      async publishMessage(message) {
        const attrs = message.attributes || {};
        if (attrs.objectId === 'missing-file.dcm') {
          throw new Error('not found');
        }
        publishedMessages.push(message);
      },
    };

    const result = await requeueDlqMessages({
      bigquery,
      pubsubTopic,
      config: {
        projectId: 'proj',
        datasetId: 'dataset',
        deadLetterTableId: 'dead_letter',
      },
      location: 'US',
      messageIds: ['msg-1', 'msg-2', 'msg-3', 'msg-4'],
      now: () => '2026-03-17T12:00:00.000Z',
    });

    assert.equal(result.requestedMessageCount, 4);
    assert.equal(result.matchedMessageCount, 4);
    assert.equal(result.requeuedCount, 1);
    assert.equal(result.deletedMessageCount, 2);
    assert.equal(result.failedFileCount, 1);
    assert.equal(result.parseErrorCount, 1);
    assert.equal(result.errors.length, 2);

    assert.equal(publishedMessages.length, 1);
    assert.equal(publishedMessages[0].attributes.eventType, 'OBJECT_FINALIZE');
    assert.equal(publishedMessages[0].attributes.bucketId, 'bucket-a');
    assert.equal(publishedMessages[0].attributes.objectId, 'file-a.dcm');

    assert.equal(queryCalls.length, 2);
    assert.deepEqual(queryCalls[0].params, { messageIds: ['msg-1', 'msg-2', 'msg-3', 'msg-4'] });
    assert.deepEqual(queryCalls[1].params, { messageIds: ['msg-1', 'msg-2'] });
  });

  it('requeues HCAPI payloads by publishing raw dicomWebPath data', async () => {
    const queryCalls = [];
    const publishedMessages = [];

    const bigquery = {
      async query(request) {
        queryCalls.push(request);
        if (/^\s*SELECT/i.test(request.query)) {
          return [[
            {
              message_id: 'msg-h1',
              publish_time: '2026-03-17T10:00:00.000Z',
              data: Buffer.from('projects/p/locations/l/datasets/d/dicomStores/s/dicomWeb/studies/1/series/2/instances/3').toString('base64'),
            },
          ]];
        }
        return [[]];
      },
    };

    const pubsubTopic = {
      async publishMessage(message) {
        publishedMessages.push(message);
      },
    };

    const result = await requeueDlqMessages({
      bigquery,
      pubsubTopic,
      config: {
        projectId: 'proj',
        datasetId: 'dataset',
        deadLetterTableId: 'dead_letter',
      },
      location: 'US',
      messageIds: ['msg-h1'],
      now: () => '2026-03-17T12:00:00.000Z',
    });

    assert.equal(result.requeuedCount, 1);
    assert.equal(result.failedFileCount, 0);
    assert.equal(publishedMessages.length, 1);
    assert.equal(publishedMessages[0].data.toString('utf8'), 'projects/p/locations/l/datasets/d/dicomStores/s/dicomWeb/studies/1/series/2/instances/3');
    assert.equal(publishedMessages[0].attributes.dcm2bqRequeueSource, 'admin-console');
    assert.equal(queryCalls.length, 2);
  });

  it('returns zero counts when there are no message ids', async () => {
    let queryCount = 0;
    const bigquery = {
      async query() {
        queryCount++;
        return [[]];
      },
    };

    const pubsubTopic = {
      async publishMessage() {
        throw new Error('pubsubTopic should not be used');
      },
    };

    const result = await requeueDlqMessages({
      bigquery,
      pubsubTopic,
      config: {
        projectId: 'proj',
        datasetId: 'dataset',
        deadLetterTableId: 'dead_letter',
      },
      location: 'US',
      messageIds: [],
    });

    assert.deepEqual(result, {
      requestedMessageCount: 0,
      matchedMessageCount: 0,
      requeuedCount: 0,
      deletedMessageCount: 0,
      failedFileCount: 0,
      parseErrorCount: 0,
      errors: [],
    });
    assert.equal(queryCount, 0);
  });
});

describe('requeueAllDlqMessages', () => {
  it('returns zero counts when the DLQ has no rows', async () => {
    const queryCalls = [];
    const bigquery = {
      async query(request) {
        queryCalls.push(request);
        return [[]];
      },
    };

    const pubsubTopic = {
      async publishMessage() {
        throw new Error('pubsubTopic should not be used');
      },
    };

    const result = await requeueAllDlqMessages({
      bigquery,
      pubsubTopic,
      config: {
        projectId: 'proj',
        datasetId: 'dataset',
        deadLetterTableId: 'dead_letter',
      },
      location: 'US',
    });

    assert.deepEqual(result, {
      requestedMessageCount: 0,
      matchedMessageCount: 0,
      requeuedCount: 0,
      deletedMessageCount: 0,
      failedFileCount: 0,
      parseErrorCount: 0,
      errors: [],
    });
    assert.equal(queryCalls.length, 1);
    assert.ok(/^\s*SELECT/i.test(queryCalls[0].query));
  });

  it('persists partial progress when a later file fails', async () => {
    const queryCalls = [];
    const publishedMessages = [];
    const progressEvents = [];

    const bigquery = {
      async query(request) {
        queryCalls.push(request);
        if (/^\s*SELECT/i.test(request.query)) {
          return [[
            {
              message_id: 'msg-a1',
              publish_time: '2026-03-17T11:00:00.000Z',
              data: Buffer.from(JSON.stringify({ bucket: 'bucket-a', name: 'file-a.dcm' })).toString('base64'),
            },
            {
              message_id: 'msg-a2',
              publish_time: '2026-03-17T10:59:00.000Z',
              data: Buffer.from(JSON.stringify({ bucket: 'bucket-a', name: 'file-a.dcm' })).toString('base64'),
            },
            {
              message_id: 'msg-b1',
              publish_time: '2026-03-17T10:00:00.000Z',
              data: Buffer.from(JSON.stringify({ bucket: 'bucket-a', name: 'file-b.dcm' })).toString('base64'),
            },
          ]];
        }
        return [[]];
      },
    };

    const pubsubTopic = {
      async publishMessage(message) {
        publishedMessages.push(message);
        if (message.attributes?.objectId === 'file-b.dcm') {
          throw new Error('simulated publish failure');
        }
      },
    };

    const result = await requeueAllDlqMessages({
      bigquery,
      pubsubTopic,
      config: {
        projectId: 'proj',
        datasetId: 'dataset',
        deadLetterTableId: 'dead_letter',
      },
      location: 'US',
      now: () => '2026-03-17T12:00:00.000Z',
      onProgress: async (detail) => {
        progressEvents.push(detail);
      },
    });

    assert.equal(result.requestedMessageCount, 3);
    assert.equal(result.requeuedCount, 1);
    assert.equal(result.deletedMessageCount, 2);
    assert.equal(result.failedFileCount, 1);

    const deleteCalls = queryCalls.filter((call) => /^\s*DELETE/i.test(call.query));
    assert.equal(deleteCalls.length, 1);
    assert.deepEqual(deleteCalls[0].params, { messageIds: ['msg-a1', 'msg-a2'] });

    const attemptedFiles = publishedMessages.map((entry) => entry.attributes?.objectId);
    assert.deepEqual(attemptedFiles, ['file-a.dcm', 'file-b.dcm']);

    assert.ok(progressEvents.length >= 4);
    assert.equal(progressEvents[0].stage, 'started');
    assert.equal(progressEvents[0].totalFiles, 2);
    assert.equal(progressEvents[progressEvents.length - 1].stage, 'completed');
    assert.equal(progressEvents[progressEvents.length - 1].processedFiles, 2);
  });
});
