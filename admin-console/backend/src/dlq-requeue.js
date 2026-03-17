const { extractDlqFileInfo } = require("./dlq-utils");

function buildEmptyRequeueResult(requestedMessageCount = 0) {
  return {
    requestedMessageCount,
    matchedMessageCount: 0,
    requeuedCount: 0,
    deletedMessageCount: 0,
    failedFileCount: 0,
    parseErrorCount: 0,
    errors: [],
  };
}

async function applyRequeueFromRows({
  bigquery,
  storage,
  config,
  location,
  rows,
  requestedMessageCount,
  requeueSource,
  now,
}) {
  const matchedRows = Array.isArray(rows) ? rows : [];
  if (matchedRows.length === 0) {
    return buildEmptyRequeueResult(requestedMessageCount);
  }
  const files = new Map();
  let parseErrorCount = 0;
  const errors = [];

  for (const row of matchedRows) {
    const fileInfo = extractDlqFileInfo(row);
    if (!fileInfo?.bucket || !fileInfo?.name) {
      parseErrorCount++;
      errors.push(`Could not determine file path for DLQ message ${row.message_id}`);
      continue;
    }

    const key = `${fileInfo.bucket}/${fileInfo.name}`;
    const rowPublishTime = row.publish_time ? new Date(row.publish_time.value || row.publish_time).getTime() : 0;
    const existing = files.get(key);

    if (!existing) {
      files.set(key, { fileInfo, publishTime: rowPublishTime, messageIds: [row.message_id] });
      continue;
    }

    existing.messageIds.push(row.message_id);
    if (rowPublishTime > existing.publishTime) {
      existing.publishTime = rowPublishTime;
    }
  }

  let requeuedCount = 0;
  let failedFileCount = 0;
  const messageIdsToDelete = [];
  const orderedFiles = Array.from(files.entries()).sort((a, b) => b[1].publishTime - a[1].publishTime);

  for (const [path, entry] of orderedFiles) {
    try {
      const file = storage.bucket(entry.fileInfo.bucket).file(entry.fileInfo.name);
      const [exists] = await file.exists();

      if (!exists) {
        failedFileCount++;
        errors.push(`File not found for requeue: gs://${path}`);
        continue;
      }

      await file.setMetadata({
        metadata: {
          "dcm2bq-reprocess": now(),
          "dcm2bq-requeue-source": requeueSource,
        },
      });

      requeuedCount++;
      messageIdsToDelete.push(...entry.messageIds);
    } catch (error) {
      failedFileCount++;
      errors.push(`Failed to requeue gs://${path}: ${error?.message || "Unknown error"}`);
    }
  }

  const dlqTable = `\`${config.projectId}.${config.datasetId}.${config.deadLetterTableId}\``;

  if (messageIdsToDelete.length > 0) {
    const deleteQuery = `
      DELETE FROM ${dlqTable}
      WHERE message_id IN UNNEST(@messageIds)
    `;

    await bigquery.query({
      query: deleteQuery,
      location,
      params: { messageIds: messageIdsToDelete },
    });
  }

  return {
    requestedMessageCount,
    matchedMessageCount: matchedRows.length,
    requeuedCount,
    deletedMessageCount: messageIdsToDelete.length,
    failedFileCount,
    parseErrorCount,
    errors,
  };
}

async function requeueDlqMessages({
  bigquery,
  storage,
  config,
  location,
  messageIds,
  requeueSource = "admin-console",
  now = () => new Date().toISOString(),
}) {
  const normalizedMessageIds = Array.isArray(messageIds)
    ? messageIds.map((id) => String(id || "").trim()).filter(Boolean)
    : [];

  if (normalizedMessageIds.length === 0) {
    return buildEmptyRequeueResult(0);
  }

  const dlqTable = `\`${config.projectId}.${config.datasetId}.${config.deadLetterTableId}\``;
  const selectQuery = `
    SELECT
      data,
      attributes,
      message_id,
      publish_time
    FROM ${dlqTable}
    WHERE message_id IN UNNEST(@messageIds)
    ORDER BY publish_time DESC
  `;

  const [rows] = await bigquery.query({
    query: selectQuery,
    location,
    params: { messageIds: normalizedMessageIds },
  });

  return applyRequeueFromRows({
    bigquery,
    storage,
    config,
    location,
    rows,
    requestedMessageCount: normalizedMessageIds.length,
    requeueSource,
    now,
  });
}

async function requeueAllDlqMessages({
  bigquery,
  storage,
  config,
  location,
  requeueSource = "admin-console",
  now = () => new Date().toISOString(),
}) {
  const dlqTable = `\`${config.projectId}.${config.datasetId}.${config.deadLetterTableId}\``;
  const selectQuery = `
    SELECT
      data,
      attributes,
      message_id,
      publish_time
    FROM ${dlqTable}
    ORDER BY publish_time DESC
  `;

  const [rows] = await bigquery.query({
    query: selectQuery,
    location,
  });

  const requestedMessageCount = Array.isArray(rows) ? rows.length : 0;
  return applyRequeueFromRows({
    bigquery,
    storage,
    config,
    location,
    rows,
    requestedMessageCount,
    requeueSource,
    now,
  });
}

module.exports = {
  requeueDlqMessages,
  requeueAllDlqMessages,
};