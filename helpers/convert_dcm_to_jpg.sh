#!/bin/bash

# Copyright 2025 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

set -e

if ! command -v gdcmconv &> /dev/null; then
    echo "Error: gdcmconv command not found. Please install GDCM."
    exit 1
fi

if ! command -v dcm2img &> /dev/null; then
    echo "Error: dcm2img command not found. Please install dcm2img."
    exit 1
fi

if [ "$#" -ne 2 ]; then
    echo "Usage: $0 <input_dicom_file> <output_jpg_file>"
    exit 1
fi

INPUT_FILE="$1"
OUTPUT_JPG_FILE="$2"

if [[ ! "$INPUT_FILE" == *.dcm ]]; then
    echo "Error: Input file must have a .dcm extension."
    exit 1
fi

if [[ ! "$OUTPUT_JPG_FILE" == *.jpg ]]; then
    echo "Error: Output file must have a .jpg extension."
    exit 1
fi

TEMP_DCM_FILE=$(mktemp --suffix=.dcm)

echo "Converting ${INPUT_FILE} to ${OUTPUT_JPG_FILE}..."

# Convert DICOM to JPEG-compressed DICOM, then extract JPEG, then clean up
gdcmconv --jpeg "${INPUT_FILE}" "${TEMP_DCM_FILE}" && \
dcm2img --scale-x-size 512 "${TEMP_DCM_FILE}" "${OUTPUT_JPG_FILE}" && \
rm -f "${TEMP_DCM_FILE}"

echo "Successfully created ${OUTPUT_JPG_FILE}"
