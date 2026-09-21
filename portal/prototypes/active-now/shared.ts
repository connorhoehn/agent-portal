// The library, imported the way the portal imports it: from the installed
// package's dist, by subpath. The Codex preview reached into a sibling
// checkout's `src/` by absolute path — which paints whatever that working tree
// happens to contain, and CLAUDE.md's rule for a reason: verify against dist,
// never against a library's source.
export {
  Button, IconButton, Select, Tabs, ChannelHeader, Avatar, PresenceDot, SearchInput, TitledFrame, Chip,
  ChevronIcon, CloseIcon, DocumentIcon, ChatIcon, SearchIcon, PlusIcon, ActivityIcon, AtIcon,
  PhoneIcon, VideoCallIcon, MenuIcon, BranchIcon,
} from '@connorhoehnslalom/ui-components/shared';
export {
  DocumentActivityCard, AgentRunCard, ChatSidePanelFrame, ConversationRail, ActivePeopleGrid,
  RailSectionHeader, MessageBody,
} from '@connorhoehnslalom/ui-components/social';
export { RichChatComposer } from '@connorhoehnslalom/ui-components/social/rich-composer';
export type { ComposerCommand, ComposedMessage } from '@connorhoehnslalom/ui-components/social/rich-composer';
export {
  BaseNode, AgentNode, ServerStepNode, AnimatedEdge, PipelineNodeRuntimeProvider, portCls,
} from '@connorhoehnslalom/ui-components/pipelines';
export {
  ComputeProvider, ComputerLab, ShellTerminal, fixtureComputers, fixtureModels, fixtureRuntimeStatus,
  installMockShellSocket, installMockTailSource, mockShellUrl, mockTailUrl,
} from '@connorhoehnslalom/ui-components/compute';
export type { ComputeClient } from '@connorhoehnslalom/ui-components/compute';
