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