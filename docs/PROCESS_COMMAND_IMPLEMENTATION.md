# Process Command Implementation Summary

## Overview

I've added a new `process` command to the dcm2bq CLI that orchestrates the complete workflow of:
1. Uploading a DICOM file to GCS
2. Relying on the deployed CloudRun service to process it (via Pub/Sub notifications)
3. Polling BigQuery for the results
4. Displaying a formatted overview of the processing results

For detailed usage instructions, see [PROCESS_COMMAND.md](PROCESS_COMMAND.md).

## Files Created/Modified

### Modified Files

1. **[src/index.js](src/index.js)**
   - Added new `process` command with arguments and options
   - Loads the process-command module and delegates execution

### New Files

1. **[src/process-command.js](src/process-command.js)** - Core implementation (390 lines)
   - `isArchiveFile(filePath)`: Detects `.zip`, `.tgz`, `.tar.gz` archive files
   - `loadDeploymentConfig(configPath)`: Loads and validates deployment config from JSON file
   - `uploadToGCS(filePath, bucketName)`: Uploads file to GCS with timestamped, hashed filename
   - `pollBigQueryForResult(options)`: Smart polling with different strategies for single files vs archives
   - `calculatePollTimeout(fileSizeBytes, baseTimeout, timeoutPerMB)`: Scales timeout based on file size
   - `formatResultRow(row)`: Formats a single BigQuery result row
   - `formatResultOverview(results, isArchive)`: Formats results for display (single or archive)
   - `execute(inputFile, options)`: Main orchestration function

2. **[helpers/create-deployment-config.js](helpers/create-deployment-config.js)** - Helper utility
   - Extracts Terraform outputs and creates deployment config JSON
   - Can be run standalone to generate config files

## Key Implementation Details

### Archive File Detection
- Checks file extensions: `.zip`, `.tgz`, `.tar.gz`
- Uses regex pattern matching for `.tar.gz` variant
- Case-insensitive detection

### Smart Polling Strategy

**For Single DICOM Files:**
- Queries BigQuery by exact GCS path
- Returns immediately when found
- Expects 1 result

**For Archive Files:**
- Queries BigQuery by timestamp range (±1 minute around upload time)
- Waits for first result, then continues collecting for 5 additional seconds
- Allows multiple results to be collected as individual files finish processing
- Expects multiple results (one per extracted DICOM file)

### Adaptive Timeout Calculation

```javascript
total_timeout = base_timeout + (file_size_mb × timeout_per_mb) + (isArchive ? 30000 : 0)
```

Defaults:
- Base: 60 seconds (configurable with `--poll-timeout`)
- Per-MB: 10 seconds (configurable with `--poll-timeout-per-mb`)
- Archive bonus: 30 seconds (added automatically for archives)

Examples:
- 1 MB single file: 60 + 10 = 70 seconds
- 10 MB archive: 60 + 100 + 30 = 190 seconds
- 100 MB archive: 60 + 1000 + 30 = 1090 seconds

### Result Handling

Both single files and archives return an array of results from `pollBigQueryForResult()`:
- Single files: Array with 1 result
- Archives: Array with N results (one per extracted DICOM)

The display logic (`formatResultOverview()`) automatically adapts:
- Single result: Shows simple overview
- Multiple results: Shows list of results + summary statistics (total size, modalities)

### Result Formatting

Extracts and displays from BigQuery rows:
- Path and metadata timestamps
- Patient information (name, ID, DOB)
- Study information (date, modality, description)
- Embedding details (model, extracted content paths, sizes, MIME types)
- Processing event information (event type, input metadata)

## Integration with Deployment

- Works seamlessly with existing Terraform-deployed infrastructure
- Leverages existing Pub/Sub → CloudRun → BigQuery pipeline
- No changes needed to deployment or CloudRun service
- Deployment config file connects CLI to deployed resources

## Usage Examples

### Basic single file processing
```bash
node src/index.js process test/files/dcm/ct.dcm --config deployment-config.json
```

### Archive file processing
```bash
node src/index.js process study-archive.zip --config deployment-config.json
```

### Custom polling options
```bash
node src/index.js process test/files/dcm/ct.dcm \
  --config deployment-config.json \
  --poll-interval 1000 \
  --poll-timeout 30000 \
  --poll-timeout-per-mb 5000
```

### Generate config from Terraform
```bash
node helpers/create-deployment-config.js --terraform-dir ./tf
```

For detailed usage and configuration instructions, see [PROCESS_COMMAND.md](PROCESS_COMMAND.md).
  "gcs_processed_data_bucket_name": "dcm2bq-processed-data-abc12345"
}
```

Can be generated from Terraform outputs using the helper script or created manually.

## How It Works

1. **Validation Phase**
   - Checks input file exists
   - Loads and validates deployment config

2. **Upload Phase**
   - Reads file from local disk
   - Uploads to GCS bucket specified in config
   - Generates unique object name: `uploads/{timestamp}_{hash}_{filename}`

3. **Trigger Phase**
   - GCS notification triggers Pub/Sub (no action needed from command)
   - Pub/Sub pushes to CloudRun service
   - CloudRun processes DICOM and writes to BigQuery

4. **Poll Phase**
   - Queries BigQuery every `--poll-interval` ms
   - Searches for row with matching path
   - Continues until result found or `--poll-timeout` exceeded
   - Timeout scales based on file size

5. **Result Phase**
   - Formats and displays result overview
   - Shows patient info, embeddings, processing status
   - Or displays timeout message with manual query instructions

## Timeout Behavior

Total polling time = `--poll-timeout` + (file_size_MB × `--poll-timeout-per-mb`)

**Examples:**
- Small file (1 MB): ~70 seconds max
- Medium file (10 MB): ~160 seconds max
- Large file (50 MB): ~560 seconds max

This scales automatically without needing manual timeout adjustments.

## Error Handling

Graceful error handling with clear messages:
- File not found → explain the issue
- Config missing → show required fields
- Upload fails → show GCS error
- BigQuery timeout → show manual query option
- Invalid config → show expected format

## Integration Points

The command integrates seamlessly with:
- Existing GCS bucket from Terraform deployment
- Existing BigQuery dataset and tables from Terraform deployment
- Existing CloudRun service (no service-side changes needed)
- Existing Pub/Sub → CloudRun pipeline

The GCS upload triggers the existing infrastructure to process the file—no changes to deployment code required.

## Future Enhancement Possibilities

- Add `--watch` mode to continue polling until found (no timeout)
- Add `--format` option (JSON, CSV, table) for result output
- Add `--batch-process` to process multiple files
- Add `--follow` option to tail CloudRun logs during processing
- Add result filtering by DICOM attributes
