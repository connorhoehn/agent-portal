jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
const mockPublish = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock('../../gateway-run-feed.js', () => ({ publishChannelActivity: (...args: unknown[]) => mockPublish(...args) }));
import { INTERVIEW_HINT_ENDED, INTERVIEW_HINT_KNOCK, publishInterviewHint } from '../live-hint.js';

describe('the room\'s live hints', () => {
  beforeEach(() => mockPublish.mockClear());

  it('a knock goes out on the interview\'s lobby name, carrying only the interview id', async () => {
    await publishInterviewHint('iv-1', 'knock');
    expect(mockPublish).toHaveBeenCalledWith('interviews:interview:iv-1', INTERVIEW_HINT_KNOCK, { interviewId: 'iv-1' });
  });

  it('the end goes out the same way under its own event name', async () => {
    await publishInterviewHint('iv-1', 'ended');
    expect(mockPublish).toHaveBeenCalledWith('interviews:interview:iv-1', INTERVIEW_HINT_ENDED, { interviewId: 'iv-1' });
  });

  it('an id that cannot name a lobby publishes nothing, and a failing publish never throws', async () => {
    await publishInterviewHint('a:b', 'knock');
    expect(mockPublish).not.toHaveBeenCalled();
    mockPublish.mockRejectedValueOnce(new Error('down'));
    await expect(publishInterviewHint('iv-1', 'knock')).resolves.toBeUndefined();
  });
});
