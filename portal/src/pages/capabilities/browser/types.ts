// Shapes returned by /api/capabilities/browser-sessions and /browser/web-qa.

export interface BrowserSession {
  sessionId: string;
  agentName: string;
  status: 'ACTIVE' | 'IDLE' | 'CLOSED';
  startedAt: string;
  lastActivityAt: string;
  currentUrl: string;
  pageTitle: string;
  requestCount: number;
  profileId: string;
}

export interface JourneyStep {
  index: number;
  startedAt: string;
  url: string;
  pageTitle: string;
  textSnippet: string;
  imageDataUrl?: string;
  question?: string;
  answer?: string;
}

export interface WebQAResult {
  url: string;
  pageTitle: string;
  imageDataUrl: string | null;
  answer: string;
}
