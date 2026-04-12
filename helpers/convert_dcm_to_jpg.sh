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

set -euo pipefail

if ! command -v dcmnorm &> /dev/null; then
    echo "Error: dcmnorm command not found. Please install dcmnorm."
    exit 1
fi

# Usage: convert_dcm_to_jpg.sh <input_dicom_file> <output_jpg_file> [frame_number]
if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
    echo "Usage: $0 <input_dicom_file> <output_jpg_file> [frame_number]"
    exit 1
fi

INPUT_FILE="$1"
OUTPUT_JPG_FILE="$2"
FRAME_NUMBER=""
if [ "$#" -eq 3 ]; then
    FRAME_NUMBER="$3"
    if ! [[ "${FRAME_NUMBER}" =~ ^[0-9]+$ ]]; then
        echo "Error: frame_number must be a non-negative integer (0-based)." >&2
        exit 1
    fi
fi

if [[ ! "$INPUT_FILE" == *.dcm ]]; then
    echo "Error: Input file must have a .dcm extension."
    exit 1
fi

if [[ ! "$OUTPUT_JPG_FILE" == *.jpg ]]; then
    echo "Error: Output file must have a .jpg extension."
    exit 1
fi

echo "Converting ${INPUT_FILE} to ${OUTPUT_JPG_FILE}..."

ARGS=("${INPUT_FILE}" "${OUTPUT_JPG_FILE}" "--render-format" "jpeg" "--jpeg-quality" "90" "--scale-max-size" "512")

if [ -n "${FRAME_NUMBER}" ]; then
    ARGS+=("--render-frame" "${FRAME_NUMBER}")
fi

if ! dcmnorm "${ARGS[@]}"; then
    echo "Error: Could not render DICOM image to JPG using dcmnorm." >&2
    exit 1
fi

echo "Successfully created ${OUTPUT_JPG_FILE}"
