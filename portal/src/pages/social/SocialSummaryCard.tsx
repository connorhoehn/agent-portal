// The private card a Social `/summarize` leaves in the requester's own
// conversation — the shared ConversationSummaryCard on the Social mount, with
// the Social test ids. Nothing is sent until "Post to conversation".

import ConversationSummaryCard from '../../components/chat/ConversationSummaryCard';
import { socialSummarizeApi, type PostedSummary } from './socialSummarize';

export interface SocialSummaryCardProps {
  runId: string;
  instruction: string;
  requestedBy: string;
  /** Sends the server-built message into the conversation. Rejects when delivery fails. */
  onPost: (message: PostedSummary) => Promise<void>;
  onDismiss: () => void;
}

export default function SocialSummaryCard(props: SocialSummaryCardProps) {
  return <ConversationSummaryCard {...props} api={socialSummarizeApi} testIdPrefix="social-summary" />;
}
