DROP TABLE IF EXISTS `dicom.metadata`;

DROP VIEW IF EXISTS `dicom.metadataView`;

CREATE TABLE
  `dicom.metadata` (
    `timestamp` TIMESTAMP NOT NULL,
    `path` STRING NOT NULL,
    `version` STRING,
    `info` JSON NOT NULL,
    `metadata` JSON
  );

CREATE VIEW
  `dicom.metadataView` AS
SELECT
  *
EXCEPT
(_row_id)
FROM
  (
    SELECT
      ROW_NUMBER() over (
        PARTITION BY
          path,
          version
        ORDER BY
          timestamp DESC
      ) as _row_id,
      *
    FROM
      `dicom.metadata`
  ) as r
WHERE
  r._row_id = 1
  AND r.metadata IS NOT NULL;