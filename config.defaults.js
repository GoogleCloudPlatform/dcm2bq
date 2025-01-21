module.exports = {
  bigQuery: {
    // Location to use in BigQuery
    datasetId: "dicom",
    tableId: "metadata",
  },
  // Passed to DICOM parser (https://github.com/cornerstonejs/dicomParser)
  dicomParserOptions: {},
  // Passed to JSON formatter
  jsonOutputOptions: {
    useArrayWithSingleValue: false, // Use array, even when there's only a single value
    ignoreGroupLength: true, // Ignore group length elements
    ignoreMetaHeader: false, // Ignore the DICOM metadata header
    ignorePrivate: false, // Ignore any private tags
    ignoreBinary: false, // Ignore any binary tags
    useCommonNames: true, // Map DICOM tags to common names
    explicitBulkDataRoot: false, // For BulkdDataURIs use an explicit file path
  },
  src: "DEFAULTS",
};
