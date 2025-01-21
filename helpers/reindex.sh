#!/usr/bin/env bash
set -e # -x

#
# Helper script to (re)index the DICOM objects from a GCS bucket
# You may want to run this on a given bucket for various reasons, such as if notifications were not previously set or if output expectations have significantly changed.
#
# The logic is the following:
#   1. A metadata KVP ("dcm2bq-reindex:true") will be added to every object that meets the given pattern.
#   2. This will generate a OBJECT_METADATA_UPDATE notification on the bucket, which will be picked up by the dcm2bq service.
#   3. The dcm2bq service will see this metadata update as a request to (re)index the object, and then do so.  
#
# Notes: 
#   1. Please make sure to have the dcm2bq service running before using this script.
#   2. There may be additional costs associated with setting the metadata on objects, due to initial StorageClass or other factors.
#

if [ $# -ne 1 ]; then
  echo "Usage: reindex.sh <gcsObjectPattern> (example: gs://dicom-bucket/**/*.dcm)"
  exit 1
fi

OBJ_PATTERN=${1}

# The below sets a metadata value on each object that matches the object pattern in the provided bucket.
gsutil -m setmeta -h "x-goog-meta-dcm2bq-reindex:true" ${OBJ_PATTERN}