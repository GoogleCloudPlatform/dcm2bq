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

async function emitProgress(onProgress, detail) {
  if (typeof onProgress !== "function") return;
  try {
    await onProgress(detail);
  } catch (_) {
    // Progress callback failures should not fail requeue operations.
  }
}

function resolveDeleteBatchSize() {
  const raw = Number.parseInt(process.env.ADMIN_DLQ_REQUEUE_DELETE_BATCH_SIZE || "25", 10);
  if (!Number.isFinite(raw)) return 25;
  return Math.min(Math.max(raw, 1), 1000);
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
  onProgress,
}) {
  const matchedRows = Array.isArray(rows) ? rows : [];
  if (matchedRows.length === 0) {
    await emitProgress(onProgress, {
      stage: "completed",
      totalFiles: 0,
      processedFiles: 0,
      requeuedCount: 0,
      failedFileCount: 0,
      deletedMessageCount: 0,
    });
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
  let deletedMessageCount = 0;
  const deleteBatchSize = resolveDeleteBatchSize();
  const pendingDeleteMessageIds = [];
  const orderedFiles = Array.from(files.entries()).sort((a, b) => b[1].publishTime - a[1].publishTime);
  const dlqTable = `\`${config.projectId}.${config.datasetId}.${config.deadLetterTableId}\``;
  const totalFiles = orderedFiles.length;
  let processedFiles = 0;

  const flushPendingDeletes = async ({ force = false } = {}) => {
    if (pendingDeleteMessageIds.length === 0) return;
    if (!force && pendingDeleteMessageIds.length < deleteBatchSize) return;

    const messageIds = pendingDeleteMessageIds.splice(0, pendingDeleteMessageIds.length);
    const deleteQuery = `
      DELETE FROM ${dlqTable}
      WHERE message_id IN UNNEST(@messageIds)
    `;

    try {
      await bigquery.query({
        query: deleteQuery,
        location,
        params: { messageIds },
      });
      deletedMessageCount += messageIds.length;
      await emitProgress(onProgress, {
        stage: "checkpoint",
        deletedBatchCount: messageIds.length,
        totalFiles,
        processedFiles,
        requeuedCount,
        failedFileCount,
        deletedMessageCount,
      });
    } catch (error) {
      pendingDeleteMessageIds.unshift(...messageIds);
      errors.push(`Failed to delete ${messageIds.length} DLQ message(s): ${error?.message || "Unknown error"}`);
    }
  };

  await emitProgress(onProgress, {
    stage: "started",
    totalFiles,
    processedFiles,
    requeuedCount,
    failedFileCount,
    deletedMessageCount,
  });

  for (const [path, entry] of orderedFiles) {
    try {
      const file = storage.bucket(entry.fileInfo.bucket).file(entry.fileInfo.name);
      await file.setMetadata({
        metadata: {
          "dcm2bq-reprocess": now(),
          "dcm2bq-requeue-source": requeueSource,
        },
      });

      requeuedCount++;
      pendingDeleteMessageIds.push(...entry.messageIds);
      await flushPendingDeletes({ force: false });
      processedFiles++;
      await emitProgress(onProgress, {
        stage: "item",
        status: "success",
        filePath: `gs://${path}`,
        totalFiles,
        processedFiles,
        requeuedCount,
        failedFileCount,
        deletedMessageCount,
      });
    } catch (error) {
      failedFileCount++;
      errors.push(`Failed to requeue gs://${path}: ${error?.message || "Unknown error"}`);
      processedFiles++;
      await emitProgress(onProgress, {
        stage: "item",
        status: "failed",
        filePath: `gs://${path}`,
        error: error?.message || "Unknown error",
        totalFiles,
        processedFiles,
        requeuedCount,
        failedFileCount,
        deletedMessageCount,
      });
    }
  }

  await flushPendingDeletes({ force: true });

  await emitProgress(onProgress, {
    stage: "completed",
    totalFiles,
    processedFiles,
    requeuedCount,
    failedFileCount,
    deletedMessageCount,
  });

  return {
    requestedMessageCount,
    matchedMessageCount: matchedRows.length,
    requeuedCount,
    deletedMessageCount,
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
  onProgress,
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
    onProgress,
  });
}

async function requeueAllDlqMessages({
  bigquery,
  storage,
  config,
  location,
  requeueSource = "admin-console",
  now = () => new Date().toISOString(),
  onProgress,
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
    onProgress,
  });
}

module.exports = {
  requeueDlqMessages,
  requeueAllDlqMessages,
};