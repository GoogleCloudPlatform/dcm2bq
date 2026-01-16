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
-- Get last 5 recent rows from table
SELECT
     *
FROM
     `dicom.instances`
ORDER BY
     timestamp DESC
LIMIT
     10;

-- Event groupings
SELECT
     COUNT(*) as count,
     JSON_VALUE (`info`, "$.event") AS eventType
FROM
     `dicom.instances`
GROUP BY
     eventType;

-- Get last 5 recent rows from view
SELECT
     *
FROM
     `dicom.instancesView`
ORDER BY
     timestamp DESC
LIMIT
     10;

-- Show largest studies
SELECT
     COUNT(*) as StudyInstances,
     JSON_VALUE (`metadata`, "$.StudyInstanceUID") AS StudyUID,
     SUM(LAX_INT64 (JSON_QUERY (`info`, "$.storage.size"))) AS StorageSize
FROM
     `dicom.instancesView`
GROUP BY
     StudyUID
ORDER BY
     StudyInstances DESC
LIMIT
     10;

-- Show total size of all studies
SELECT
     COUNT(*) as TotalInstances,
     SUM(LAX_INT64 (JSON_QUERY (`info`, "$.storage.size"))) AS StorageSize
FROM
     `dicom.instancesView`;

-- Find a particular study by StudyUID
SELECT
     *
from
     `dicom.instancesView`
WHERE
     JSON_VALUE (`metadata`, '$.StudyInstanceUID') = '1.2.840.123456789456789456789.2.2223447302877.1';

-- Show the latest instances that have failed parsing
SELECT
     MAX(publish_time) as latest_time,
     COUNT(*) AS occurences,
     CONCAT (
          'gs://',
          JSON_VALUE (`attributes`, '$.bucketId'),
          '/',
          JSON_VALUE (`attributes`, '$.objectId')
     ) AS gcsPath
FROM
     `dicom.dead_letter`
GROUP BY
     gcsPath
ORDER BY
     latest_time DESC
LIMIT
     10;

-- If doing a vector search on the instances table, make sure to create an embeddings model connection and a vector index first.
CREATE
OR REPLACE MODEL `dicom.embedding_model` REMOTE
WITH
     CONNECTION DEFAULT OPTIONS (ENDPOINT = 'multimodalembedding@001');

CREATE
OR REPLACE VECTOR INDEX `dicom.embedding_index` ON `dicom.instances` (embeddingVector) OPTIONS (index_type = 'IVF', distance_type = 'COSINE');

-- Show instances with embeddings
SELECT
     *
FROM
     `dicom.instances`
WHERE
     embeddingVector IS NOT NULL
ORDER BY
     timestamp DESC
LIMIT
     10;

-- And finally, how about combining a metadata and semantic search
SELECT
     ANY_VALUE (JSON_VALUE (meta.metadata, '$.PatientID')) AS PatientID,
     ANY_VALUE (JSON_VALUE (meta.metadata, '$.PatientName')) AS PatientName,
     ANY_VALUE (JSON_VALUE (meta.metadata, '$.PatientAge')) AS PatientAge,
     ANY_VALUE (JSON_VALUE (meta.metadata, '$.PatientSex')) AS PatientSex,
     JSON_VALUE (meta.metadata, '$.StudyInstanceUID') AS StudyInstanceUID,
     ANY_VALUE (JSON_VALUE (meta.metadata, '$.StudyDescription')) AS StudyDescription,
     ANY_VALUE (JSON_VALUE (meta.metadata, '$.StudyDate')) AS StudyDate,
     STRING_AGG (DISTINCT JSON_VALUE (meta.metadata, '$.Modality')) AS Modality,
     COUNT(
          DISTINCT JSON_VALUE (meta.metadata, '$.SeriesInstanceUID')
     ) AS NumberOfSeries,
     COUNT(
          DISTINCT JSON_VALUE (meta.metadata, '$.SOPInstanceUID')
     ) AS NumberOfInstances,
     CASE
          WHEN MIN(vectorSearch.distance) IS NULL THEN 1.0
          ELSE MIN(vectorSearch.distance)
     END AS TextSearchDistance
FROM
     `dicom.instancesView` AS meta
     LEFT JOIN VECTOR_SEARCH (
          TABLE `dicom.instances`,
          'embeddingVector',
          (
               SELECT
                    ml_generate_embedding_result,
                    content AS query
               FROM
                    ML.GENERATE_EMBEDDING (
                         MODEL `dicom.embedding_model`,
                         (
                              SELECT
                                   'no finding' AS content
                         )
                    )
          ),
          top_k = > 1000,
          options = > '{"fraction_lists_to_search": 0.01}'
     ) AS vectorSearch ON meta.id = vectorSearch.base.id
WHERE
     JSON_VALUE (meta.metadata, '$.PatientSex') = 'F'
     AND SAFE_CAST (
          JSON_VALUE (meta.metadata, '$.PatientAge') AS BIGNUMERIC
     ) BETWEEN 30 AND 50
GROUP BY
     StudyInstanceUID
ORDER BY
     TextSearchDistance ASC
LIMIT
     50;