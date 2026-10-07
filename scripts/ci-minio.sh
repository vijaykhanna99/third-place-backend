#!/usr/bin/env bash
# Starts an S3-compatible store for CI on :9000 and creates the media bucket.
# MinIO publishes its image on quay.io (Docker Hub pulls are refused); when the
# image cannot be pulled at all, falls back to the moto S3 server from PyPI,
# which the integration suite is also verified against.
set -euo pipefail
if docker run -d --name minio -p 9000:9000 \
     -e MINIO_ROOT_USER=tplace -e MINIO_ROOT_PASSWORD=tplace-secret \
     quay.io/minio/minio:latest server /data; then
  echo "minio started from quay.io/minio/minio"
  for i in $(seq 1 60); do
    if curl -sf http://127.0.0.1:9000/minio/health/live >/dev/null; then break; fi
    if [ "$i" -eq 60 ]; then echo "minio did not become healthy"; docker logs minio; exit 1; fi
    sleep 1
  done
else
  echo "minio image unavailable; starting moto S3 server instead"
  python3 -m pip install --quiet "moto[server]"
  # The moto server must accept the same static credentials as MinIO does.
  nohup python3 -m moto.server -H 127.0.0.1 -p 9000 > /tmp/moto.log 2>&1 &
  for i in $(seq 1 60); do
    if curl -s -o /dev/null http://127.0.0.1:9000/; then break; fi
    if [ "$i" -eq 60 ]; then echo "moto did not start"; cat /tmp/moto.log; exit 1; fi
    sleep 1
  done
fi
# Create the bucket with the AWS SDK already in node_modules (no mc image needed).
node --input-type=module -e '
import { S3Client, CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
const c = new S3Client({ endpoint: "http://127.0.0.1:9000", region: "auto", forcePathStyle: true,
  credentials: { accessKeyId: "tplace", secretAccessKey: "tplace-secret" } });
try { await c.send(new CreateBucketCommand({ Bucket: "tplace-media-dev" })); } catch (e) { if (e.name !== "BucketAlreadyOwnedByYou") throw e; }
await c.send(new HeadBucketCommand({ Bucket: "tplace-media-dev" }));
console.log("bucket ready");
'
