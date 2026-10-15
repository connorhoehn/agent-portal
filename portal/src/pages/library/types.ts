// Wire contracts for /api/library — the one catalog.

export type AssetKind = 'system' | 'prompt' | 'evaluator' | 'skill' | 'insight';
export type AssetTier = 'sandbox' | 'internal' | 'endpoint';
export type VarSource = 'literal' | 'caller' | 'retrieved' | 'untrusted';

export interface ContractVariable {
  name: string;
  type: string;
  required: boolean;
  source: VarSource;
  default?: string;
  description?: string;
  options?: string[];
}

export interface AssetContract {
  kind: AssetKind;
  tier: AssetTier;
  variables: ContractVariable[];
  guardrailId?: string | null;
}

export interface LibraryAsset {
  id: string;
  name: string;
  description: string;
  kind: AssetKind;
  tier: AssetTier;
  roles: string[];
  tags: string[];
  ownerName: string | null;
  version: string;
  lifecycleStatus: string;
  contract: AssetContract;
  evalPassRate: number | null;
  usedBy: string[];
  updatedAt: string;
  template: string;
  signoffs: number;
  designReviewId?: string | null;
}

export interface LibraryResponse {
  assets: LibraryAsset[];
  facets: { kind: Record<string, number>; tier: Record<string, number>; role: Record<string, number> };
  total: number;
}

export interface ReadinessChecks {
  contractComplete: boolean;
  undeclared: string[];
  hasOwner: boolean;
  evaluated: boolean;
  evalPassRate: number | null;
  guardrailBound: boolean;
  signoffs: number;
}

export interface Readiness {
  ok: boolean;
  reason?: string;
  tier: AssetTier;
  checks: ReadinessChecks;
}

export interface AssetDetail {
  asset: LibraryAsset;
  readiness: Readiness;
  related: Array<{ asset: LibraryAsset; score: number; reason: string }>;
}
