const assert = require('assert');

const { requeueDlqMessages } = require('../../backend/src/dlq-requeue');

describe('requeueDlqMessages', () => {
  it('requeues unique files and only deletes successful message ids', async () => {
    const queryCalls = [];
    const metadataUpdates = [];

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

    const storage = {
      bucket(bucketName) {
        return {
          file(fileName) {
            return {
              async exists() {
                return [fileName !== 'missing-file.dcm'];
              },
              async setMetadata(payload) {
                metadataUpdates.push({ bucketName, fileName, payload });
              },
            };
          },
        };
      },
    };

    const result = await requeueDlqMessages({
      bigquery,
      storage,
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

    assert.equal(metadataUpdates.length, 1);
    assert.deepEqual(metadataUpdates[0], {
      bucketName: 'bucket-a',
      fileName: 'file-a.dcm',
      payload: {
        metadata: {
          'dcm2bq-reprocess': '2026-03-17T12:00:00.000Z',
          'dcm2bq-requeue-source': 'admin-console',
        },
      },
    });

    assert.equal(queryCalls.length, 2);
    assert.deepEqual(queryCalls[0].params, { messageIds: ['msg-1', 'msg-2', 'msg-3', 'msg-4'] });
    assert.deepEqual(queryCalls[1].params, { messageIds: ['msg-1', 'msg-2'] });
  });

  it('returns zero counts when there are no message ids', async () => {
    let queryCount = 0;
    const bigquery = {
      async query() {
        queryCount++;
        return [[]];
      },
    };

    const storage = {
      bucket() {
        throw new Error('storage should not be used');
      },
    };

    const result = await requeueDlqMessages({
      bigquery,
      storage,
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
