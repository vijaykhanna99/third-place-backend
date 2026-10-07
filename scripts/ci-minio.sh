#!/usr/bin/env bash
# Starts MinIO (R2 stand-in) for CI and creates the media bucket.
set -euo pipefail
docker run -d --name minio -p 9000:9000 \
  -e MINIO_ROOT_USER=tplace -e MINIO_ROOT_PASSWORD=tplace-secret \
  minio/minio server /data
for i in $(seq 1 60); do
  if curl -sf http://127.0.0.1:9000/minio/health/live >/dev/null; then break; fi
  if [ "$i" -eq 60 ]; then echo "minio did not become healthy"; docker logs minio; exit 1; fi
  sleep 1
done
# Create the bucket with the AWS SDK already in node_modules (no mc image needed).
node --input-type=module -e '
import { S3Client, CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
const c = new S3Client({ endpoint: "http://127.0.0.1:9000", region: "auto", forcePathStyle: true,
  credentials: { accessKeyId: "tplace", secretAccessKey: "tplace-secret" } });
try { await c.send(new CreateBucketCommand({ Bucket: "tplace-media-dev" })); } catch (e) { if (e.name !== "BucketAlreadyOwnedByYou") throw e; }
await c.send(new HeadBucketCommand({ Bucket: "tplace-media-dev" }));
console.log("bucket ready");
'
