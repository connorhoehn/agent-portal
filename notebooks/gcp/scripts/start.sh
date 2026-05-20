#!/bin/bash
cd "$(dirname "$0")/../../.." && docker compose up jupyter-gcp -d
echo "Jupyter (GCP) running at http://localhost:${JUPYTER_GCP_PORT:-8889}"
