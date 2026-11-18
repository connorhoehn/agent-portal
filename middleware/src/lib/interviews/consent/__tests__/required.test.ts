// Which consents the deployment requires (row I6.4; contract F3): the setting's parse, the pure check, the knock's
// precondition over the stored answers, and the default deployment unchanged.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import { declinedRequired, REQUIRED_CONSENTS_SETTING, requiredConsents, resetRequiredWarnings } from '../required.js';
import { consentsAnswered, consentsFor, knockCheck } from '../index.js';
import { knockPrecondition } from '../../invite/admission.js';
import { fixtureRegistry } from '../../../../mock/core/index.js';
import { interviewConsentsFixture } from '../../../../mock/interviews-consents.js';

const read = (value: string | undefined) => {
  const lines: string[] = [];
  const parts = requiredConsents(value === undefined ? {} : { [REQUIRED_CONSENTS_SETTING]: value }, (l) => lines.push(l));
  return { parts, lines };
};

describe('INTERVIEWS_REQUIRED_CONSENTS', () => {
  beforeEach(() => resetRequiredWarnings());

  it('is empty by default (decision 5 as written), without a warning', () => {
    expect(read(undefined)).toEqual({ parts: [], lines: [] });
    expect(read('')).toEqual({ parts: [], lines: [] });
    expect(read(' , ')).toEqual({ parts: [], lines: [] });
  });
  it('reads a comma list, in the notice\'s order, whatever the case and spacing, without repeats', () => {
    expect(read('recording').parts).toEqual(['recording']);
    expect(read(' Transcription , recording,recording ').parts).toEqual(['recording', 'transcription']);
  });
  it('milo implies transcription', () => {
    expect(read('milo').parts).toEqual(['transcription', 'milo']);
    expect(read('milo,recording').parts).toEqual(['recording', 'transcription', 'milo']);
  });
  it('ignores unknown words with one warning per value, never throwing', () => {
    const r = read('recording, video, consent');
    expect(r.parts).toEqual(['recording']);
    expect(r.lines).toEqual([`[interviews] ${REQUIRED_CONSENTS_SETTING} may name only recording, transcription and milo; ignoring "video", "consent".`]);
    expect(read('recording, video, consent').lines).toEqual([]);
    expect(read('everything').parts).toEqual([]);
  });
});

describe('declinedRequired', () => {
  const yes = { recording: true, transcription: true, milo: true };
  it('names the required parts the answers leave off', () => {
    expect(declinedRequired({ ...yes, recording: false }, ['recording'])).toEqual(['recording']);
    expect(declinedRequired({ ...yes, recording: false }, ['transcription'])).toEqual([]);
    // Milo needs the transcript: declining the transcript declines a required Milo too.
    expect(declinedRequired({ ...yes, transcription: false, milo: true }, ['transcription', 'milo'])).toEqual(['transcription', 'milo']);
    expect(declinedRequired({ ...yes, milo: false }, ['transcription', 'milo'])).toEqual(['milo']);
  });
  it('nothing when nothing is required or nothing is answered yet', () => {
    expect(declinedRequired({ recording: false, transcription: false, milo: false }, [])).toEqual([]);
    expect(declinedRequired(null, ['recording'])).toEqual([]);
  });
});

describe('the knock\'s precondition over the stored answers', () => {
  const before = process.env[REQUIRED_CONSENTS_SETTING];
  const row = () => interviewConsentsFixture.rows().find((r) => r.interviewId === 'iv-s4e8u2zk')!;
  beforeEach(() => fixtureRegistry.resetAll('default'));
  afterEach(() => {
    if (before === undefined) delete process.env[REQUIRED_CONSENTS_SETTING]; else process.env[REQUIRED_CONSENTS_SETTING] = before;
    fixtureRegistry.resetAll('default');
  });

  it('the default deployment is unchanged: a declined part still knocks, consentsAnswered and consentsFor read as before', async () => {
    delete process.env[REQUIRED_CONSENTS_SETTING];
    Object.assign(row(), { recording: false });
    expect(await knockCheck('iv-s4e8u2zk')).toBe(true);
    expect(await knockPrecondition('iv-s4e8u2zk')).toBe(true);
    expect(await consentsAnswered('iv-s4e8u2zk')).toBe(true);
    expect(await consentsFor('iv-s4e8u2zk')).toEqual({ recording: false, transcription: true, milo: true });
    expect(await knockCheck('iv-k1p5w8ra')).toBe('unanswered');
  });

  it('a declined required part refuses the knock with its own reason; changing the answer lets it through', async () => {
    process.env[REQUIRED_CONSENTS_SETTING] = 'recording';
    Object.assign(row(), { recording: false });
    expect(await knockPrecondition('iv-s4e8u2zk')).toBe('declined-required');
    // Milo's policy and the answered check keep their meaning: the answers are complete and stand as given.
    expect(await consentsAnswered('iv-s4e8u2zk')).toBe(true);
    expect(await consentsFor('iv-s4e8u2zk')).toEqual({ recording: false, transcription: true, milo: true });
    Object.assign(row(), { recording: true });
    expect(await knockPrecondition('iv-s4e8u2zk')).toBe(true);
  });

  it('unanswered comes first: a set under an older notice is unanswered, whatever is required', async () => {
    process.env[REQUIRED_CONSENTS_SETTING] = 'recording';
    Object.assign(row(), { recording: false, noticeVersion: 'older' });
    expect(await knockPrecondition('iv-s4e8u2zk')).toBe('unanswered');
  });

  it('milo required: a declined transcript refuses the knock', async () => {
    process.env[REQUIRED_CONSENTS_SETTING] = 'milo';
    Object.assign(row(), { transcription: false, milo: false });
    expect(await knockPrecondition('iv-s4e8u2zk')).toBe('declined-required');
  });
});
