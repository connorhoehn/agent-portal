#!/bin/bash
cd "$(dirname "$0")/../.." && docker compose up jupyter -d
echo "Jupyter running at http://localhost:8888"
