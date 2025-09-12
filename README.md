# DCM2BQ


`DCM2BQ` (DICOM to BigQuery) is a tool for extracting metadata and generating vector embeddings from DICOM files, loading both into Google BigQuery. It can be run as a standalone CLI or as a containerized service, making it easy to integrate into data pipelines.

By generating vector embeddings for DICOM images, Structured Reports, and PDFs, DCM2BQ enables powerful semantic search and similarity-based retrieval across your medical imaging data. This allows you to find related studies, cases, or reports even when traditional metadata fields do not match exactly.

This open-source package provides an alternative to the DICOM metadata streaming feature in the Google Cloud Healthcare API. It enables similar functionality for DICOM data stored in other platforms, such as Google Cloud Storage.

## Why DCM2BQ?

Traditional imaging systems like PACS and VNAs offer limited query capabilities over DICOM metadata. By ingesting the complete metadata and vector embeddings into BigQuery, you unlock powerful, large-scale analytics and insights from your imaging data.

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
-   Generate vector embeddings from DICOM images, Structured Reports, and encapsulated PDFs using Google's multi-modal embedding model.
-   Highly configurable to adapt to your needs.

## BigQuery schema & embeddings table

The project stores DICOM metadata and embeddings in separate BigQuery tables. By default the service writes:

- a metadata table (JSON fields for full DICOM metadata and processing info), and
- an embeddings table that stores a deterministic `id` (sha256 of `path|version`) and a repeated FLOAT column named `embedding` (the vector).

The Cloud Run service is configured with both table IDs via the `gcpConfig.bigQuery` object (see `config.defaults.js`). Use the `embeddingsTableId` value when running vector searches or creating vector indexes and models.

Note: the project includes sample DDL and queries to create a REMOTE embedding model and a vector index and to inspect the tables — see `src/bq-samples.sql`.

## Example queries

You can find example queries and DDL for creating the REMOTE model and vector index in `src/bq-samples.sql`. The file includes:

- example SELECTs against the metadata and view,
- sample aggregation queries,
- and DDL samples to create an embedding model and a vector index for the embeddings table.

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

The service is distributed as a container image. You can find the latest releases on Docker Hub.

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
    -   It validates the message schema and checks for a DICOM-like file extension (e.g., `.dcm`).
    -   For new objects, it reads the file from GCS and parses the DICOM metadata.
    -   If embeddings are enabled, it generates a vector embedding from the DICOM data (for supported types like images, SRs, and PDFs) by calling the Vertex AI Embeddings API.
    -   It inserts a JSON representation of the metadata and the embedding into BigQuery.
    -   For deleted objects, it records the deletion event in BigQuery.
5.  If an error occurs, the message is NACK'd for retry. After maximum retries, it's sent to a dead-letter topic for analysis.

**Note:** When deploying to Cloud Run, ensure the container has enough memory allocated to handle your largest DICOM files.

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

## Configuration

Configuration options can be found in the [default config file](./config.defaults.js).

You can override these defaults in two ways.

**Important:** When providing an override via environment variable or a file, you must supply the entire configuration object. The default configuration is not merged with your overrides; your provided configuration will be used as-is.

1.  **Environment Variable:** Set `DCM2BQ_CONFIG` to a JSON string containing the full configuration.
    ```bash
    export DCM2BQ_CONFIG='{"bigquery":{"datasetId":"my_dataset","metadataTableId":"my_table"},"gcpConfig":{"projectId":"my-gcp-project","embeddings":{"enabled":true,"model":"multimodalembedding@001"}},"jsonOutput":{...}}'
    ```
2.  **Config File:** Set `DCM2BQ_CONFIG_FILE` to the path of a JSON file containing your full configuration.
    ```bash
    # config.json
    # {
    #   "bigquery": {
    #     "datasetId": "my_dataset",
    #     "metadataTableId": "my_table"
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

To enable vector embedding generation, configure the `embeddings` section within `gcpConfig`.

Example `config.json` override:
```json
{
  "gcpConfig": {
    "embeddings": {
      "enabled": true,
      "model": "multimodalembedding@001",
      "summarizeText": { "enabled": false }
    }
  }
}
```
- Note: the JSON snippet above is a partial example showing only the embeddings-related settings. When providing an override (via `DCM2BQ_CONFIG` or `DCM2BQ_CONFIG_FILE`), you must supply the entire configuration object — partial merges are not supported.

- `enabled`: Set to `true` to activate the feature.
-   `model`: The name of the Vertex AI model to use for generating embeddings.
-   `summarizeText.enabled`: Controls whether extracted text from SR/PDF is summarized before embedding or saving. This can be overridden at runtime by the CLI `--summary` flag.

## Development

To get started with development, follow the installation steps for the CLI.

The `test` directory contains numerous examples, unit tests, and integration tests that are helpful for understanding the codebase and validating changes.

### Running Tests

The test suite is a combination of unit and integration tests. The integration tests make real API calls to Google Cloud services (e.g., for vector embedding generation) and require a properly configured environment.

To run the full test suite:
1.  Ensure you are authenticated with GCP (`gcloud auth application-default login`).
2.  Ensure your project has the necessary APIs enabled (e.g., Vertex AI API).
3.  Run the tests: `npm test`

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
./helpers/deploy.sh [destroy|upload] <gcp_project_id>
```
- `upload`: Upload test DICOM files from `test/files/dcm/*.dcm` to the GCS bucket created by Terraform (standalone; does not deploy).
- `destroy`: Destroy all previously created resources (cleanup).
- `--help` or `-h`: Show usage instructions.

**Examples**

- Deploy infrastructure:
```bash
./helpers/deploy.sh my-gcp-project-id
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

**Example: Destroy all resources**
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
