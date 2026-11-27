// GET /api/interviews/settings (gap audit 2026-11-20, minor: "Settings are invisible"): the settings this deployment runs
// the tenant with, read-only, for the people who run the hiring (ManageCandidates: the recruiter and the admin). Every
// value is lib/interviews/settings.ts interviewsSettings(), which calls the readers the code itself uses, so the page
// shows exactly what is in force. Nothing here writes: a setting changes in the deployment's environment.
//
// Each entry carries a group for the page (retention, consent, runner, other). The Code Interpreter's identifier is not
// sent, only whether one is set: it names cloud infrastructure, which a recruiter has no use for. Anyone without
// ManageCandidates reads the tenant's not-found (lib/interviews/gate.ts), as for a row outside their scope.

import { Router } from 'express';
import { asyncHandler } from '../../lib/async-handler.js';
import { interviewsAction } from '../../lib/interviews/gate.js';
import { interviewsSettings, settingGroupOf, type SettingValue } from '../../lib/interviews/settings.js';
import { CODE_INTERPRETER_SETTING } from '../../lib/interviews/runs/select.js';

export const settingsRouter = Router();

const NO_SETTINGS = 'There is nothing here that you can open.';

export interface SettingRow {
  name: string;
  group: ReturnType<typeof settingGroupOf>;
  about: string;
  value: SettingValue;
  default: SettingValue;
}

/** The settings as the page reads them: grouped, in interviewsSettings' order, the interpreter's identifier reduced to set or not. */
export function settingRows(env: NodeJS.ProcessEnv = process.env): SettingRow[] {
  return interviewsSettings(env).map((s) => ({
    name: s.name, group: settingGroupOf(s.name), about: s.about,
    value: s.name === CODE_INTERPRETER_SETTING ? (String(s.value).trim() ? 'set' : '') : s.value,
    default: s.default,
  }));
}

settingsRouter.get('/settings', interviewsAction('ManageCandidates', NO_SETTINGS), asyncHandler(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items: settingRows() });
}));
