// The SQL ledger writers (bot_run, agent_project_run) emit the spend-rate metric too.

jest.mock('../aurora.js', () => ({ exec: jest.fn(), withTransaction: jest.fn() }));
const cfg = { region: 'us-east-1', mock: { aurora: false } };
jest.mock('../../config.js', () => ({ get config() { return cfg; } }));

import { recordBotRunSpend, recordAgentProjectRunSpend } from '../spend-ledger.js';
import { exec } from '../aurora.js';
import { fleetAlerts } from '../../lib/fleet-metrics.js';

const seen: Array<Record<string, unknown>> = [];
const on = (a: Record<string, unknown>) => seen.push(a);

function answer(insertRows: Array<Record<string, unknown>>) {
  (exec as jest.Mock).mockImplementation(async (sql: string) =>
    /information_schema/.test(sql) ? [{ n: 0 }] : /INSERT INTO spend_entries/.test(sql) ? insertRows : []);
}

beforeEach(() => { seen.length = 0; (exec as jest.Mock).mockReset(); fleetAlerts.on('alert', on); jest.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { fleetAlerts.off('alert', on); jest.restoreAllMocks(); });

it('emits devbox-spend with the same dimensions after a bot-run write', async () => {
  answer([{ cost_usd: 0.4321987, initiative_id: 'p-auth', actor_id: 'u-nora' }]);
  await recordBotRunSpend('run-1');
  expect(seen).toEqual([expect.objectContaining({ type: 'devbox-spend', usd: 0.4322, InitiativeId: 'p-auth', ActorId: 'u-nora', source: 'bot_run' })]);
});

it('emits for a governed agent-project run', async () => {
  answer([{ cost_usd: 1, initiative_id: null, actor_id: null }]);
  await recordAgentProjectRunSpend('run-2');
  expect(seen).toEqual([expect.objectContaining({ InitiativeId: 'unattributed', ActorId: 'none', source: 'agent_project_run' })]);
});

it('emits nothing when the write changed nothing (retry) or the cost is unknown', async () => {
  answer([]);
  await recordBotRunSpend('run-3');
  answer([{ cost_usd: null, initiative_id: 'p', actor_id: null }]);
  await recordBotRunSpend('run-4');
  expect(seen).toEqual([]);
});
