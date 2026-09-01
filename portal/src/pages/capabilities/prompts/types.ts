// Shapes local to Prompt Studio. The wire types for the Bedrock Prompt Library
// itself live in components/canary/types.ts.

/** Which prompt + which version the workspace is showing. */
export interface Selection {
  promptId: string;
  promptName: string;
  promptArn: string;
  version: string;
}

/** Which panel is mounted in the workspace column. */
export type PanelMode = 'view' | 'edit' | 'test' | 'create';

/** Bedrock inference settings a variant can carry. */
export interface InferenceConfig {
  temperature?: number;
  maxTokens?: number;
}

/** One guardrail assessment item from an invoke trace. */
export interface GuardrailIntervention {
  action?: string;
  type?: string;
  text?: string;
}

/** GET /api/capabilities/guardrail — the tenant's single configured guardrail. */
export interface GuardrailSnapshot {
  id: string;
  name: string;
  version: string;
}

/** How a `{{variable}}` should be collected in the test harness. */
export type VarType = 'person' | 'skill' | 'textarea' | 'text';
