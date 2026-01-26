# Process Command Documentation

## Overview

The `process` command allows you to:
1. Upload a DICOM file to the configured GCS bucket
2. Automatically trigger processing via the deployed CloudRun service
3. Poll BigQuery for the results
4. Display an overview of the processed results

This is useful for testing the deployed infrastructure and retrieving results programmatically.

**For archive file support (.zip, .tar.gz, .tgz)**, see [ARCHIVE_SUPPORT.md](ARCHIVE_SUPPORT.md).

## Prerequisites

- A deployed dcm2bq infrastructure (via Terraform)
- A deployment configuration file containing GCS and BigQuery information
- Google Cloud credentials configured (via `GOOGLE_APPLICATION_CREDENTIALS` or ADC)
- The `@google-cloud/storage` and `@google-cloud/bigquery` npm packages installed

## Creating a Deployment Config File

### Option 1: Use the helper script

Run the provided helper script to automatically extract Terraform outputs and create a config file:

```bash
node helpers/create-deployment-config.js --terraform-dir ./tf --output deployment-config.json
```

This creates a JSON file with the required configuration from your Terraform deployment.

### Option 2: Manual creation

Create a JSON file (e.g., `deployment-config.json`) with the following structure:

```json
{
  "gcpConfig": {
    "projectId": "my-gcp-project",
    "gcs_bucket_name": "dcm2bq-dicom-bucket-abc12345",
    "bigQuery": {
      "datasetId": "dicom",
      "instancesTableId": "instances"
    },
    "embedding": {
      "input": {
        "gcsBucketPath": "gs://dcm2bq-processed-data-abc12345"
      }
    }
  }
}
```

Get these values from:
- Terraform: `terraform output` in the tf/ directory
- GCP Console: Cloud Run, BigQuery, Cloud Storage

## Usage

### Basic usage

The command automatically uses `test/testconfig.json` if available, so the simplest usage is:

```bash
node src/index.js process <input-dicom-file>
```

Or provide a custom config file:

```bash
node src/index.js process <input-dicom-file> --config <deployment-config-file>
```

### Example

```bash
node src/index.js process test/files/dcm/ct.dcm
```

This uses the default `test/testconfig.json` if it exists (created by deployment).

### With custom config file

```bash
node src/index.js process test/files/dcm/ct.dcm --config deployment-config.json
```

### With custom polling options

```bash
node src/index.js process test/files/dcm/ct.dcm \
  --poll-interval 1000 \
  --poll-timeout 30000 \
  --poll-timeout-per-mb 5000
```

## Options

- `--config <deploymentConfig>` (optional)
  - Path to the deployment configuration file containing GCS bucket and BigQuery table information
  - If not provided, defaults to `test/testconfig.json` if it exists
  - Otherwise, use the helper script to generate one: `node helpers/create-deployment-config.js --terraform-dir ./tf`

- `--poll-interval <ms>` (default: 2000)
  - Interval between BigQuery polling attempts in milliseconds
  - Shorter intervals = more frequent checks but higher API costs
  - Longer intervals = less frequent checks but longer wait times

- `--poll-timeout <ms>` (default: 60000)
  - Base maximum time to wait for results in milliseconds
  - This is the timeout for small files

- `--poll-timeout-per-mb <ms>` (default: 10000)
  - Additional timeout time per MB of input file size
  - Total timeout = `--poll-timeout` + (file_size_MB × `--poll-timeout-per-mb`)
  - Allows larger files more time to process

## How It Works

1. **Validation**: Checks that the input file exists and the config file is valid
2. **Upload**: Uploads the DICOM file to the configured GCS bucket with a timestamped, hashed filename
3. **Notification**: GCS triggers a Pub/Sub event that notifies CloudRun
4. **Processing**: The deployed CloudRun service processes the file and writes results to BigQuery
5. **Polling**: Repeatedly queries BigQuery for the result row until found or timeout
6. **Results**: Displays an overview of the processing results including metadata, patient info, and embedding details

## Example Output

```
Processing file: test/files/dcm/ct.dcm
File size: 1234567 bytes (1.18 MB)
✓ Loaded deployment config from: test/testconfig.json

Polling for results (interval: 2000ms, max time: 69000ms)...
✓ Found result in BigQuery after 5 polls (8234ms)

=== Processing Result Overview ===
Path: gs://dcm2bq-dicom-bucket-abc12345/uploads/1705089600000_a1b2c3d4_ct.dcm
Timestamp: 2024-01-12 15:40:00.000000 UTC
Version: 0
Event: OBJECT_FINALIZE
Input Size: 1234567 bytes
Input Type: GCS
Embedding Model: multimodalembedding@001
Embedding Input Path: gs://dcm2bq-processed-data-abc12345/embeddings/...
  Size: 45678 bytes
  MIME Type: image/jpeg
Patient Name: John^Doe
Patient ID: 12345678
Study Date: 20240112
Modality: CT
===================================
```

## Timeout Calculation

For single DICOM files, timeout is calculated as:

```
total_timeout = poll_timeout + (file_size_in_mb × poll_timeout_per_mb)
```

**Examples:**
- 1 MB file: 60000 + (1 × 10000) = 70000 ms (70 seconds)
- 10 MB file: 60000 + (10 × 10000) = 160000 ms (160 seconds)
- 50 MB file: 60000 + (50 × 10000) = 560000 ms (560 seconds)

**Note:** Archive files receive an additional +30 seconds for extraction. See [ARCHIVE_SUPPORT.md](ARCHIVE_SUPPORT.md) for details.

## Error Handling

The command will exit with an error message if:
- Input file doesn't exist
- Config file not found or invalid
- Config file missing required fields
- GCS upload fails
- BigQuery query fails (though it will retry)

## Troubleshooting

### "Deployment config file not found"
- Check the path to your config file
- Ensure it exists and is readable
- Run the helper script to generate it from Terraform outputs

### "Timeout waiting for result"
- The file may still be processing
- Increase `--poll-timeout-per-mb` to wait longer
- Check BigQuery manually to verify the result was created
- Check CloudRun logs for processing errors

### "Failed to upload file to GCS"
- Check GCP credentials are configured
- Verify the GCS bucket name in the config file
- Ensure your service account has `storage.objectAdmin` role

### "BigQuery query failed"
- Check GCP credentials and project ID
- Verify the dataset and table IDs in the config file
- Ensure the service account has `bigquery.dataEditor` role

## Manual BigQuery Query

If the polling times out, you can manually query BigQuery to check the result:

```sql
SELECT *
FROM `PROJECT_ID.DATASET_ID.TABLE_ID`
WHERE path = 'gs://BUCKET/uploads/...'
ORDER BY timestamp DESC
LIMIT 1
```

Replace with actual values from your deployment config.

## Related Documentation

- [Archive Support](ARCHIVE_SUPPORT.md) - Processing ZIP, TAR.GZ, and TGZ archives
- [Implementation Details](PROCESS_COMMAND_IMPLEMENTATION.md) - Technical architecture
- [Test Coverage](TEST_COVERAGE_PROCESS_COMMAND.md) - Test suite documentation
