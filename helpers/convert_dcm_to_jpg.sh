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

if ! command -v gdcmconv &> /dev/null; then
    echo "Error: gdcmconv command not found. Please install GDCM."
    exit 1
fi

if ! command -v dcm2img &> /dev/null; then
    echo "Error: dcm2img command not found. Please install dcm2img."
    exit 1
fi

# Usage: convert_dcm_to_jpg.sh <input_dicom_file> <output_jpg_file> [frame_number]
if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
    echo "Usage: $0 <input_dicom_file> <output_jpg_file> [frame_number]"
    exit 1
fi

INPUT_FILE="$1"
OUTPUT_JPG_FILE="$2"
FRAME_NUMBER="1" # Default to first frame (dcm2img uses 1-based frame index)
if [ "$#" -eq 3 ]; then
    FRAME_NUMBER="$3"
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

TEMP_DCM_FILE=$(mktemp --suffix=.dcm)
TEMP_NORMALIZED_DCM_FILE=$(mktemp --suffix=.dcm)
trap 'rm -f "${TEMP_DCM_FILE}" "${TEMP_NORMALIZED_DCM_FILE}"' EXIT

render_with_fallbacks() {
    local source_file="$1"

    if ! dcm2img --scale-x-size 512 --frame "$FRAME_NUMBER" --use-modality --use-window 1 "${source_file}" "${OUTPUT_JPG_FILE}"; then
        if ! dcm2img --scale-x-size 512 --frame "$FRAME_NUMBER" --use-modality --histogram-window 1 "${source_file}" "${OUTPUT_JPG_FILE}"; then
            if ! dcm2img --scale-x-size 512 --frame "$FRAME_NUMBER" --use-modality --min-max-window "${source_file}" "${OUTPUT_JPG_FILE}"; then
                dcm2img --scale-x-size 512 --frame "$FRAME_NUMBER" "${source_file}" "${OUTPUT_JPG_FILE}"
            fi
        fi
    fi
}

render_succeeded=false

# Fixes https://github.com/GoogleCloudPlatform/dcm2bq/issues/25
# Convert to explicit raw (uncompressed) DICOM to preserve grayscale fidelity.
if gdcmconv --raw "${INPUT_FILE}" "${TEMP_DCM_FILE}"; then
    if render_with_fallbacks "${TEMP_DCM_FILE}"; then
        render_succeeded=true
    fi
else
    echo "Warning: gdcmconv --raw failed; falling back to original DICOM for rendering." >&2
fi

if [ "${render_succeeded}" = false ]; then
    if render_with_fallbacks "${INPUT_FILE}"; then
        render_succeeded=true
    fi
fi

# Handle malformed files with non-standard photometric interpretation values.
if [ "${render_succeeded}" = false ] && command -v dcmdump &> /dev/null && command -v dcmodify &> /dev/null; then
    PHOTOMETRIC_INTERPRETATION=$(dcmdump +P "0028,0004" "${INPUT_FILE}" 2>/dev/null | sed -n 's/.*\[\([^]]*\)\].*/\1/p' | head -n 1)

    if [ "${PHOTOMETRIC_INTERPRETATION}" = "RGB_NORMAL" ]; then
        echo "Warning: Non-standard PhotometricInterpretation=RGB_NORMAL detected; normalizing to RGB and retrying." >&2
        cp "${INPUT_FILE}" "${TEMP_NORMALIZED_DCM_FILE}"
        dcmodify -nb -m "(0028,0004)=RGB" "${TEMP_NORMALIZED_DCM_FILE}" >/dev/null

        if gdcmconv --raw "${TEMP_NORMALIZED_DCM_FILE}" "${TEMP_DCM_FILE}"; then
            if render_with_fallbacks "${TEMP_DCM_FILE}"; then
                render_succeeded=true
            fi
        fi

        if [ "${render_succeeded}" = false ] && render_with_fallbacks "${TEMP_NORMALIZED_DCM_FILE}"; then
            render_succeeded=true
        fi
    fi
fi

if [ "${render_succeeded}" = false ]; then
    echo "Error: Could not render DICOM image to JPG after all conversion attempts." >&2
    exit 1
fi

echo "Successfully created ${OUTPUT_JPG_FILE}"
