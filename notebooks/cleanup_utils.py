"""Resource tracking and cleanup utilities for OrgIQ notebooks."""

import json
import time
from pathlib import Path
from typing import Dict, List, Optional

import boto3
from botocore.exceptions import ClientError

RESOURCE_TRACKER_FILE = "resource_tracker.json"
PROJECT_PREFIX = "orgiq"


class ResourceTracker:
    """Track AWS resources created during OrgIQ exploration."""

    def __init__(self):
        self.tracker_file = Path(RESOURCE_TRACKER_FILE)
        self.resources = self._load()

    def _load(self) -> Dict:
        if self.tracker_file.exists():
            with open(self.tracker_file) as f:
                return json.load(f)
        return {
            "project_prefix": PROJECT_PREFIX,
            "region": None,
            "account_id": None,
            "s3_buckets": [],
            "knowledge_bases": [],
            "data_sources": [],
            "opensearch_collections": [],
            "opensearch_policies": [],
            "iam_roles": [],
            "neptune_graphs": [],
            "agentcore_agents": [],
            "agentcore_gateways": [],
            "agentcore_memories": [],
            "guardrails": [],
            "managed_prompts": [],
            "bedrock_flows": [],
            "dynamodb_tables": [],
        }

    def _save(self):
        with open(self.tracker_file, "w") as f:
            json.dump(self.resources, f, indent=2)

    def set_account_info(self, account_id: str, region: str):
        self.resources["account_id"] = account_id
        self.resources["region"] = region
        self._save()

    def add_s3_bucket(self, bucket_name: str):
        if bucket_name not in self.resources["s3_buckets"]:
            self.resources["s3_buckets"].append(bucket_name)
            self._save()

    def add_knowledge_base(self, kb_id: str, kb_name: str):
        entry = {"id": kb_id, "name": kb_name}
        if entry not in self.resources["knowledge_bases"]:
            self.resources["knowledge_bases"].append(entry)
            self._save()

    def add_data_source(self, kb_id: str, ds_id: str):
        entry = {"kb_id": kb_id, "ds_id": ds_id}
        if entry not in self.resources["data_sources"]:
            self.resources["data_sources"].append(entry)
            self._save()

    def add_opensearch_collection(self, collection_arn: str, collection_name: str):
        entry = {"arn": collection_arn, "name": collection_name}
        if entry not in self.resources["opensearch_collections"]:
            self.resources["opensearch_collections"].append(entry)
            self._save()

    def add_opensearch_policy(self, policy_name: str, policy_type: str):
        entry = {"name": policy_name, "type": policy_type}
        if entry not in self.resources["opensearch_policies"]:
            self.resources["opensearch_policies"].append(entry)
            self._save()

    def add_iam_role(self, role_arn: str, role_name: str):
        entry = {"arn": role_arn, "name": role_name}
        if entry not in self.resources["iam_roles"]:
            self.resources["iam_roles"].append(entry)
            self._save()

    def add_neptune_graph(self, graph_id: str, graph_name: str):
        entry = {"id": graph_id, "name": graph_name}
        if entry not in self.resources["neptune_graphs"]:
            self.resources["neptune_graphs"].append(entry)
            self._save()

    def add_agentcore_agent(self, agent_id: str, agent_name: str):
        entry = {"id": agent_id, "name": agent_name}
        if entry not in self.resources["agentcore_agents"]:
            self.resources["agentcore_agents"].append(entry)
            self._save()

    def add_agentcore_gateway(self, gateway_id: str, gateway_name: str):
        entry = {"id": gateway_id, "name": gateway_name}
        if entry not in self.resources["agentcore_gateways"]:
            self.resources["agentcore_gateways"].append(entry)
            self._save()

    def add_agentcore_memory(self, memory_id: str, memory_name: str):
        entry = {"id": memory_id, "name": memory_name}
        if entry not in self.resources["agentcore_memories"]:
            self.resources["agentcore_memories"].append(entry)
            self._save()

    def add_guardrail(self, guardrail_id: str, guardrail_name: str):
        entry = {"id": guardrail_id, "name": guardrail_name}
        if entry not in self.resources["guardrails"]:
            self.resources["guardrails"].append(entry)
            self._save()

    def add_managed_prompt(self, prompt_id: str, prompt_name: str):
        entry = {"id": prompt_id, "name": prompt_name}
        if entry not in self.resources["managed_prompts"]:
            self.resources["managed_prompts"].append(entry)
            self._save()

    def add_bedrock_flow(self, flow_id: str, flow_name: str):
        entry = {"id": flow_id, "name": flow_name}
        if entry not in self.resources["bedrock_flows"]:
            self.resources["bedrock_flows"].append(entry)
            self._save()

    def add_dynamodb_table(self, table_name: str):
        if table_name not in self.resources["dynamodb_tables"]:
            self.resources["dynamodb_tables"].append(table_name)
            self._save()

    def get_all(self) -> Dict:
        return self.resources

    def clear(self):
        self.resources = self._load.__func__(self)  # type: ignore
        self.resources = {
            "project_prefix": PROJECT_PREFIX,
            "region": None,
            "account_id": None,
            "s3_buckets": [],
            "knowledge_bases": [],
            "data_sources": [],
            "opensearch_collections": [],
            "opensearch_policies": [],
            "iam_roles": [],
            "neptune_graphs": [],
            "agentcore_agents": [],
            "agentcore_gateways": [],
            "agentcore_memories": [],
            "guardrails": [],
            "managed_prompts": [],
            "bedrock_flows": [],
            "dynamodb_tables": [],
        }
        self._save()

    def summary(self):
        """Print a summary of tracked resources."""
        total = 0
        for key, value in self.resources.items():
            if isinstance(value, list) and len(value) > 0:
                print(f"  {key}: {len(value)} resources")
                total += len(value)
        if total == 0:
            print("  No resources tracked yet.")
        else:
            print(f"\n  Total: {total} resources tracked")


class ResourceCleanup:
    """Clean up tracked AWS resources in safe dependency order."""

    def __init__(self, tracker: ResourceTracker, region: Optional[str] = None):
        self.tracker = tracker
        self.region = region or tracker.resources.get("region", "us-east-1")

    def cleanup_all(self, dry_run: bool = True):
        """Delete all tracked resources. Set dry_run=False to actually delete."""
        resources = self.tracker.get_all()
        if dry_run:
            print("DRY RUN - would delete the following:")
            self.tracker.summary()
            print("\nRe-run with dry_run=False to delete.")
            return

        print("Cleaning up resources...")
        self._delete_data_sources(resources.get("data_sources", []))
        self._delete_knowledge_bases(resources.get("knowledge_bases", []))
        self._delete_bedrock_flows(resources.get("bedrock_flows", []))
        self._delete_guardrails(resources.get("guardrails", []))
        self._delete_managed_prompts(resources.get("managed_prompts", []))
        self._delete_neptune_graphs(resources.get("neptune_graphs", []))
        self._delete_opensearch_collections(resources.get("opensearch_collections", []))
        self._delete_s3_buckets(resources.get("s3_buckets", []))
        self._delete_dynamodb_tables(resources.get("dynamodb_tables", []))
        self._delete_iam_roles(resources.get("iam_roles", []))
        self._delete_opensearch_policies(resources.get("opensearch_policies", []))
        print("Cleanup complete.")
        self.tracker.clear()

    def _delete_s3_buckets(self, buckets: List):
        s3 = boto3.resource("s3", region_name=self.region)
        for bucket_name in buckets:
            try:
                bucket = s3.Bucket(bucket_name)
                bucket.objects.all().delete()
                bucket.delete()
                print(f"  Deleted S3 bucket: {bucket_name}")
            except ClientError as e:
                print(f"  Failed to delete bucket {bucket_name}: {e}")

    def _delete_knowledge_bases(self, kbs: List):
        client = boto3.client("bedrock-agent", region_name=self.region)
        for kb in kbs:
            try:
                client.delete_knowledge_base(knowledgeBaseId=kb["id"])
                print(f"  Deleted KB: {kb['name']}")
            except ClientError as e:
                print(f"  Failed to delete KB {kb['name']}: {e}")

    def _delete_data_sources(self, data_sources: List):
        client = boto3.client("bedrock-agent", region_name=self.region)
        for ds in data_sources:
            try:
                client.delete_data_source(
                    knowledgeBaseId=ds["kb_id"], dataSourceId=ds["ds_id"]
                )
                print(f"  Deleted data source: {ds['ds_id']}")
            except ClientError as e:
                print(f"  Failed to delete data source {ds['ds_id']}: {e}")

    def _delete_neptune_graphs(self, graphs: List):
        client = boto3.client("neptune-graph", region_name=self.region)
        for graph in graphs:
            try:
                client.delete_graph(graphIdentifier=graph["id"], skipSnapshot=True)
                print(f"  Deleted Neptune graph: {graph['name']}")
            except ClientError as e:
                print(f"  Failed to delete graph {graph['name']}: {e}")

    def _delete_guardrails(self, guardrails: List):
        client = boto3.client("bedrock", region_name=self.region)
        for gr in guardrails:
            try:
                client.delete_guardrail(guardrailIdentifier=gr["id"])
                print(f"  Deleted guardrail: {gr['name']}")
            except ClientError as e:
                print(f"  Failed to delete guardrail {gr['name']}: {e}")

    def _delete_managed_prompts(self, prompts: List):
        client = boto3.client("bedrock-agent", region_name=self.region)
        for prompt in prompts:
            try:
                client.delete_prompt(promptIdentifier=prompt["id"])
                print(f"  Deleted prompt: {prompt['name']}")
            except ClientError as e:
                print(f"  Failed to delete prompt {prompt['name']}: {e}")

    def _delete_bedrock_flows(self, flows: List):
        client = boto3.client("bedrock-agent", region_name=self.region)
        for flow in flows:
            try:
                client.delete_flow(flowIdentifier=flow["id"])
                print(f"  Deleted flow: {flow['name']}")
            except ClientError as e:
                print(f"  Failed to delete flow {flow['name']}: {e}")

    def _delete_opensearch_collections(self, collections: List):
        client = boto3.client("opensearchserverless", region_name=self.region)
        for coll in collections:
            try:
                client.delete_collection(id=coll["arn"].split("/")[-1])
                print(f"  Deleted collection: {coll['name']}")
            except ClientError as e:
                print(f"  Failed to delete collection {coll['name']}: {e}")

    def _delete_dynamodb_tables(self, tables: List):
        client = boto3.client("dynamodb", region_name=self.region)
        for table_name in tables:
            try:
                client.delete_table(TableName=table_name)
                print(f"  Deleted DynamoDB table: {table_name}")
            except ClientError as e:
                print(f"  Failed to delete table {table_name}: {e}")

    def _delete_iam_roles(self, roles: List):
        iam = boto3.client("iam")
        for role in roles:
            try:
                role_name = role["name"]
                policies = iam.list_attached_role_policies(RoleName=role_name)
                for policy in policies.get("AttachedPolicies", []):
                    iam.detach_role_policy(
                        RoleName=role_name, PolicyArn=policy["PolicyArn"]
                    )
                inline = iam.list_role_policies(RoleName=role_name)
                for policy_name in inline.get("PolicyNames", []):
                    iam.delete_role_policy(RoleName=role_name, PolicyName=policy_name)
                iam.delete_role(RoleName=role_name)
                print(f"  Deleted IAM role: {role_name}")
            except ClientError as e:
                print(f"  Failed to delete role {role['name']}: {e}")

    def _delete_opensearch_policies(self, policies: List):
        client = boto3.client("opensearchserverless", region_name=self.region)
        for policy in policies:
            try:
                policy_type_map = {
                    "access": "delete_access_policy",
                    "encryption": "delete_security_policy",
                    "network": "delete_security_policy",
                }
                method_name = policy_type_map.get(policy["type"])
                if method_name:
                    method = getattr(client, method_name)
                    method(name=policy["name"], type=policy["type"])
                print(f"  Deleted policy: {policy['name']}")
            except ClientError as e:
                print(f"  Failed to delete policy {policy['name']}: {e}")
