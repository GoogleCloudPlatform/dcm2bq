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
