// recordBffCall: the BFF's own Bedrock calls land in the ledger as 'bff_call'.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
const cfg = { region: 'us-east-1', mock: { aurora: true } };
jest.mock('../../config.js', () => ({ get config() { return cfg; } }));

import { recordBffCall, mockStoredEntries } from '../spend-ledger.js';
import { exec } from '../aurora.js';
import { spendEntries } from '../../mock/spend-ledger.js';

beforeEach(() => {
  cfg.mock.aurora = true;
  spendEntries.reset();
  spendEntries.rows().length = 0;
  (exec as jest.Mock).mockReset();
});

describe('recordBffCall', () => {
  it('writes a priced call as an estimated bff_call with its token counts', async () => {
    await recordBffCall({ feature: 'judge', model: 'amazon.nova-pro-v1:0', usage: { inputTokens: 1000, outputTokens: 200 }, actorId: 'u-nora' });
    const rows = mockStoredEntries().filter((r) => r.source === 'bff_call');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      trigger: 'judge', model: 'amazon.nova-pro-v1:0', costBasis: 'estimated',
      inputTokens: 1000, outputTokens: 200, actorId: 'u-nora', initiativeId: null,
    });
    expect(rows[0]!.costUsd).toBeGreaterThan(0);
    expect(rows[0]!.sourceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps tokens and a null cost for an unpriced model', async () => {
    await recordBffCall({ feature: 'x', model: 'vendor.never-priced-v9', usage: { inputTokens: 5, outputTokens: 7 } });
    expect(mockStoredEntries().find((r) => r.source === 'bff_call')).toMatchObject({
      costUsd: null, costBasis: 'unknown', inputTokens: 5, outputTokens: 7,
    });
  });

  it('records nothing when the response carried no usage', async () => {
    await recordBffCall({ feature: 'x', model: 'amazon.nova-pro-v1:0', usage: undefined });
    expect(mockStoredEntries().filter((r) => r.source === 'bff_call')).toHaveLength(0);
  });

  it('swallows a write failure', async () => {
    cfg.mock.aurora = false;
    (exec as jest.Mock).mockRejectedValue(new Error('data api down'));
    await expect(recordBffCall({ feature: 'x', model: 'amazon.nova-pro-v1:0', usage: { inputTokens: 1, outputTokens: 1 } })).resolves.toBeUndefined();
  });
});
