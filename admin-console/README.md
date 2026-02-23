# dcm2bq Admin Console (Standalone)

This project separates the admin console into its own deployable Node.js service.

## What the Admin Console Does

The admin console is a standalone UI for exploring DICOM studies and instance data stored in BigQuery, with deep links into the associated assets stored in GCS.

### Core capabilities

- **Study and instance browsing** backed by `instancesView`
- **Metadata inspection** (normalized study metadata and full instance metadata JSON)
- **Content preview** for extracted embedding inputs (images/text)
- **Embeddings visibility** (presence and vector length)
- **Monitoring** for instance/DLQ counts and recent activity
- **Study actions** for reprocess and delete
- **Dead letter queue** summary, requeue, and delete
- **Upload and process** a single file for quick validation

### Data sources

- BigQuery `instancesView` (not the raw `instances` table)
- BigQuery dead letter table
- GCS for original and extracted assets

### Configuration notes

- Set `BQ_INSTANCES_VIEW_ID` to your dataset's `instancesView` (all read/search endpoints use this view).
- Set `BQ_INSTANCES_TABLE_ID` only if you use delete endpoints (`/api/studies/delete`, `/api/instances/delete`) and need a writable base table.
- Set `BQ_DEAD_LETTER_TABLE_ID` to your dead letter table.

### Local development

- `npm run dev` runs with `NODE_ENV=test` (to reuse local test config), but defaults `BQ_INSTANCES_VIEW_ID` to `instancesView` so queries use the view instead of raw `instances`.
- To target a different view, set `BQ_INSTANCES_VIEW_ID` before running `npm run dev`.

### Deployment (brief)

Use the standalone admin console Terraform in [terraform/README.md](terraform/README.md) for Cloud Run deployment.

### Permissions

- BigQuery read access to `instancesView` and the dead letter table
- GCS read/write access for original and extracted assets (write is required for reprocess metadata updates and upload workflows)
