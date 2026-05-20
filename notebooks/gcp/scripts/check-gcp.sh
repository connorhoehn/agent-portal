#!/bin/bash
set -e

echo "Checking gcloud auth..."
gcloud auth list --format="table(account,status)"

echo ""
echo "Active project + region:"
gcloud config get-value project
gcloud config get-value compute/region 2>/dev/null || echo "(no default region set — use gcloud config set compute/region us-central1)"

echo ""
echo "Checking required APIs are enabled:"
for svc in aiplatform.googleapis.com discoveryengine.googleapis.com bigquery.googleapis.com bigquerystorage.googleapis.com cloudtrace.googleapis.com modelarmor.googleapis.com; do
  enabled=$(gcloud services list --enabled --filter="name:${svc}" --format="value(name)" 2>/dev/null)
  if [ -n "$enabled" ]; then
    echo "  ✓ ${svc}"
  else
    echo "  ✗ ${svc} — run: gcloud services enable ${svc}"
  fi
done

echo ""
echo "Checking Vertex AI text-embedding-005 access..."
gcloud ai models list --region=us-central1 --filter="displayName:text-embedding-005" --format="value(name)" 2>/dev/null | head -3 || echo "(skipped — model list may need elevated perms)"

echo ""
echo "All checks done."
