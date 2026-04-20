function parseQueuePathsText(input) {
  return String(input || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

async function publishQueuePath({
  pathValue,
  pubsubTopic,
  publishGcsRequeueMessage,
  requeueSource,
  now = () => new Date().toISOString(),
}) {
  if (pathValue.startsWith("gs://")) {
    const withoutScheme = pathValue.slice("gs://".length);
    const slashIdx = withoutScheme.indexOf("/");
    if (slashIdx < 1) {
      throw new Error("Invalid GCS path: missing object name");
    }

    const bucket = withoutScheme.slice(0, slashIdx);
    const object = withoutScheme.slice(slashIdx + 1);
    await publishGcsRequeueMessage(pubsubTopic, bucket, object, requeueSource);
    return { path: pathValue, status: "ok", type: "gcs" };
  }

  if (pathValue.includes("/dicomWeb/")) {
    const nowIso = now();
    await pubsubTopic.publishMessage({
      data: Buffer.from(pathValue, "utf8"),
      attributes: {
        dcm2bqRequeueSource: requeueSource,
        dcm2bqRequeueAt: nowIso,
      },
    });
    return { path: pathValue, status: "ok", type: "hcapi" };
  }

  throw new Error("Unrecognized path format (expected gs:// or .../dicomWeb/...)");
}

async function queuePathsForProcessing({
  paths,
  pubsubTopic,
  publishGcsRequeueMessage,
  requeueSource,
  onProgress,
  collectResults = false,
  progressBatchSize = 25,
  emitStarted = true,
  now,
}) {
  const normalizedPaths = Array.isArray(paths)
    ? paths.map((pathValue) => String(pathValue || "").trim()).filter(Boolean)
    : [];

  if (emitStarted && typeof onProgress === "function") {
    await onProgress({
      stage: "started",
      totalPaths: normalizedPaths.length,
      processedPaths: 0,
      succeededCount: 0,
      failedCount: 0,
    });
  }

  const results = collectResults ? [] : null;
  let succeededCount = 0;
  let failedCount = 0;
  let pendingUpdates = [];

  for (const [index, pathValue] of normalizedPaths.entries()) {
    try {
      await publishQueuePath({
        pathValue,
        pubsubTopic,
        publishGcsRequeueMessage,
        requeueSource,
        now,
      });

      succeededCount += 1;
      if (results) {
        results.push({ path: pathValue, status: "ok" });
      }
      pendingUpdates.push({ index, status: "ok" });
    } catch (error) {
      const errorMessage = error?.message || "Publish failed";
      failedCount += 1;
      if (results) {
        results.push({ path: pathValue, status: "error", error: errorMessage });
      }
      pendingUpdates.push({ index, status: "error", error: errorMessage });
    }

    const isBatchBoundary = pendingUpdates.length >= Math.max(progressBatchSize, 1);
    const isLastItem = index === normalizedPaths.length - 1;
    if (typeof onProgress === "function" && (isBatchBoundary || isLastItem)) {
      await onProgress({
        stage: "item_batch",
        totalPaths: normalizedPaths.length,
        processedPaths: index + 1,
        succeededCount,
        failedCount,
        updates: pendingUpdates,
      });
      pendingUpdates = [];
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  if (typeof onProgress === "function") {
    await onProgress({
      stage: "completed",
      totalPaths: normalizedPaths.length,
      processedPaths: normalizedPaths.length,
      succeededCount,
      failedCount,
    });
  }

  return {
    totalPathCount: normalizedPaths.length,
    succeededCount,
    failedCount,
    ...(results ? { results } : {}),
  };
}

module.exports = {
  parseQueuePathsText,
  publishQueuePath,
  queuePathsForProcessing,
};