import { Router } from 'express';
import { asyncHandler, ValidationError, AppError } from '../lib/async-handler.js';
import { requireAction, requireTenant, resolveSession } from '../lib/authz.js';
import { listRecordingSearchRecords, resolveRecordingSearchRecord, RECORDING_READ_BUDGET_MS } from '../providers/recording-search.js';
import { recordingSearchResponse, SEARCH_SORTS, type SearchSort } from '../providers/search.js';
import { isDocumentSourceId } from '../lib/assessment-document-context.js';

export const assessmentRecordingSearchRouter = Router();
// Same authority as team Documents; no Work Search or Social grant is added.
assessmentRecordingSearchRouter.use(requireTenant('assessment'), requireAction('ViewAssessment'));
assessmentRecordingSearchRouter.use((req, _res, next) => {
  // Administrative policy bypass is not permission to retarget a token minted
  // from the currently active Work tenant to an Assessment artifact source.
  if (resolveSession(req)?.tenant !== 'assessment') { next(new AppError(403, 'An active Assessment session is required')); return; }
  next();
});
assessmentRecordingSearchRouter.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
function team(raw: unknown): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string' || !/^TEAM-[A-Za-z0-9-]{1,120}$/.test(raw)) throw new ValidationError('teamId must be a valid Assessment team');
  return raw;
}
function document(raw: unknown, teamId: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (teamId !== undefined || !isDocumentSourceId(raw)) throw new ValidationError('A valid documentSourceId or teamId is required, not both');
  return raw;
}
assessmentRecordingSearchRouter.get('/search', asyncHandler(async (req, res) => {
  const q = String(req.query['q'] ?? '').trim(), scope = team(req.query['teamId']);
  const documentSourceId = document(req.query['documentSourceId'], scope);
  const type = String(req.query['type'] ?? 'recording'), sort = String(req.query['sort'] ?? 'relevance');
  const limit = Number(req.query['limit'] ?? 50), offset = Number(req.query['offset'] ?? 0);
  if (q.length > 1000) throw new ValidationError('q must be 1000 characters or fewer');
  if (type !== 'recording') throw new ValidationError('Only recording artifacts are supported');
  if (!SEARCH_SORTS.includes(sort as SearchSort)) throw new ValidationError('sort must be relevance or recent');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new ValidationError('Invalid recording pagination');
  try {
    const projection = await listRecordingSearchRecords(resolveSession(req)!, scope, 'assessment', documentSourceId);
    res.json(recordingSearchResponse(projection, { q, scope, limit, offset, sort: sort as SearchSort }));
  } catch (error) {
    // Authentication stays an error. Native transport failures cannot pretend
    // that an authorized user's recording history is empty and complete.
    if ((error as { status?: number }).status === 401 || (error as { status?: number }).status === 403) throw error;
    res.json(recordingSearchResponse({ records: [], partial: ['Recordings unavailable'] }, { q }));
  }
}));
assessmentRecordingSearchRouter.get('/records', asyncHandler(async (req, res) => {
  const scope = team(req.query['teamId']), raw = String(req.query['keys'] ?? '');
  const documentSourceId = document(req.query['documentSourceId'], scope);
  const keys = raw ? raw.split(',') : [];
  if (keys.length > 30) throw new ValidationError('Select at most 30 recordings');
  const ids = [...new Set(keys.map(key => {
    const match = /^recording:([^\s,]{1,200})$/.exec(key);
    if (!match) throw new ValidationError('Invalid recording key');
    return match[1]!;
  }))];
  const records = [];
  const deadline = Date.now() + RECORDING_READ_BUDGET_MS;
  // Bounded sequential hydration avoids launching 30 native read trees at once.
  for (const id of ids) {
    if (Date.now() >= deadline) throw new AppError(504, 'Recording context read window expired');
    const record = await resolveRecordingSearchRecord(resolveSession(req)!, id, scope, 'assessment', deadline, documentSourceId);
    if (record) records.push(record);
  }
  res.json({ records, edges: [] });
}));
