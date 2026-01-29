# DCM2BQ


`DCM2BQ` (DICOM to BigQuery) is a tool for extracting metadata and generating vector embeddings from DICOM files, loading both into Google BigQuery. It can be run as a standalone CLI or as a containerized service, making it easy to integrate into data pipelines.

By generating vector embeddings for DICOM images, Structured Reports, and PDFs, DCM2BQ enables powerful semantic search and similarity-based retrieval across your medical imaging data. This allows you to find related studies, cases, or reports even when traditional metadata fields do not match exactly.

This open-source package can be used as an alternative to the DICOM metadata streaming feature in the [Google Cloud Healthcare API](https://cloud.google.com/healthcare-api), enabling similar functionality for DICOM data stored in [Google Cloud Storage](https://cloud.google.com/storage). It can also be used to complement a Healthcare API DICOM store by generating embeddings for existing or new data.

## Why DCM2BQ?

Traditional imaging systems like PACS and VNAs offer limited query capabilities over DICOM metadata. By ingesting the complete metadata and vector embeddings into [BigQuery](https://cloud.google.com/bigquery), you unlock powerful, large-scale analytics and insights from your imaging data.

**Benefits of Embedding-Based Search:**

- Go beyond exact field matching: Find similar images, reports, or studies based on visual or textual content, not just metadata.
- Enable content-based retrieval: Search for "cases like this one" or "find similar findings" using embeddings.
- Support multi-modal queries: Use embeddings from images, SRs, and PDFs for unified search across modalities.
- Improve research, cohort discovery, and clinical decision support by surfacing relevant cases that would be missed by keyword or tag-based search alone.

## Features

-   Parse DICOM Part 10 files.
-   Convert DICOM metadata to a flexible JSON representation.
-   Load DICOM metadata and vector embeddings into a BigQuery table.
-   Enable semantic and similarity search over your imaging archive using embeddings.
-   Run as a containerized service, ideal for event-driven pipelines.
-   Run as a command-line interface (CLI) for manual or scripted processing.
-   Handle Google Cloud Storage object lifecycle events (creation, deletion) to keep BigQuery synchronized.
-   Process zip and tar.gz/tgz archives containing multiple DICOM files with a single event.
-   Generate vector embeddings from DICOM images, Structured Reports, and encapsulated PDFs using Google's multi-modal embedding model.
-   Highly configurable to adapt to your needs.

## BigQuery schema

The project stores DICOM metadata and vector embeddings in a single consolidated BigQuery table with the following columns:

- `id`: STRING (REQUIRED) - Deterministic SHA256 hash of `path|version`
- `timestamp`: TIMESTAMP (REQUIRED) - When the record was written
- `path`: STRING (REQUIRED) - Full path to the DICOM file
- `version`: STRING (NULLABLE) - Object version identifier
- `info`: RECORD (REQUIRED) - Processing metadata with structured fields:
  - `event`: STRING - Event type (e.g., OBJECT_FINALIZE)
  - `input`: RECORD - DICOM file metadata (size, type)
  - `embedding`: RECORD - Embedding generation details
    - `model`: STRING - Model used for embedding
    - `input`: RECORD - Object used for embedding (path, size, mimeType)
- `metadata`: JSON (NULLABLE) - Complete DICOM JSON metadata
- `embeddingVector`: FLOAT ARRAY (NULLABLE) - Vector embedding for semantic search

The Cloud Run service is configured with the table ID via the `gcpConfig.bigQuery.instancesTableId` setting (see `config.defaults.js`). Use the `embeddingVector` column when running vector searches or creating vector indexes and models.

Note: the project includes sample DDL and queries — see `src/bq-samples.sql`.

## Example queries

You can find example queries and DDL for creating the embedding model and vector index in `src/bq-samples.sql`. The file includes:

- example SELECTs against the consolidated metadata table,
- sample aggregation queries for vector search,
- and DDL samples to create an embedding model and a vector index on the `embeddingVector` column.

Before running vector searches, ensure you have created the embedding model and vector index (the samples show how to do this with `bq query`).

## Installation

### Dependencies

For image processing and vector embedding generation, `dcm2bq` relies on two external toolkits that must be installed in the execution environment:

-   **DCMTK**: A collection of libraries and applications for working with DICOM files.
-   **GDCM**: A library for reading and writing DICOM files, used here for image format conversion.

These are included in the provided Docker image. If you are building from source or running the CLI locally, you will need to install them manually.

**On Debian/Ubuntu:**
```bash
sudo apt-get update && sudo apt-get install -y dcmtk gdcm-tools
```

### Docker

The service is distributed as a container image. You can find the latest releases on [Docker Hub](https://hub.docker.com/r/jasonklotzer/dcm2bq).

```bash
docker pull jasonklotzer/dcm2bq:latest
```

### From Source (for CLI)

To use the CLI, you can install it from the source code.

1.  Ensure you have `node` and `npm` installed. We recommend using nvm.
2.  Ensure you have installed the required [Dependencies](#dependencies).
3.  Clone the repository:
    ```bash
    git clone https://github.com/googlecloudplatform/dcm2bq.git
    ```
4.  Navigate to the directory and install dependencies and the CLI:
    ```bash
    cd dcm2bq
    npm install
    npm install -g .
    ```
5.  Verify the installation:
    ```bash
    dcm2bq --help
    ```

## Usage

### As a Service (Cloud Run)

The recommended deployment uses Google Cloud Storage, Pub/Sub, and Cloud Run.

![Deployment Architecture](assets/arch.svg)

The workflow is as follows:

1.  An object operation (e.g., creation, deletion) occurs in a GCS bucket.
2.  A notification is sent to a Pub/Sub topic.
3.  A Pub/Sub subscription pushes the message to a Cloud Run service running the `dcm2bq` container.
4.  The `dcm2bq` container processes the message:
    -   It validates the message schema and checks for a DICOM-like file extension (e.g., `.dcm`) or supported archive (`.zip`, `.tar.gz`, `.tgz`).
    -   For new objects, it reads the file from GCS and parses the DICOM metadata.
    -   For archive files, it extracts all `.dcm` files and processes each one individually.
    -   If embeddings are enabled, it generates a vector embedding from the DICOM data (for supported types like images, SRs, and PDFs) by calling the Vertex AI Embeddings API.
    -   It inserts a JSON representation of the metadata and the embedding into BigQuery.
    -   For deleted objects, it records the deletion event in BigQuery.
5.  If an error occurs, the message is NACK'd for retry. After maximum retries, it's sent to a dead-letter topic for analysis.

**Note:** When deploying to Cloud Run, ensure the container has enough memory allocated to handle your largest DICOM files.

The service also supports processing archives (`.zip`, `.tar.gz`, `.tgz`) containing multiple DICOM files. See [docs/ARCHIVE_SUPPORT.md](docs/ARCHIVE_SUPPORT.md) for details.

### As a CLI

The CLI is useful for testing, development, and batch processing.

**Example: Dump DICOM metadata as JSON**

```bash
dcm2bq dump test/files/dcm/ct.dcm | jq
```

This command will output the full DICOM metadata in JSON format, which can be piped to tools like `jq` for filtering and inspection.

**Example: Generate a vector embedding**

```bash
dcm2bq embed test/files/dcm/ct.dcm
```

This command will process the DICOM file, generate a vector embedding using the configured model, and output the embedding as a JSON array.

**Example: Extract rendered image or text from a DICOM file**

```bash
dcm2bq extract test/files/dcm/ct.dcm
```

This command will extract and save a rendered image (JPG) or extracted text (TXT) from the DICOM file, depending on its type (image, SR, or PDF). The output file extension is chosen automatically unless you specify `--output`.

**Example: Extract with summarization (SR/PDF only)**

```bash
dcm2bq extract test/files/dcm/sr.dcm --summary
```

By default, summarization is disabled for extracted text. If you pass `--summary`, the extracted text from Structured Reports (SR) or PDFs will be summarized using Gemini before saving. This is useful for generating concise, embedding-friendly text.

**Example: Extract without summarization (explicitly)**

```bash
dcm2bq extract test/files/dcm/sr.dcm
```

If you do not pass `--summary`, the full extracted text will be saved (subject to length limits for embedding).

**Example: Process a DICOM file and retrieve results from BigQuery**

```bash
dcm2bq process test/files/dcm/ct.dcm
```

This command uploads a DICOM file to GCS, triggers CloudRun processing via Pub/Sub, polls BigQuery for results, and displays a formatted overview. It uses `test/testconfig.json` if available, or you can specify a config file with `--config deployment-config.json`. See [docs/PROCESS_COMMAND.md](docs/PROCESS_COMMAND.md) for detailed usage and archive file support.

**Example: List items in the dead letter queue**

```bash
dcm2bq dlq list
```

This command queries the BigQuery dead letter table and displays a summary showing the total count of failed messages and a list of distinct failed files with their failure counts. Useful for monitoring and troubleshooting processing failures.

**Example: Requeue failed items from the dead letter queue**

```bash
dcm2bq dlq requeue
```

This command reads the dead letter queue, identifies the failed GCS files, and triggers reprocessing by updating their metadata. Each file will be reprocessed via Cloud Run. You can limit the number of items with `--limit 50`.

## Configuration

Configuration options can be found in the [default config file](./src/config.defaults.js).

You can override these defaults in two ways.

**Important:** When providing an override via environment variable or a file, you must supply the entire configuration object. The default configuration is not merged with your overrides; your provided configuration will be used as-is.

1.  **Environment Variable:** Set `DCM2BQ_CONFIG` to a JSON string containing the full configuration.
    ```bash
    export DCM2BQ_CONFIG='{"bigquery":{"datasetId":"my_dataset","instancesTableId":"my_table"},"gcpConfig":{"projectId":"my-gcp-project","embeddings":{"enabled":true,"model":"multimodalembedding@001"}},"jsonOutput":{...}}'
    ```
2.  **Config File:** Set `DCM2BQ_CONFIG_FILE` to the path of a JSON file containing your full configuration.
    ```bash
    # config.json
    # {
    #   "bigquery": {
    #     "datasetId": "my_dataset",
    #     "instancesTableId": "my_table"
    #   },
    #   "gcpConfig": {
    #     "projectId": "my-gcp-project",
    #     "embeddings": {
    #       "enabled": true,
    #       "model": "multimodalembedding@001"
    #     }
    #   },
    #   "jsonOutput": {
    #      ...
    #   }
    # }
    export DCM2BQ_CONFIG_FILE=./config.json
    ```


### Embedding and Summarization Configuration

To enable vector embedding generation and input extraction, configure the `embedding.input` section within `gcpConfig`. The configuration uses a hierarchical structure where the presence of settings indicates they are enabled.

Example `config.json` override:
```json
{
  "gcpConfig": {
    "embedding": {
      "input": {
        "gcsBucketPath": "gs://my-bucket/processed-data",
        "summarizeText": {
          "model": "gemini-2.5-flash-lite",
          "maxLength": 1024
        },
        "vector": {
          "model": "multimodalembedding@001"
        }
      }
    }
  }
}
```

**Note:** The JSON snippet above is a partial example showing only the embeddings-related settings. When providing an override (via `DCM2BQ_CONFIG` or `DCM2BQ_CONFIG_FILE`), you must supply the entire configuration object — partial merges are not supported.

### Embedding Input Configuration

- `embedding.input.gcsBucketPath`: GCS bucket path where processed images (.jpg) and text (.txt) files will be saved. Format: `gs://bucket-name/optional-path`. Files are organized as `{gcsBucketPath}/{StudyInstanceUID}/{SeriesInstanceUID}/{SOPInstanceUID}.{jpg|txt}`. If this is omitted or empty, no files will be saved. **Important:** This bucket should be separate from the DICOM source bucket to avoid triggering unwanted events when processed files are created.
- `embedding.input.vector.model`: If present, vector embeddings will be generated using the specified Vertex AI model (e.g., `multimodalembedding@001`). Omit this section to only extract and save inputs without generating embeddings.

### Text Summarization Configuration

- `embedding.input.summarizeText.model`: If present, long text extracted from SR/PDF will be summarized using the specified Gemini model before processing. Omit this section to skip summarization. This can be overridden at runtime by the CLI `--summary` flag.
- `embedding.input.summarizeText.maxLength`: Maximum character length for summarized text (default: 1024). The summarization prompt instructs the model to keep output under this limit. This also controls when summarization is triggered: text longer than `maxLength` will be summarized when embedding compatibility is required.

## Documentation

Additional documentation on new features and development guides can be found in the [docs](docs/) directory:

### CLI Process Command
- **[docs/PROCESS_COMMAND.md](docs/PROCESS_COMMAND.md)** - Overview and usage of the `dcm2bq process` command for uploading DICOM files and retrieving results
- **[docs/PROCESS_COMMAND_IMPLEMENTATION.md](docs/PROCESS_COMMAND_IMPLEMENTATION.md)** - Implementation details of the process command

### Archive Support
- **[docs/ARCHIVE_SUPPORT.md](docs/ARCHIVE_SUPPORT.md)** - Comprehensive guide to archive file processing (.zip, .tar.gz, .tgz), including usage, timeouts, and troubleshooting
- **[docs/QUICK_REFERENCE_ARCHIVE.md](docs/QUICK_REFERENCE_ARCHIVE.md)** - Quick examples and reference table for common archive scenarios

### Testing
- **[docs/TEST_COVERAGE_PROCESS_COMMAND.md](docs/TEST_COVERAGE_PROCESS_COMMAND.md)** - Comprehensive test coverage documentation for the process command, including unit and integration tests

## Development

To get started with development, follow the installation steps for the CLI.

The `test` directory contains numerous examples, unit tests, and integration tests that are helpful for understanding the codebase and validating changes.

### Running Tests

The unit tests are fully mocked and can be run without any GCP dependencies or configuration files. All external service calls (BigQuery, Cloud Storage, Vertex AI, Gemini) are stubbed to ensure fast, reliable test execution.

To run the unit test suite:

```bash
npm test
# or using the helper script
./helpers/run-unit-tests.sh
```

The tests use a mock configuration defined in [test/test-config.js](test/test-config.js) and don't require any real GCP resources or the `test/testconfig.json` file.

### Integration Tests

For testing against real GCP services, integration test files are available that require:

1. A properly configured `test/testconfig.json` file (generated by running `./helpers/deploy.sh my-project-name`)
2. GCP authentication (`gcloud auth application-default login`)
3. Deployed GCP resources (BigQuery dataset/table, GCS buckets)

**When to run integration tests**
- Run unit tests (`npm test`) locally before sending a PR or release tag; they are fully mocked and fast.
- Run integration tests **only after** deploying the test stack (e.g., `./helpers/deploy.sh upload <project>`) or promoting a build to a staging environment, because they need live GCP resources.
- Recommended checkpoints: after dependency or schema changes, before a release cut once the candidate container is deployed to the test/staging project, and periodically in CI on a schedule against that deployed environment.

Available integration test suites:

- **`semantic_compare.integration.js`** - Tests semantic similarity between text and image embeddings
- **`pipeline.integration.js`** - End-to-end pipeline tests (GCS upload → processing → BigQuery insertion)
- **`storage-embeddings.integration.js`** - Storage and embedding feature tests
- **`config-validation.integration.js`** - Configuration, schema, and permissions validation tests
- **`dead-letter.integration.js`** - Dead letter queue functionality (failed message handling, BigQuery writes, IAM permissions)
- **`error-handling.integration.js`** - Error handling and HTTP status code validation

To run all integration tests:

```bash
npm run test:integration
# or using the helper script directly
./helpers/run-integration-tests.sh
```

Or manually with mocha:

```bash
DCM2BQ_CONFIG_FILE=test/testconfig.json mocha test/*.integration.js
```

To run a specific integration test suite:

```bash
DCM2BQ_CONFIG_FILE=test/testconfig.json mocha test/pipeline.integration.js
```

**Note:** Integration tests make real API calls to Google Cloud services and may incur costs. They also upload test files to GCS and insert rows into BigQuery (cleanup is performed automatically).

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](./CONTRIBUTING.md) for details on how to contribute to this project.

## License

This project is licensed under the Apache 2.0 License.

## Deployment with Terraform

The recommended way to deploy the service and all required Google Cloud resources is using Terraform. This will provision:
- Google Cloud Storage bucket(s)
- Pub/Sub topics and subscriptions
- BigQuery dataset and tables
- Cloud Run service
- All necessary IAM permissions

A helper script is provided to automate the process:

```bash
./helpers/deploy.sh [OPTIONS] [destroy|upload] <gcp_project_id>
```
- `upload`: Upload test DICOM files from `test/files/dcm/*.dcm` to the GCS bucket created by Terraform (standalone; does not deploy).
- `destroy`: Destroy all previously created resources (cleanup).
- `--debug`: Enable debug mode with verbose logging in the Cloud Run service.
- `--help` or `-h`: Show usage instructions.

**Examples**

- Deploy infrastructure:
  ```bash
  ./helpers/deploy.sh my-gcp-project-id
  ```

- Deploy with debug mode enabled:
  ```bash
  ./helpers/deploy.sh --debug my-gcp-project-id
  ```

- Upload test data only (no deploy):
  ```bash
  ./helpers/deploy.sh upload my-gcp-project-id
  ```

- Deploy and then upload test data (two steps):
  ```bash
  ./helpers/deploy.sh my-gcp-project-id
  ./helpers/deploy.sh upload my-gcp-project-id
  ```

- Destroy all resources:
  ```bash
  ./helpers/deploy.sh destroy my-gcp-project-id
  ```

The script will:
1. Ensure all dependencies (Terraform, gcloud, gsutil) are installed.
2. Create a GCS bucket for Terraform state (if needed).
3. Generate a backend config for Terraform.
4. Deploy all infrastructure using Terraform.
5. Optionally upload test DICOM files if the flag is supplied.

> **Note:** All resource names (buckets, datasets, tables, etc.) are made unique per deployment to avoid collisions.
