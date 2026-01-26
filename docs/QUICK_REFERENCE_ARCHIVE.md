# Quick Reference: Archive File Processing

**For comprehensive details, see [ARCHIVE_SUPPORT.md](ARCHIVE_SUPPORT.md)**

## Command Examples

```bash
# Single DICOM file
node src/index.js process my-file.dcm --config deployment-config.json

# ZIP archive
node src/index.js process study-archive.zip --config deployment-config.json

# TAR.GZ archive
node src/index.js process study-archive.tar.gz --config deployment-config.json

# With custom timeouts
node src/index.js process large-archive.zip --config deployment-config.json \
  --poll-timeout 180000 --poll-timeout-per-mb 15000
```

## At a Glance

| Aspect | Single File | Archive |
|--------|------------|---------|
| Query Method | Exact path match | Timestamp range |
| Results Expected | 1 entry | Multiple entries (one per file) |
| Extra Timeout | None | +30 seconds for extraction |
| Typical Process | ~70s for 1MB | ~130-1030s (depends on size) |

## What Gets Created in BigQuery

### Single File
```
1 row with path like: gs://bucket/uploads/{timestamp}_{hash}_ct.dcm
```

### Archive
```
Multiple rows (one per DICOM extracted)
Each with path like: gs://bucket/uploads/{timestamp}_{hash}_study.zip/{extracted-file}.dcm
```

## Timeout Formula

```
Single file: 60s + (size_mb × 10s)
Archive:     60s + (size_mb × 10s) + 30s (extraction bonus)
```

**Examples:**
- 1 MB single: ~70 seconds
- 10 MB archive: ~190 seconds  
- 100 MB archive: ~1090 seconds

## Supported Formats

**Archives:**
- `.zip` - ZIP compression
- `.tgz` - TAR + GZIP
- `.tar.gz` - TAR + GZIP (alternative extension)

## Common Issues & Fixes

| Problem | Check |
|---------|-------|
| "No result found" | File still processing? Increase timeout with `--poll-timeout-per-mb 15000` |
| "Input file not found" | Check file path and working directory |
| "Config file required" | Add `--config deployment-config.json` |
| "Config has missing fields" | Regenerate config with `node helpers/create-deployment-config.js --terraform-dir ./tf` |

## Manual BigQuery Queries

**Single file:**
```sql
SELECT * FROM `PROJECT.DATASET.instances`
WHERE path = 'gs://bucket/uploads/1705089600000_abc123_file.dcm'
LIMIT 1
```

**Archive (all files from it):**
```sql
SELECT * FROM `PROJECT.DATASET.instances`
WHERE timestamp >= TIMESTAMP('2024-01-12T15:40:00Z')
  AND timestamp <= TIMESTAMP('2024-01-12T15:50:00Z')
  AND path LIKE '%archive.zip%'
ORDER BY timestamp DESC
```

## Quick Links

- **Full Guide**: [ARCHIVE_SUPPORT.md](ARCHIVE_SUPPORT.md)
- **Process Command**: [PROCESS_COMMAND.md](PROCESS_COMMAND.md)
- **Tests**: [TEST_COVERAGE_PROCESS_COMMAND.md](TEST_COVERAGE_PROCESS_COMMAND.md)
