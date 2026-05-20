# OrgIQ — GCP Notebooks

Mirror of `notebooks/aws/` using GCP services instead of AWS. The notebooks
share the same seed data (`data/org/*.json`) and the same `config.json`
state-passing convention, but every cell that calls an SDK targets a GCP
service.

## AWS → GCP service mapping

| # | Notebook | AWS service | GCP equivalent |
|---|---|---|---|
| 00 | `00-index` | — | — |
| 01 | `01-setup-credentials` | AWS SSO + boto3 | `gcloud auth application-default login` + google-cloud SDK |
| 02 | `02-alloydb-graph` | Aurora Serverless v2 + pgvector | AlloyDB for PostgreSQL + pgvector (or Cloud SQL PG 16) |
| 03 | `03-embeddings` | Titan Embeddings V2 (1024d) | Vertex AI `text-embedding-005` / `gemini-embedding-001` |
| 04 | `04-vertex-search` | Bedrock Knowledge Base (OpenSearch backing) | Vertex AI Search (Discovery Engine) |
| 05 | `05-model-armor` | Bedrock Guardrails | Model Armor / Vertex AI Safety Settings |
| 06 | `06-adk-agent` | Strands Agents | Google Agent Development Kit (ADK) |
| 07 | `07-agent-engine-memory` | AgentCore Memory | Vertex AI Agent Engine Sessions + Memory Bank |
| 08 | `08-agent-engine-tools` | AgentCore Gateway (MCP) | Vertex AI Agent Engine + ADK tools / MCP server |
| 09 | `09-iam-policy` | AgentCore Policy + Cedar | IAM Conditions (CEL) + optional OPA sidecar |
| 10 | `10-identity-platform` | Cognito + AVP | Identity Platform / Firebase Auth + IAM |
| 11 | `11-code-execution` | AgentCore CodeInterpreter | Vertex AI Code Execution tool (Gemini) |
| 12 | `12-ag-ui-streaming` | AG-UI protocol via AgentCore Runtime SSE | Same AG-UI protocol on Agent Engine / Cloud Run |
| 13 | `13-a2a-protocol` | A2A on AgentCore | A2A on Agent Engine |
| 14 | `14-scoring` | Aurora SQL PageRank | AlloyDB SQL PageRank (or BigQuery) |
| 15 | `15-deploy-agent-engine` | AgentCore Runtime (CfnRuntime) | Vertex AI Agent Engine (Reasoning Engine) or Cloud Run |
| 16 | `16-vertex-eval` | Bedrock Online Evaluation + custom evaluators | Vertex AI Gen AI Evaluation Service |
| 17 | `17-cloud-trace` | CloudWatch + OpenInference | Cloud Trace + OpenTelemetry + OpenInference |
| 18 | `18-fairness` | Custom evaluators on Bedrock | Vertex AI Model Monitor + Responsible AI Toolkit |
| 18b | `18b-text-to-sql` | Bedrock + Aurora text-to-SQL | Gemini + AlloyDB text-to-SQL |
| 19 | `19-cleanup` | Resource tracker teardown | Same pattern, GCP resource APIs |

## Project + region

Set these in your shell or via `01-setup-credentials.ipynb`:

```
GCP_PROJECT_ID=orgiq-demo
GCP_REGION=us-central1                 # Vertex AI default region
GCP_ZONE=us-central1-a
```

## Auth

```bash
gcloud auth login                       # interactive web login
gcloud auth application-default login   # ADC for SDKs
gcloud config set project $GCP_PROJECT_ID
gcloud services enable \
  aiplatform.googleapis.com \
  discoveryengine.googleapis.com \
  alloydb.googleapis.com \
  cloudtrace.googleapis.com \
  modelarmor.googleapis.com
```

## Resource naming

Same prefix convention as AWS: `orgiq-*` (e.g. `orgiq-alloydb-cluster`,
`orgiq-vertex-search-app`, `orgiq-agent-engine`).

## State

Every notebook reads + writes `config.json` (same convention as `notebooks/aws/`).
Keys are namespaced under `gcp.*` so a future hybrid notebook can read both
clouds' state from one file.
