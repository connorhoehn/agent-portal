// PR-watch dispatch takes a run-limit slot: the same reserveSpend path fireBot uses.
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: false } } }));
jest.mock('../../providers/connected-sources.js', () => ({ borrowApiKey: jest.fn() }));
jest.mock('../../providers/bots.js', () => ({ createBotRun: jest.fn(), getBot: jest.fn() }));
jest.mock('../../providers/spend-holds.js', () => ({ bindHoldSource: jest.fn(), releaseHold: jest.fn() }));
jest.mock('../bot-runner.js', () => ({
  checkConcurrency: jest.fn(), botMaxConcurrent: () => 5,
  reserveBotFiring: jest.fn(),
  refusalGate: (h: { kind: string }) => (h.kind === 'limited' ? { gate: 'run-limit' } : {}),
}));

import { exec } from '../../providers/aurora.js';
import { createBotRun, getBot } from '../../providers/bots.js';
import { bindHoldSource, releaseHold } from '../../providers/spend-holds.js';
import { reserveBotFiring } from '../bot-runner.js';
import { dispatchPrRun, type WatchedBot } from '../pr-watch-poller.js';

const bot = {
  id: 'b1', name: 'reviewer', promptTemplate: 'review', requiresReview: true, prWatermark: '1',
  maxRunsPerDay: 5, budgetPerDayUsd: null, model: 'm', repoFullName: 'a/b', connectionName: 'c',
} as WatchedBot;
const pr = { number: 2, title: 't', url: 'u', headRef: 'h', baseRef: 'b' } as never;

beforeEach(() => {
  jest.resetAllMocks();
  (getBot as jest.Mock).mockResolvedValue({ id: 'b1' });
});

it('refused hold enqueues nothing and reports the gate', async () => {
  (reserveBotFiring as jest.Mock).mockResolvedValue({ kind: 'limited', reason: 'too many runs' });
  const r = await dispatchPrRun(bot, pr);
  expect(r).toEqual({ kind: 'refused', reason: 'pr_watch firing skipped: too many runs', gate: 'run-limit' });
  expect(exec).not.toHaveBeenCalled();
  expect(reserveBotFiring).toHaveBeenCalledWith({ id: 'b1' }, 'pr_watch', null);
});

it('held dispatch binds the hold to the bot run', async () => {
  (reserveBotFiring as jest.Mock).mockResolvedValue({ kind: 'held', holdId: 'h1' });
  (exec as jest.Mock).mockResolvedValue([{ id: 'j1' }]);
  (createBotRun as jest.Mock).mockResolvedValue({ id: 'r1' });
  expect(await dispatchPrRun(bot, pr)).toEqual({ kind: 'dispatched' });
  expect(bindHoldSource).toHaveBeenCalledWith('h1', 'bot_run', 'r1');
  expect(releaseHold).not.toHaveBeenCalled();
});

it('releases the hold when the ceiling refuses the run row', async () => {
  (reserveBotFiring as jest.Mock).mockResolvedValue({ kind: 'held', holdId: 'h1' });
  (exec as jest.Mock).mockResolvedValue([{ id: 'j1' }]);
  (createBotRun as jest.Mock).mockResolvedValue(null);
  await expect(dispatchPrRun(bot, pr)).rejects.toThrow('concurrency ceiling reached');
  expect(releaseHold).toHaveBeenCalledWith('h1');
});
