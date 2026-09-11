// Prompt Studio's writes offline — create, edit the draft, publish a version.
//
// This router had three `config.mock` branches and all three were on GETs, so
// `/api/observability/canary/library` LOOKED mocked while `POST /library`,
// `PUT /library/:id/draft` and `POST /library/:id/publish` called
// CreatePrompt / UpdatePrompt / CreatePromptVersion against real Bedrock from a
// laptop running `dev:mock`. That is the arrangement docs/mock-floor.md singles
// out as the worst one — a surface that appears to work is a surface nobody
// checks. These writes are invisible to `mock/core/wire/mock-branches.ts`,
// which only reports leaves in `src/providers/**` and `src/lib/**`, so nothing
// mechanical was ever going to find them; that is why they get a test.
//
// The two properties under test are the ones a rubber-stamp mock would fail:
// a write that moved nothing must not answer `ok`, and `optimize` — whose whole
// product is a model rewrite — must REFUSE rather than hand back its input.

import { freezeClock } from '../core/clock.js';
import {
  findMockPrompt,
  mockCreatePrompt,
  mockPublishVersion,
  mockUpdateDraft,
  promptLibrary,
} from '../canary-library.js';
import { offlineInvokePrompt, offlineOptimize, OFFLINE_RENDER_NOTICE } from '../prompt-studio.js';

const AT = '2026-09-06T09:15:00.000Z';

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  promptLibrary.reset();
});

const create = () =>
  mockCreatePrompt({
    name: 'orgiq-triage-system-prompt',
    description: 'Incident triage',
    templateText: 'You triage {{incident}} for {{team}}.',
    modelId: 'amazon.nova-pro-v1:0',
    temperature: 0.4,
    maxTokens: 2048,
  });

describe('creating a prompt offline', () => {
  it('lands in the library the list reads, with a DRAFT and derived variables', () => {
    restore = freezeClock(AT);
    const before = promptLibrary.rows().length;

    const created = create();

    expect(promptLibrary.rows()).toHaveLength(before + 1);
    expect(findMockPrompt(created.id)).toBe(created);
    expect(created.versions).toHaveLength(1);
    expect(created.versions[0]?.version).toBe('DRAFT');
    expect(created.versions[0]?.createdAt).toBe(AT);
    // CreatePrompt derives inputVariables from the template; so does this.
    expect(created.versions[0]?.variant.inputVariables).toEqual(['incident', 'team']);
  });

  it('mints an id that cannot be mistaken for one Bedrock issued', () => {
    const created = create();
    expect(created.id.startsWith('mock-')).toBe(true);
    expect(created.versions[0]?.arn).toContain(':000000000000:');
  });

  it('reset un-creates it', () => {
    const created = create();
    promptLibrary.reset();
    expect(findMockPrompt(created.id)).toBeUndefined();
  });
});

describe('editing the draft offline', () => {
  it('moves the row and re-stamps only the draft', () => {
    restore = freezeClock(AT);
    const created = create();
    restore();
    restore = freezeClock('2026-09-06T12:00:00.000Z');

    const updated = mockUpdateDraft(created.id, {
      name: 'orgiq-triage-system-prompt',
      templateText: 'You triage {{incident}}, name one step, cite the runbook.',
    });

    expect(updated?.versions[0]?.variant.templateText).toContain('cite the runbook');
    expect(updated?.versions[0]?.variant.inputVariables).toEqual(['incident']);
    expect(updated?.versions[0]?.createdAt).toBe(AT);
    expect(updated?.versions[0]?.updatedAt).toBe('2026-09-06T12:00:00.000Z');
  });

  it('returns null for a prompt that does not exist, so the route can 404', () => {
    expect(mockUpdateDraft('no-such-prompt', { name: 'x', templateText: 'y' })).toBeNull();
  });
});

describe('publishing a version offline', () => {
  it('numbers from the versions present, not from a stored counter', () => {
    const created = create();
    expect(mockPublishVersion(created.id)?.version.version).toBe('1');
    expect(mockPublishVersion(created.id)?.version.version).toBe('2');
    // The draft stays first — every reader takes versions[0] as the draft.
    expect(created.versions.map((v) => v.version)).toEqual(['DRAFT', '2', '1']);
  });

  it('freezes a COPY, so editing the draft afterwards cannot rewrite history', () => {
    const created = create();
    const published = mockPublishVersion(created.id)!;
    mockUpdateDraft(created.id, { name: created.name, templateText: 'entirely different text' });
    expect(published.version.variant.templateText).toBe('You triage {{incident}} for {{team}}.');
  });

  it('returns null for a prompt that does not exist', () => {
    expect(mockPublishVersion('no-such-prompt')).toBeNull();
  });
});

describe('the two model calls this router cannot make offline', () => {
  it('invoke renders the prompt and says out loud that no model ran', () => {
    const created = create();
    const out = offlineInvokePrompt(created.id, 'DRAFT', { incident: 'INC-2214', team: 'platform' });
    expect(out).toContain(OFFLINE_RENDER_NOTICE);
    expect(out).toContain('You triage INC-2214 for platform.');
    expect(out).not.toMatch(/nova|anthropic/);
  });

  it('invoke leaves a variable the caller did not supply visibly unfilled', () => {
    const created = create();
    const out = offlineInvokePrompt(created.id, 'DRAFT', { incident: 'INC-2214' });
    // `{{team}}`, not an empty string: an unsupplied variable is a thing the
    // operator needs to see, and blanking it hides it.
    expect(out).toContain('{{team}}');
  });

  it('invoke returns null for a version that is not there, rather than inventing one', () => {
    const created = create();
    expect(offlineInvokePrompt(created.id, '7', {})).toBeNull();
    expect(offlineInvokePrompt('no-such-prompt', 'DRAFT', {})).toBeNull();
  });

  it('optimize refuses instead of returning the input as a rewrite', () => {
    const refusal = offlineOptimize();
    expect(refusal.error).toBe('Bedrock unavailable');
    expect(refusal.detail).toContain('there is no model');
    expect(refusal).not.toHaveProperty('optimizedText');
  });
});
