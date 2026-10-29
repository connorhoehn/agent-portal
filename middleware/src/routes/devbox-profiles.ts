// Devbox policy profiles — /api/devbox/profiles (DE-40).
//
//   GET  /api/devbox/profiles          the latest version of every profile
//   GET  /api/devbox/profiles/:id      one profile's latest version + history
//   PUT  /api/devbox/profiles/:id      append a new version (body: the profile,
//                                      `baseVersion`, `reason`)
//
// Mounted in index.ts BEFORE `/api/devbox` so `/profiles/...` is never read
// as a `:sessionId` by the fleet router. Reads carry the same read tier as
// the fleet (an org-leader may see the rules a computer runs under).
//
// WHO MAY EDIT is an open user decision (the spec proposes hr-admin and
// admin). What is built is the conservative default (docs/local-backlog-goal
// "Decisions taken by default"): Cedar `ManageBudgets` — the existing
// program-management action, held by hr-admin, org-leader and program-owner
// — AND an org-wide role (org-leader, hr-admin, admin), so a program-owner
// cannot widen the model allowlist every initiative inherits. No new Cedar
// action, so nothing hides in the portal that was visible before.
//
// Which initiative uses which profile is a different write, on the
// initiative: PATCH /api/graph/projects/:id/devbox-profile (routes/projects.ts).

import { Router } from 'express';
import { asyncHandler, NotFoundError, ValidationError } from '../lib/async-handler.js';
import { requireAction, readForRolesElseAction, resolveSession } from '../lib/authz.js';
import { ORG_WIDE_INITIATIVE_ROLES } from '../lib/initiative-scope.js';
import { parseProfileInput, PROFILE_ID_RE } from '../lib/devbox-profile.js';
import {
  ensureDefaultProfile, latestProfile, listProfiles, listProfileVersions, writeProfileVersion,
} from '../providers/devbox-profiles.js';

export const devboxProfilesRouter: Router = Router();

const readGate = readForRolesElseAction(['org-leader', 'hr-admin', 'program-owner'], 'ManageDevbox');
const editGate = requireAction('ManageBudgets');

function profileId(raw: unknown): string {
  const id = String(raw ?? '').trim();
  if (!PROFILE_ID_RE.test(id)) throw new ValidationError('profile id must be 1-40 chars of [a-z0-9-], starting with a letter');
  return id;
}

devboxProfilesRouter.get('/', readGate, asyncHandler(async (_req, res) => {
  await ensureDefaultProfile();
  res.json({ profiles: await listProfiles() });
}));

devboxProfilesRouter.get('/:id', readGate, asyncHandler(async (req, res) => {
  const id = profileId(req.params['id']);
  if (id === 'default') await ensureDefaultProfile();
  const profile = await latestProfile(id);
  if (!profile) throw new NotFoundError(`no profile "${id}"`);
  res.json({ profile, versions: await listProfileVersions(id) });
}));

devboxProfilesRouter.put('/:id', editGate, asyncHandler(async (req, res) => {
  const id = profileId(req.params['id']);
  const session = resolveSession(req);
  if (!session || !ORG_WIDE_INITIATIVE_ROLES.includes(session.role)) {
    res.status(403).json({
      error: 'only an org-wide role (org-leader, hr-admin, admin) may edit a devbox profile',
      code: 'ORG_WIDE_ROLE_REQUIRED', role: session?.role ?? null,
    });
    return;
  }
  const body = (req.body ?? {}) as { profile?: unknown; baseVersion?: unknown; reason?: unknown };
  const parsed = parseProfileInput(body.profile);
  if (typeof parsed === 'string') throw new ValidationError(parsed);
  const baseVersion = Number(body.baseVersion);
  if (!Number.isInteger(baseVersion) || baseVersion < 0) throw new ValidationError('baseVersion must be the version you edited from (0 for a new profile)');
  const reason = String(body.reason ?? '').trim();
  if (!reason) throw new ValidationError('reason is required — every profile version says why');

  const outcome = await writeProfileVersion({ id, profile: parsed, baseVersion, changedBy: session.sub, reason });
  if (!outcome.ok) {
    res.status(409).json({ error: 'the profile changed since you read it — re-base and retry', code: 'VERSION_CONFLICT', currentVersion: outcome.currentVersion });
    return;
  }
  res.status(201).json({ profile: outcome.profile });
}));
