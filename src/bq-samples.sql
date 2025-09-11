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
SELECT * FROM `dicom.metadata` ORDER BY timestamp DESC LIMIT 10;

-- Event groupings
SELECT COUNT(*) as count, JSON_VALUE(`info`, "$.event") AS eventType
FROM `dicom.metadata` GROUP BY eventType;

-- Get last 5 recent rows from view
SELECT * FROM `dicom.metadataView` ORDER BY timestamp DESC LIMIT 10;

-- Show largest studies
SELECT COUNT(*) as StudyInstances, JSON_VALUE(`metadata`, "$.StudyInstanceUID") AS StudyUID, SUM(LAX_INT64(JSON_QUERY(`info`, "$.storage.size"))) AS StorageSize
FROM `dicom.metadataView` GROUP BY StudyUID ORDER BY StudyInstances DESC LIMIT 10;

-- Show total size of all studies
SELECT COUNT(*) as TotalInstances, SUM(LAX_INT64(JSON_QUERY(`info`, "$.storage.size"))) AS StorageSize
FROM `dicom.metadataView`;

-- Find a particular study by StudyUID
SELECT * from `dicom.metadataView` WHERE JSON_VALUE(`metadata`, '$.StudyInstanceUID') = '1.2.840.123456789456789456789.2.2223447302877.1';

-- Show the latest instances that have failed parsing
SELECT MAX(publish_time) as latest_time, COUNT(*) AS occurences, CONCAT('gs://', JSON_VALUE(`attributes`, '$.bucketId'), '/', JSON_VALUE(`attributes`, '$.objectId')) AS gcsPath FROM `pubsub.deadletter` GROUP BY gcsPath ORDER BY latest_time DESC LIMIT 10;

-- Check pubsub messages (if replicated)
SELECT * FROM `pubsub.messages` ORDER BY publish_time DESC LIMIT 10;

-- If doing a vector search on the embeddings table, make sure to create an embeddings model connection and a vector index first.
CREATE OR REPLACE MODEL `dicom.embedding_model`
REMOTE WITH CONNECTION DEFAULT
OPTIONS (ENDPOINT = 'multimodalembedding@001');

CREATE OR REPLACE VECTOR INDEX `dicom.embedding_index`
ON `dicom.embeddings`(embeddings)
OPTIONS(index_type = 'IVF', distance_type = 'COSINE');

-- Show embeddings table
SELECT * FROM `dicom.embeddings` ORDER BY timestamp DESC LIMIT 10;

