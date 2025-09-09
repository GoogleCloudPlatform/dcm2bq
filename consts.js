/*
 Copyright 2025 Google LLC

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

      https://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
 */

// Events from https://cloud.google.com/storage/docs/pubsub-notifications#events
const GCS_OBJ_ARCHIVE = "OBJECT_ARCHIVE";
const GCS_OBJ_DELETE = "OBJECT_DELETE";
const GCS_OBJ_FINALIZE = "OBJECT_FINALIZE";
const GCS_OBJ_METADATA_UPDATE = "OBJECT_METADATA_UPDATE";
const GCS_EVENT_TYPES = [GCS_OBJ_ARCHIVE, GCS_OBJ_DELETE, GCS_OBJ_FINALIZE, GCS_OBJ_METADATA_UPDATE];

const HCAPI_FINALIZE = "HCAPI_FINALIZE";
const HCAPI_EVENT_TYPES = [HCAPI_FINALIZE];

const GCS_PUBSUB_MSG_V1 = "JSON_API_V1";
const GCS_PUBSUB_UNWRAP = "GCS_PUBSUB_UNWRAP";
const HCAPI_PUBSUB_UNWRAP = "HCAPI_PUBSUB_UNWRAP";
const CONFIG_SCHEMA = "CONFIG_SCHEMA";
const EVENT_HANDLER_NAMES = [GCS_PUBSUB_UNWRAP, HCAPI_PUBSUB_UNWRAP];

const STORAGE_TYPE_GCS = "GCS";
const STORAGE_TYPE_DICOMWEB = "HCAPI_DICOM";

module.exports = {
  GCS_OBJ_ARCHIVE,
  GCS_OBJ_DELETE,
  GCS_OBJ_FINALIZE,
  GCS_OBJ_METADATA_UPDATE,
  GCS_EVENT_TYPES,
  GCS_PUBSUB_UNWRAP,
  HCAPI_FINALIZE,
  HCAPI_EVENT_TYPES,
  HCAPI_PUBSUB_UNWRAP,
  EVENT_HANDLER_NAMES,
  STORAGE_TYPE_GCS,
  STORAGE_TYPE_DICOMWEB,
  GCS_PUBSUB_MSG_V1,
  CONFIG_SCHEMA,
};
