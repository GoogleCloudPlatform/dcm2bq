#!/usr/bin/env bash

set -e #-x 

NAME=$(jq -r '.name' ./package.json)
LATEST=$(jq -r '.version' ./package.json)
TMPFILE=$(mktemp /tmp/service-${NAME}.XXX.yaml)

cat <<EOF > ${TMPFILE}
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  annotations:
    run.googleapis.com/ingress: all
    run.googleapis.com/ingress-status: all
    run.googleapis.com/minScale: '0'
  labels:
    cloud.googleapis.com/location: us-central1
  name: dcm2bq
  namespace: '74764074417'
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/maxScale: '100'
        run.googleapis.com/execution-environment: gen2
        run.googleapis.com/startup-cpu-boost: 'true'
      labels:
        client.knative.dev/nonce: qxeguhucdl
        run.googleapis.com/startupProbeType: Default
    spec:
      containerConcurrency: 50
      containers:
      - env:
        - name: DEBUG
          value: 'false'
        - name: NODE_ENV
          value: 'production'
        - name: DCM2BQ_CONFIG
          value: '{"bigQuery":{"datasetId": "dicom", "tableId": "metadata"}}'
        image: jasonklotzer/dcm2bq:${LATEST}
        name: dcm2bq-1
        ports:
        - containerPort: 8080
          name: http1
        resources:
          limits:
            cpu: 2000m
            memory: 8Gi
        startupProbe:
          failureThreshold: 1
          periodSeconds: 240
          tcpSocket:
            port: 8080
          timeoutSeconds: 240
      serviceAccountName: 74764074417-compute@developer.gserviceaccount.com
      timeoutSeconds: 3600
  traffic:
  - latestRevision: true
    percent: 100
EOF
gcloud run services replace ${TMPFILE}
