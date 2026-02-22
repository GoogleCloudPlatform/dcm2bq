function parseJsonValue(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return value;
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function collectCommonAttributes(objects) {
  if (!Array.isArray(objects) || objects.length === 0) {
    return {};
  }

  const first = objects[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) {
    return {};
  }

  const common = {};
  const firstKeys = Object.keys(first);
  for (const key of firstKeys) {
    const baseValue = first[key];
    const baseSignature = stableStringify(baseValue);
    const foundInAll = objects.every((obj) => (
      obj
      && typeof obj === "object"
      && !Array.isArray(obj)
      && Object.prototype.hasOwnProperty.call(obj, key)
      && stableStringify(obj[key]) === baseSignature
    ));
    if (foundInAll) {
      common[key] = baseValue;
    }
  }

  return common;
}

function omitKeys(source, keysToOmit) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return {};
  }

  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (keysToOmit.has(key)) continue;
    result[key] = value;
  }
  return result;
}

const NON_DICOM_FIELDS = new Set([
  "id", "path", "version", "timestamp", "studyId", "seriesId", "counts",
  "__typename", "_id", "__v",
]);

function filterNonDicomFields(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => filterNonDicomFields(item)).filter((item) => item !== undefined);
  }
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (NON_DICOM_FIELDS.has(key)) continue;
    if (key === "instances" || key === "series") {
      if (Array.isArray(value)) {
        result[key] = value.map((item) => filterNonDicomFields(item)).filter((item) => item !== undefined);
      } else {
        result[key] = filterNonDicomFields(value);
      }
    } else if (typeof value === "object" && value !== null) {
      result[key] = filterNonDicomFields(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function buildNormalizedStudyMetadata(rows, studyId) {
  const normalizedRows = rows.map((row) => {
    const metadata = parseJsonValue(row.metadata);
    const safeMetadata = metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? metadata
      : {};
    return {
      id: row.id,
      path: row.path,
      version: row.version,
      timestamp: row.timestamp,
      metadata: safeMetadata,
    };
  });

  const studyMetadata = collectCommonAttributes(normalizedRows.map((row) => row.metadata));
  const studyKeys = new Set(Object.keys(studyMetadata));

  const seriesBuckets = new Map();
  for (const row of normalizedRows) {
    const metadataWithoutStudy = omitKeys(row.metadata, studyKeys);
    const seriesId = String(row.metadata.SeriesInstanceUID || "UNKNOWN_SERIES");
    if (!seriesBuckets.has(seriesId)) {
      seriesBuckets.set(seriesId, []);
    }
    seriesBuckets.get(seriesId).push({ row, metadataWithoutStudy });
  }

  const series = [...seriesBuckets.entries()]
    .sort(([seriesIdA], [seriesIdB]) => String(seriesIdA).localeCompare(String(seriesIdB)))
    .map(([seriesId, entries]) => {
      const seriesMetadata = collectCommonAttributes(entries.map((entry) => entry.metadataWithoutStudy));
      const seriesKeys = new Set(Object.keys(seriesMetadata));

      const instances = entries.map((entry) => {
        const instanceAttributes = omitKeys(entry.metadataWithoutStudy, seriesKeys);
        return {
          ...instanceAttributes,
        };
      });

      return {
        ...seriesMetadata,
        instances,
      };
    });

  const result = {
    ...studyMetadata,
    series: series || [],
  };

  const filtered = filterNonDicomFields(result);
  return filtered || {};
}

module.exports = {
  buildNormalizedStudyMetadata,
};
