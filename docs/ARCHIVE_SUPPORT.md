# Archive File Support

The `process` command supports archive files (ZIP, TAR.GZ, TGZ) containing multiple DICOM files for batch processing.

## Supported Formats

- **ZIP** (`.zip`)
- **TAR GZIP** (`.tar.gz`, `.tgz`)

## How It Works

### Upload & Processing Flow

1. **Upload**: Archive file is uploaded to GCS with timestamped, hashed name
2. **Extraction**: CloudRun service receives notification and extracts the archive
3. **Processing**: Each DICOM file is processed individually (metadata extraction, embeddings, etc.)
4. **Results**: Each file creates a separate BigQuery entry under the archive's base path

### Polling Strategy

#### Single DICOM Files
- Query by exact GCS path
- Return immediately when found
- Expects 1 result

#### Archive Files
- Query by timestamp range (±1 minute around upload time)
- Wait for first result, then continue collecting for 5 additional seconds to capture all extracted files
- Expects multiple results

## Timeout Behavior

Archives require additional time for extraction. Timeout is calculated as:

```
total_timeout = base_timeout + (file_size_mb × timeout_per_mb) + 30000ms
```

**Defaults:**
- Base timeout: 60 seconds
- Per-MB timeout: 10 seconds  
- Archive extraction bonus: 30 seconds

**Examples:**
- Single 1 MB file: ~70 seconds
- 10 MB archive: ~130 seconds
- 100 MB archive: ~1030 seconds

## Example Usage

```bash
# Single DICOM file
node src/index.js process patient-study.dcm --config deployment-config.json

# ZIP archive
node src/index.js process studies-batch.zip --config deployment-config.json

# TAR.GZ archive
node src/index.js process studies-batch.tar.gz --config deployment-config.json

# Custom timeout for large archives
node src/index.js process large-batch.zip --config deployment-config.json \
  --poll-timeout 180000 --poll-timeout-per-mb 15000
```

## Output & Results

### Single File Example

```
Processing DICOM file: patient-study.dcm

=== Processing Result Overview ===
Path: gs://bucket/uploads/1705089600000_a1b2c3d4_patient-study.dcm
Patient Name: Doe^John
Modality: CT
Study Date: 2024-01-12
Series Description: CT Chest
===================================
```

### Archive Example

```
Processing archive: studies-batch.zip
Note: Archive files are expanded and processed as separate DICOM files

=== Archive Processing Results ===
Total files processed: 3

--- Result 1 ---
Path: gs://bucket/uploads/1705089600000_a1b2c3d4_studies-batch.zip/study1.dcm
Patient Name: Smith^Jane
Modality: MR
Study Date: 2024-01-10

--- Result 2 ---
Path: gs://bucket/uploads/1705089600000_a1b2c3d4_studies-batch.zip/study2.dcm
Patient Name: Johnson^Bob
Modality: CT
Study Date: 2024-01-11

--- Result 3 ---
Path: gs://bucket/uploads/1705089600000_a1b2c3d4_studies-batch.zip/study3.dcm
Patient Name: Williams^Alice
Modality: US
Study Date: 2024-01-12

--- Summary ---
Total size: 450 MB
Modalities: CT, MR, US
===================================
```

## Implementation Details

### Archive File Detection

The system automatically detects archive files by extension:
- Checks for `.zip`, `.tgz`, or `.tar.gz` extensions
- Applies archive-specific timeout and polling logic

### Result Handling

- **Single files**: Returns array with 1 result
- **Archives**: Returns array with N results (one per extracted DICOM)
- Both cases use the same display logic for consistent output

### Database Queries

The command uses BigQuery to retrieve results. You can manually run these queries if needed:

**Single file query:**
```sql
SELECT * FROM `PROJECT.DATASET.instances`
WHERE path = 'gs://bucket/uploads/1705089600000_a1b2c3d4_file.dcm'
LIMIT 1
```

**Archive query (retrieve all files from an archive):**
```sql
SELECT * FROM `PROJECT.DATASET.instances`
WHERE timestamp >= TIMESTAMP('2024-01-12T15:40:00Z')
  AND timestamp <= TIMESTAMP('2024-01-12T15:50:00Z')
  AND metadata IS NOT NULL
ORDER BY timestamp DESC
```

## Troubleshooting

### "No result found after timeout"
- Check CloudRun service logs for processing errors
- Verify the configuration file is correct and has valid GCP credentials
- For large archives, consider increasing `--poll-timeout`
- Verify DICOM files are valid and readable

### "Deployment config file required"
- Ensure you're passing `--config deployment-config.json`
- Run the deployment helper script to generate a valid config: `./helpers/deploy.sh my-project`

### "Missing required field in config"
- Regenerate the configuration file using the deployment helper
- Check config file for required fields: `projectId`, `bucketName`, `datasetId`, `instancesTableId`

### Archive extracts but no results in BigQuery
- Check CloudRun logs for processing errors during metadata extraction
- Verify embeddings are not causing timeouts (check Gemini/Vertex AI quotas)
- Ensure BigQuery table has sufficient quota for insertions

## Related Documentation

- [Process Command Guide](PROCESS_COMMAND.md) - General usage of the process command
- [Quick Reference](QUICK_REFERENCE_ARCHIVE.md) - Quick examples and checklists
- [Test Coverage](TEST_COVERAGE_PROCESS_COMMAND.md) - Unit and integration test details
