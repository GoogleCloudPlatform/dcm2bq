# DCM2BQ

`DCM2BQ` (DICOM to BigQuery) is a tool for extracting metadata from DICOM files and loading it into Google BigQuery. It can be run as a standalone CLI or as a containerized service, making it easy to integrate into data pipelines.

This open-source package provides an alternative to the DICOM metadata streaming feature in the Google Cloud Healthcare API. It enables similar functionality for DICOM data stored in other platforms, such as Google Cloud Storage.

## Why DCM2BQ?

Traditional imaging systems like PACS and VNAs offer limited query capabilities over DICOM metadata. By ingesting the complete metadata into BigQuery, you unlock powerful, large-scale analytics and insights from your imaging data.

## Features

-   Parse DICOM Part 10 files.
-   Convert DICOM metadata to a flexible JSON representation.
-   Load DICOM metadata into a BigQuery table.
-   Run as a containerized service, ideal for event-driven pipelines.
-   Run as a command-line interface (CLI) for manual or scripted processing.
-   Handle Google Cloud Storage object lifecycle events (creation, deletion) to keep BigQuery synchronized.
-   Highly configurable to adapt to your needs.

## Installation

### Docker

The service is distributed as a container image. You can find the latest releases on Docker Hub.

```bash
docker pull jasonklotzer/dcm2bq:latest
```

### From Source (for CLI)

To use the CLI, you can install it from the source code.

1.  Ensure you have `node` and `npm` installed. We recommend using nvm.
2.  Clone the repository:
    ```bash
    git clone https://github.com/googlecloudplatform/dcm2bq.git
    ```
3.  Navigate to the directory and install dependencies and the CLI:
    ```bash
    cd dcm2bq
    npm install
    npm install -g .
    ```
4.  Verify the installation:
    ```bash
    dcm2bq --help
    ```

## Usage

### As a Service (Cloud Run)

The recommended deployment uses Google Cloud Storage, Pub/Sub, and Cloud Run.

!Deployment Architecture

The workflow is as follows:

1.  An object operation (e.g., creation, deletion) occurs in a GCS bucket.
2.  A notification is sent to a Pub/Sub topic.
3.  A Pub/Sub subscription pushes the message to a Cloud Run service running the `dcm2bq` container.
4.  The `dcm2bq` container processes the message:
    -   It validates the message schema and checks for a DICOM-like file extension (e.g., `.dcm`).
    -   For new objects, it reads the file from GCS, parses the DICOM metadata, and inserts a JSON representation into BigQuery.
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

## Configuration

Configuration options can be found in the [default config file](./config.defaults.js).

You can override these defaults in two ways:

1.  **Environment Variable:** Set `DCM2BQ_CONFIG` to a JSON string.
    ```bash
    export DCM2BQ_CONFIG='{"bigquery":{"datasetId":"my_dataset","tableId":"my_table"}}'
    ```
2.  **Config File:** Set `DCM2BQ_CONFIG_FILE` to the path of a JSON file containing your overrides.
    ```bash
    # config.json
    # {
    #   "bigquery": {
    #     "datasetId": "my_dataset",
    #     "tableId": "my_table"
    #   }
    # }
    export DCM2BQ_CONFIG_FILE=./config.json
    ```

## Development

To get started with development, follow the installation steps for the CLI.

The `test` directory contains numerous examples and unit tests that are helpful for understanding the codebase and validating changes.

### Running Integration Tests

The test suite includes integration tests for features like Gemini vector embedding generation. These tests make real API calls to Google Cloud services and require a properly configured environment.

To run them:
1.  Ensure you are authenticated with GCP (`gcloud auth application-default login`).
2.  Ensure your project has the Vertex AI API enabled.
3.  Set the `RUN_INTEGRATION_TESTS=true` environment variable.
4.  Run the tests: `RUN_INTEGRATION_TESTS=true npm test`

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](./CONTRIBUTING.md) for details on how to contribute to this project.

## License

This project is licensed under the Apache 2.0 License.
