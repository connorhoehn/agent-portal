// Barrel for the canary flow components. React Flow warns and remounts when
// nodeTypes/edgeTypes are defined inside a render — keep these module-scoped
// and import them as a stable reference.

import { InputNode } from './nodes/InputNode.js';
import { RouterNode } from './nodes/RouterNode.js';
import { PromptVersionNode } from './nodes/PromptVersionNode.js';
import { ModelNode } from './nodes/ModelNode.js';
import { JudgeNode } from './nodes/JudgeNode.js';
import { ScorePanelNode } from './nodes/ScorePanelNode.js';
import { ControllerNode } from './nodes/ControllerNode.js';
import { WeightedEdge } from './edges/WeightedEdge.js';

export { InputNode } from './nodes/InputNode.js';
export { RouterNode } from './nodes/RouterNode.js';
export { PromptVersionNode } from './nodes/PromptVersionNode.js';
export { ModelNode } from './nodes/ModelNode.js';
export { JudgeNode } from './nodes/JudgeNode.js';
export { ScorePanelNode } from './nodes/ScorePanelNode.js';
export { ControllerNode } from './nodes/ControllerNode.js';
export { WeightedEdge } from './edges/WeightedEdge.js';

export type { InputNodeType } from './nodes/InputNode.js';
export type { RouterNodeType } from './nodes/RouterNode.js';
export type { PromptVersionNodeType } from './nodes/PromptVersionNode.js';
export type { ModelNodeType } from './nodes/ModelNode.js';
export type { JudgeNodeType } from './nodes/JudgeNode.js';
export type { ScorePanelNodeType } from './nodes/ScorePanelNode.js';
export type { ControllerNodeType } from './nodes/ControllerNode.js';
export type { WeightedEdgeType } from './edges/WeightedEdge.js';

export const nodeTypes = {
  inputNode: InputNode,
  routerNode: RouterNode,
  promptVersion: PromptVersionNode,
  modelNode: ModelNode,
  judgeNode: JudgeNode,
  scorePanel: ScorePanelNode,
  controllerNode: ControllerNode,
} as const;

export const edgeTypes = {
  weighted: WeightedEdge,
} as const;
