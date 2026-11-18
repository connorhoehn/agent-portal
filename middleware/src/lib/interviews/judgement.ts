// The judgement detector (docs/interviews-tenant-plan.md decision 6: Milo never rates, ranks, recommends or judges a
// candidate, and never reads a face, a voice or a manner). Pure, deterministic, no model.
//
// Three layers, each erring on refusing:
//   1. normalise   case, curly quotes and dashes, contractions ("shouldn't", "how'd", "she's"), and every way of naming
//                  the candidate ("she", "him", "their", "the applicant", "this person's") folded to one token, CAND or
//                  CAND's, so one rule covers every pronoun. "The other candidate(s)" is kept apart (OTHERCAND).
//   2. the rules   judgement verbs and nouns (hire, pass, reject, advance, rank, rate, score, grade, recommend, fit,
//                  offer), comparative and superlative framings (better than, best, weakest, the most convincing), verdict
//                  commentary (convincing, thin, impressive, red flags, concerns about her), and the manner (shaky,
//                  hesitated, seemed nervous). ASK_RULES are for the lead's free-form question to Milo and are wider:
//                  a question cannot need "weakest" to find what was said. OUTPUT_RULES are for what Milo writes (a
//                  coach suggestion, a private answer, a plan's why); they must let a fair question to the candidate
//                  ("Who did you hire first?", "Where did you struggle?") through, so they key on the candidate in the
//                  third person or on commentary about an answer.
//   3. language    the rules read English only, and a round runs in English (no round records another language), so
//                  any text that does not read as English is refused rather than translated: another script, ¿ or ¡,
//                  a French elision (qu'elle, l'air), a common function word of Spanish, French, German, Portuguese,
//                  Italian or Dutch, a lower-case word with an accent outside a short list of English loan words, or (for the
//                  lead's question only) three words or more with no common English word in them.
// What it still cannot catch, said plainly: a judgement in English words none of the rules name. The output check is the
// backstop for an ask the input check missed, and the person decides (decision 6).

/** One token for every way of naming the candidate, so a rule written for "her" also reads "him", "them", "the applicant". */
export const CAND = String.raw`cand(?:'s)?`;

const CONTRACTIONS: ReadonlyArray<[RegExp, string]> = [
  [/\bwon't\b/g, 'will not'], [/\bcan't\b/g, 'can not'], [/\bcannot\b/g, 'can not'], [/\bshan't\b/g, 'shall not'],
  [/n't\b/g, ' not'], [/'re\b/g, ' are'], [/'ve\b/g, ' have'], [/'ll\b/g, ' will'], [/\bi'm\b/g, 'i am'],
  [/\b(how|where|what|why|who|when)'d\b/g, '$1 did'], [/'d\b/g, ' would'],
  [/\b(she|he|it|that|what|who|where|how|there|here|this)'s\b/g, '$1 is'], [/\blet's\b/g, 'let us'],
];

/** Lower case, unified quotes, contractions expanded, the candidate folded to CAND, punctuation to spaces. */
export function normalise(text: string): string {
  let s = text.toLowerCase().normalize('NFC').replace(/[‘’`´]/g, '\'').replace(/[“”«»„]/g, '"').replace(/[–—]/g, '-');
  for (const [re, to] of CONTRACTIONS) s = s.replace(re, to);
  s = s.replace(/\b(?:the|other|another)\s+(?:other\s+)?(?:candidates?|applicants?|interviewees?)\b/g, (m) => (/\bother|another\b/.test(m) ? ' othercand ' : m));
  s = s.replace(/\b(?:the|this|that|our|your)\s+(?:candidate|applicant|interviewee|person|individual|guy|woman|man|girl|lady)'s\b/g, ' cand\'s ');
  s = s.replace(/\b(?:the|this|that|our|your)\s+(?:candidate|applicant|interviewee|person|individual|guy|woman|man|girl|lady)\b/g, ' cand ');
  s = s.replace(/\b(?:his|their|theirs|hers)\b/g, ' cand\'s ');
  s = s.replace(/\b(?:she|he|they|her|him|them|herself|himself|themselves|themself)\b/g, ' cand ');
  s = s.replace(/[^\p{L}\p{N}'/ ]+/gu, ' ').replace(/(^|\s)'+|'+(?=\s|$)/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

// ── Language ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Function words of Spanish, French, German, Portuguese, Italian and Dutch that are not English words. */
const FOREIGN = new Set([
  // Spanish
  'el', 'los', 'las', 'una', 'unos', 'unas', 'del', 'que', 'qué', 'por', 'para', 'pero', 'muy', 'ella', 'ellos', 'ellas', 'él', 'es', 'fue',
  'está', 'estaba', 'cómo', 'dónde', 'cuál', 'cuándo', 'debemos', 'deberíamos', 'tiene', 'este', 'esta', 'eso', 'esto', 'lo', 'le', 'se',
  'candidata', 'candidato', 'contratar', 'contratarla', 'contratarlo', 'buena', 'bueno', 'mala', 'malo', 'dijo', 'hizo', 'algo', 'sobre', 'donde', 'cuando',
  // French
  'les', 'des', 'et', 'est', 'une', 'du', 'avec', 'sur', 'dans', 'pas', 'elle', 'il', 'ils', 'elles', 'qu', 'quel', 'quelle', 'comment', 'nous', 'vous',
  'devrions', 'devons', 'embaucher', 'avait', 'était', 'cette', 'ce', 'ces', 'au', 'aux', 'où', 'mais', 'très', 'été', 'candidat', 'faible', 'bonne', 'mauvaise', 'trouve',
  // German
  'der', 'das', 'und', 'ist', 'ein', 'eine', 'einen', 'nicht', 'mit', 'sie', 'wir', 'ich', 'sollten', 'sollen', 'würde', 'würden', 'einstellen',
  'wie', 'wo', 'welche', 'welcher', 'haben', 'kandidat', 'kandidatin', 'sehr', 'schlecht', 'schwach', 'auch', 'oder', 'aber', 'wen', 'wer', 'zuerst',
  // Portuguese and Italian
  'uma', 'muito', 'não', 'você', 'ela', 'ele', 'contratá', 'il', 'gli', 'molto', 'è', 'della', 'di', 'lei', 'dovremmo', 'assumere',
  // Dutch
  'het', 'een', 'niet', 'zij', 'wij', 'moeten', 'aannemen',
].map((w) => w.normalize('NFC')));
/** English words with an accent that may appear in a question about an interview. */
const LOAN = new Set(['résumé', 'resumé', 'café', 'naïve', 'naïvely', 'cliché', 'façade', 'déjà', 'vu', 'fiancé', 'rôle', 'über', 'à', 'vis']);
/** Common English words: a question of three words or more must hold at least one. */
const ENGLISH = new Set(('a an the and or but of to in on at for with by from as about into over after before during than then so if not no yes '
  + 'is are was were be been being am do does did done have has had will would should could can may might must shall '
  + 'i me my we us our you your it its this that these those there here what which who whom whose where when why how '
  + 'cand cand\'s othercand any all some each every more most other same only just also again still yet ever '
  + 'say said says tell told talk talked mention mentioned describe described explain explained answer answered ask asked question questions '
  + 'find show list give summarise summarize quote line lines part point time first last next left up out off down').split(/\s+/));

const words = (s: string): string[] => s.split(/[^\p{L}\p{N}']+/u).map((w) => w.replace(/^'+|'+$/g, '')).filter(Boolean);

/**
 * Does the text read as English, the one language the rules read? Empty text does. `wholeSentence` (the lead's ask)
 * also needs one common English word in three or more; Milo's own words may be terse ("Serves people leadership.").
 */
export function readsAsEnglish(text: string, wholeSentence = true): boolean {
  const raw = text.normalize('NFC');
  if (/(?=\p{L})\P{Script=Latin}/u.test(raw)) return false;
  if (/[¿¡]/.test(raw)) return false;
  if (/(?<![\p{L}])(?:qu|l|d|j|n|c|s|m|t)['’]\p{L}/iu.test(raw) && !/(?<![\p{L}])o['’]clock/iu.test(raw)) return false;
  const tokens = words(raw.replace(/’/g, '\''));
  for (const [i, t] of tokens.entries()) {
    const lower = t.toLowerCase();
    // An all-capital short token is an acronym ("ES modules", "IL code"), not a word of another language.
    const acronym = t.length <= 4 && t === t.toUpperCase() && /\p{L}/u.test(t);
    if (!acronym && FOREIGN.has(lower)) return false;
    // A capitalised word mid-sentence may be a name ("José"); any other word with a letter beyond a-z must be a loan word.
    const name = i > 0 && /^\p{Lu}/u.test(t);
    if (!name && /[^a-z0-9']/.test(lower) && !LOAN.has(lower)) return false;
  }
  const plain = words(normalise(raw));
  if (wholeSentence && plain.length >= 3 && !plain.some((w) => ENGLISH.has(w))) return false;
  return true;
}

// ── The rules (on normalised text) ───────────────────────────────────────────────────────────────────────────────────

const ADV = String.raw`(?:a little |a bit |a tad |quite |very |rather |somewhat |really |pretty |so |too |kind of |sort of |slightly |extremely |fairly |visibly )?`;
const MANNER = String.raw`(?:shaky|nervous|nervy|unsure|uncertain|uncomfortable|confident|unconfident|flustered|rattled|stressed|anxious|calm|relaxed|defensive|evasive|hesitant|lost|confused|tense|awkward|shy|timid|jittery|overwhelmed|tired|bored|distracted|engaged|enthusiastic|excited|arrogant|cocky|humble|honest|dishonest|genuine|sincere|rehearsed|scripted|out of cand's depth|uneasy|panicked|frazzled|composed|sharp|slow)`;
/** After CAND, a verb means CAND is the subject ("the rate they set"), not the object of the judging word. */
const NOT_SUBJECT = String.raw`(?!\s+(?:said|says|set|use|used|chose|pick|picked|quoted|described|mentioned|gave|got|put|ran|hit|built|wrote|had|have|has|is|are|was|were|would|will|did|do|does|could|should|can|might|may|must|need\w*|want\w*|\w+ed)\b)`;
/** Commentary on an answer: what Milo must never say of one, nor be asked to find. */
const VERDICT_ADJ = String.raw`(?:thin|shallow|superficial|vague|weak|strong|solid|lacking|sparse|generic|rehearsed|scripted|canned|textbook|hand ?wavy|rambling|unfocused|evasive|convincing|unconvincing|compelling|persuasive|impressive|unimpressive|disappointing|underwhelming|lacklust(?:re|er)|mediocre|excellent|outstanding|exceptional|brilliant|great|good|bad|poor|decent|ok|okay|adequate|insufficient|incomplete|muddled|confused|crisp|sloppy|careless|naive|simplistic|lame|terrible|awful|amazing|fantastic|stellar|perfect|flawless)`;
const ANSWER_NOUN = String.raw`(?:answers?|accounts?|stor(?:y|ies)|responses?|examples?|explanations?|reasoning|showing|performance|interview|round|pitch|case)`;

/** Rules for Milo's own words (and for asks too): a judgement of the candidate or of an answer, in any wording the rules name. */
export const OUTPUT_JUDGES: readonly RegExp[] = [
  // hiring, advancing, offering
  /\b(?:should|shall|would|could|will|do|must|can|ought to)\s+(?:we|i|the panel|the team)\s+(?:not\s+|still\s+|really\s+|just\s+)?(?:hire|advance|reject|pass on|turn down|move forward|move ahead|offer|extend an offer|bring cand on|take cand on|progress|proceed)\b/,
  /\b(?:should|would|could|will|can)\s+cand\s+(?:not\s+)?be\s+(?:hired|advanced|rejected|moved forward|offered|passed|failed)\b/,
  new RegExp(String.raw`\b(?:hire|hiring|reject|rejecting|advance|advancing|onboard)\s+cand\b${NOT_SUBJECT}`),
  new RegExp(String.raw`\b(?:move|advance|send|progress|pass|put)\s+cand\s+(?:forward|through|ahead|along|on to|onto the next|to the next)\b`),
  /\b(?:advance|move|progress|send|invite|bring)\s+(?:\w+\s+){0,2}(?:to|into|through)\s+(?:the\s+)?(?:next|final|onsite|another)\s+(?:round|stage|step)\b/,
  new RegExp(String.raw`\b(?:make|give|extend|send)\s+(?:cand\s+)?an?\s+offer\b|\boffer\s+cand\s+(?:the|a)\s+(?:job|role|position)\b|\bno[- ]hire\b|\bhire or not\b|\bhireable\b|\bhire ?able\b`),
  // rating, scoring, ranking, grading
  new RegExp(String.raw`\b(?:rate|rated|rating|score|scored|scoring|rank|ranked|ranking|grade|graded|grading|mark|marked|place|placing|level|levelling|leveling)\s+(?:cand\b${NOT_SUBJECT}|${CAND}\s+${ANSWER_NOUN}|this answer|that answer|the answer|othercand|the candidates|candidates)\b`),
  new RegExp(String.raw`\b(?:rating|score|ranking|grade|mark|level|points)\s+(?:of|for|on)\s+(?:cand|${CAND}\s+${ANSWER_NOUN}|this answer|that answer)\b`),
  /\b(?:what|which)\s+(?:grade|score|rating|level|mark)\s+(?:would|should|do|does|did|will|is|was)\s+(?:you|i|we|cand|cand's answer)\b/,
  /\b(?:on the rubric|out of (?:10|ten|5|five|4|four)|\d+\s*\/\s*(?:4|5|10))\b/,
  /\brecommend\w*\b/,
  // comparison and ranking against others
  /\bothercand\b|\b(?:top|bottom|best|worst|strongest|weakest)\s+(?:candidate|applicant|performer|hire)s?\b|\bof (?:all )?the candidates\b|\bshortlist\w*\b/,
  new RegExp(String.raw`\b(?:better|worse|stronger|weaker|smarter|more (?:convincing|impressive|qualified|senior|experienced|capable|competent))\s+than\s+(?:cand|othercand|most|average|expected|anyone|everyone)\b`),
  new RegExp(String.raw`\bcompar\w*\s+(?:cand\b${NOT_SUBJECT}|${CAND}\s+${ANSWER_NOUN})`),
  // fit, level and the bar
  /\b(?:culture|cultural|team|role|good|great|bad|poor|right|strong|weak|natural|perfect|clear)\s+fit\b|\bnot an? (?:good |great )?fit\b|\bcand (?:\w+ )?fits? in\b|\bfit in (?:with|on) (?:the|our|a) team\b|\bfit for (?:the|this|our) (?:role|team|job|position|company)\b|\bfits? the (?:role|team|bill|profile)\b/,
  /\b(?:meets?|met|clears?|cleared|raises?|raised|below|above|under|over|hits?|reach(?:es|ed)?)\s+the bar\b|\bbar[- ]raiser\b/,
  /\bat (?:this|that|our|the|cand's|cand|your) level\b(?!\s+of\b)|\b(?:senior|experienced|qualified|smart) enough\b/,
  // verdict commentary on an answer
  new RegExp(String.raw`\b(?:that|this|the|cand's|cand|your|an?)\s+${ANSWER_NOUN}\s+(?:was|is|seemed|seems|felt|feels|sounded|sounds|looked|looks|came across as|comes across as)\s+${ADV}(?:an? )?${VERDICT_ADJ}\b`),
  new RegExp(String.raw`\b(?:a|an|that|this|the)\s+${ADV}${VERDICT_ADJ}\s+${ANSWER_NOUN}\b`),
  /\b(?:most|least)\s+(?:convincing|impressive|compelling|persuasive|credible|believable|concerning|worrying|promising|thorough|thoughtful|complete|polished|detailed|honest)\b/,
  /\b(?:so far|today|of the day|we have heard|i have heard)\b.*\b(?:best|worst|strongest|weakest)\b|\b(?:best|worst|strongest|weakest)\b.*\b(?:so far|today|of the day|we have heard|i have heard)\b/,
  /\b(?:exactly|just|precisely) what (?:we|i) (?:hope|want|like|need|expect|look|are looking|were looking)\w*\b|\bwhat (?:we|i) (?:hope|want|like|need|expect|look for|are looking for) to (?:hear|see)\b/,
  /\b(?:un)?convincing\b|\bconvinced\b|\b(?:un)?persuasive\b|\bcompelling\b/,
  /\bimpress\w*\b|\bunimpressive\b|\bdisappoint\w*\b|\bunderwhelm\w*\b|\blacklust\w*\b|\bmediocre\b|\bstand ?out\b|\bstood out\b/,
  /\b(?:nailed|aced|bombed|crushed|killed|smashed|blew|botched|flubbed|fumbled)\s+(?:it|that|the)\b|\bspot on\b|\bwell done\b|\b(?:good|great|nice|excellent) (?:job|work|stuff)\b|\btextbook\b|\bwow\b/,
  /\b(?:red|yellow|amber|green|warning) (?:flags?|signs?)\b|\bdeal ?breakers?\b|\brisky hire\b/,
  new RegExp(String.raw`\b(?:concerns?|concerned|worr(?:y|ies|ied|ying)|doubts?|doubtful|reservations?|misgivings?|qualms?|skeptic\w*|sceptic\w*|hesitations?)\s+(?:about|with|over|regarding|around|on)\s+(?:cand\b|${CAND}\s+${ANSWER_NOUN})`),
  /\b(?:i|we)\s+(?:am|are|was|were)?\s*(?:not\s+)?(?:sure|certain|convinced|persuaded|satisfied|happy)\s+(?:that\s+)?cand\b/,
  new RegExp(String.raw`\bcand\s+(?:really|actually|truly|genuinely)\s+(?:led|did|owned|built|knew|understood|designed|wrote|ran|drove|know|understand|own|lead)\b`),
  new RegExp(String.raw`\b(?:i|we)\s+(?:think|feel|believe|reckon|suspect|doubt|guess|sense)\s+(?:that\s+)?cand\b`),
  /\b(?:lying|lied|exaggerat\w*|overstat\w*|embellish\w*|bluff\w*|inflat\w* cand's|credib\w*|trustworth\w*|untrustworth\w*|dishonest)\b/,
  /\bverdict\b|\b(?:my|our) (?:opinion|impression|take|read|gut|sense|feeling)\b/,
  new RegExp(String.raw`\b(?:assess|assessing|assessment of|evaluate|evaluating|evaluation of|judge|judging|judg(?:e)?ment of|appraise|appraisal of)\s+(?:cand\b${NOT_SUBJECT}|${CAND}\s+${ANSWER_NOUN}|this answer|that answer|the answer)`),
];

/** The candidate's person rather than their words: the manner, read from words the coach's PERSONAL list leaves out. */
export const OUTPUT_PERSONAL: readonly RegExp[] = [
  new RegExp(String.raw`\b(?:seem|seems|seemed|seeming|appear|appears|appeared|look|looks|looked|sound|sounds|sounded|came across|comes across|come across|felt|feel|feels)\s+(?:as |like )?${ADV}${MANNER}\b`),
  /\b(?:shaky|flustered|rattled|jittery|fidget\w*|sweat\w*|blush\w*|trembl\w*|shook|stammer\w*|stutter\w*|hesitat\w*|nervous\w*|uneas\w*|panick\w*|tongue[- ]tied|caught off guard|thrown off|froze|freezing up|blanked)\b/,
  /\bcand\s+(?:\w+\s+)?paus\w*|\b(?:long|awkward|many|lots of) pauses?\b|\bpaus\w* before (?:answer\w*|respond\w*|repl\w*|speaking)\b|\bcand\s+took (?:a (?:long|while)|long|ages|forever)\b|\b(?:ums?|uhs?|ers?) and (?:ums?|uhs?|ers?)\b|\bfiller words?\b/,
];

/** Rules for the lead's free-form question to Milo only: what a fair search never needs to say. */
export const ASK_JUDGE_RULES: readonly RegExp[] = [
  // a verdict asked as a yes or no ("was that answer thin?")
  new RegExp(String.raw`\b(?:was|is|were|are)\s+(?:that|this|the|cand's|cand|an?)\s+${ANSWER_NOUN}\s+${ADV}${VERDICT_ADJ}\b`),
  // "should we", "is she", "can he", "how did they do"
  /\bshould\s+(?:we|i|you|the panel|the team)\s+(?:\w+\s+)?(?:hire|advance|reject|pass|move|offer|bring|keep|consider|trust|worry|be|go|progress|proceed|continue|invite|push|let|give|extend|believe|back|pick|choose|prefer|take|drop|cut|stop)\b/,
  /\byour (?:opinion|impression|view|take|read|gut|sense|feeling|verdict|recommendation|call)\b/,
  new RegExp(String.raw`\b(?:is|was|are|were|seems?|seemed)\s+cand\s+(?:\w+\s+){0,2}(?:good|great|strong|weak|bad|poor|qualified|unqualified|competent|capable|smart|bright|clever|senior|junior|ready|right for|right fit|the right|suitable|fit|hireable|worth|enough|a keeper|any good|up to|cut out|solid|sharp|talented|experienced|promising|impressive|convincing|credible|honest|trustworthy|reliable|better|worse|best|worst|ok|okay|decent|mediocre|exceptional|outstanding|excellent|a fit|a match|a hire|a no|a yes)\b`),
  new RegExp(String.raw`\b(?:can|could|would|will|might)\s+cand\s+(?:really\s+|actually\s+|even\s+)?(?:succeed|thrive|cope|lead|manage|handle|do the job|do well|do it|grow|ramp|scale|perform|deliver|keep up|step up|cut it|be (?:a|an|good|great|successful|ready|able|effective|trusted|relied|any good))\b`),
  new RegExp(String.raw`\bhow\s+(?:did|does|do|is|was|are|were|has|have|will|would)\s+cand\s+(?:\w+\s+)?(?:do|doing|done|did|perform\w*|go|going|gone|fare|fared|come across|compare|measure up|stack up|hold up|handle (?:it|that|the (?:question|interview|round|pressure)|cand)|get on|cope)\b`),
  new RegExp(String.raw`\bhow\s+(?:was|were|is|did)\s+(?:${CAND}\s+|the\s+)?(?:interview|round|performance|showing|answers?|overall)\b|\bhow (?:good|strong|weak|well|badly|poorly|bad)\b`),
  new RegExp(String.raw`\b(?:did|does|do|has|have|will|would)\s+cand\s+(?:\w+\s+)?(?:nail|ace|bomb|blow|botch|crush|smash|impress|disappoint|struggle|flounder|deserve|earn|qualify|make the cut|get through)\b`),
  new RegExp(String.raw`\b(?:did|does|do)\s+cand\s+(?:really\s+|actually\s+|even\s+|truly\s+)?(?:know|understand|grasp|get it|get the|have (?:a )?clue|have what it takes)\b`),
  new RegExp(String.raw`\b(?:did|does|do|has|have)\s+cand\s+(?:have|show|demonstrate|display|possess|lack)\s+(?:\w+\s+){0,2}(?:experience|skills?|depth|knowledge|understanding|ability|abilities|potential|leadership|maturity|seniority|chops|talent|aptitude|expertise|competence|judg(?:e)?ment)\b`),
  new RegExp(String.raw`\b(?:did|does|do)\s+cand\s+(?:do|perform|answer|explain|communicate|respond)\s+(?:\w+\s+)?(?:well|badly|poorly|ok|okay|alright|good|fine|great|terribly)\b`),
  /\b(?:would|do|did|will|could)\s+you\s+(?:hire|recommend|advance|reject|pick|choose|trust|back|vouch)\b/,
  /\bwhat (?:would|do|should|did) (?:you|i|we) (?:rate|score|give|grade|mark)\b/,
  /\bwhat (?:do|did|would|should) (?:you|i|we) (?:think|make|feel)\b|\bhow do you feel about\b|\b(?:thoughts|feelings|impressions?|opinions?)\s+(?:on|about|of)\b/,
  /\b(?:did|does|will|would|could|should|can)\s+cand\s+(?:pass|fail)$|\b(?:pass|fail)(?:ed|es|ing)?\s+(?:the )?(?:bar|round|interview|screen|loop)\b|\bgo or no\b|\bgo no go\b|\bthumbs (?:up|down)\b|\b(?:yes or no|yay or nay) on\b/,
  // persuasion and fishing
  /\b(?:convince|persuade|reassure|sell)\s+(?:me|us)\b|\bmake (?:the|a|cand's|my|our) (?:\w+ )?case\b|\b(?:case|argument|arguments)\s+(?:for|against)\b|\bargue (?:for|against)\b/,
  /\b(?:i|we|you)\s+(?:\w+\s+){0,2}(?:worr\w*|concern\w*|nervous|wary|careful|cautious|hesitant|doubt\w*)\b|\b(?:worr\w*|concern\w*|doubts?)\s+(?:about|with|over|regarding)\s+(?:cand|anything)\b|\b(?:anything|something|any)\s+(?:i|we)\s+(?:should|must|ought to|need to)\s+(?:worry|be|watch|know|look out|flag|keep in mind)\b/,
  /\b(?:any|what|which|main|biggest|major|real|serious)\s+(?:concerns|worries|doubts|reservations|risks|red flags|holes|weak spots)\s*(?:$|should|do|would|must|with cand|about cand|in cand)/,
  /\b(?:anything|something)\s+(?:wrong|off|bad|concerning|worrying|troubling|alarming|suspicious|fishy|impressive|good|great|positive|negative|notable|remarkable)\b/,
  // superlatives and the weak or strong moment, wrapped as a search
  /\b(?:best|worst|strongest|weakest|poorest|shakiest|finest|brightest|lowest|highest|most impressive|most convincing|least convincing|most compelling)\b(?!\s+(?:practices?|effort|consistency|typing|types?|references?|ordering|isolation|guarantees?|case\b(?!\s+(?:for|against))|fit line))/,
  /\b(?:strong|weak|strongly|weakly|stronger|weaker)\b(?!\s+(?:consistency|consistent|reference|references|typing|types?|ordering|isolation|guarantees?|password|passwords|hash|hashes|cipher|crypto|scaling|signal|link|links|map|maps|set|sets|etag|etags|entity|entities))/,
  /\b(?:strengths?|weakness(?:es)?|shortcomings?|short ?falls?|failings?|flaws?|blind ?spots?|gaps?)\s+(?:of|in|for)\s+cand\b|\bcand's\s+(?:strengths?|weakness(?:es)?|shortcomings?|failings?|flaws?|blind ?spots?|gaps?|performance|potential|ability|abilities|level|seniority|competence)\b|\bstrengths and weaknesses\b|\bpros and cons of (?:cand|hiring|cand's)\b/,
  /\b(?:struggl\w*|stumbl\w*|floundered|faltered|fell (?:short|flat|apart)|messed up|screwed up|went (?:badly|poorly|well)|did (?:badly|poorly|well)|could have (?:done|been|said|answered) (?:better|more|differently)|should have (?:said|known|done|answered))\b/,
  /\b(?:good|bad|weak|strong|great|poor|solid|decent|convincing|shallow|thin|vague|best|worst)\s+(?:examples?|answers?|responses?|stories|story|showing|interview|round|explanations?|reasoning|communicat\w*|candidate|hire|points?|moments?|parts?|bits?|areas?|spots?|sides?)\b/,
  /(?<!zero )\btrust\b(?!\s+(?:boundar\w*|store|chain|model|anchor|policy|relationship|zone|level))|\bbelieve\s+(?:cand|what cand|anything cand)\b|\b(?:credib\w*|honest\w*|truthful|lying|lied|exaggerat\w*|overstat\w*|bluff\w*|bullshit\w*)\b/,
  /\b(?:seniority|talent|aptitude|competence|calibre|caliber|chops|level of (?:cand|experience|seniority|skill))\b/,
  /\b(?:pick|choose|select|prefer)\s+(?:cand\b|othercand)|\bwho (?:was|is|did) (?:better|best|worse|stronger|weaker)\b/,
];

/** The manner, asked for: what a fair search never needs either. */
export const ASK_PERSONAL_RULES: readonly RegExp[] = [
  new RegExp(String.raw`\b(?:does|did|do|is|was|were|are)\s+cand\s+(?:\w+\s+)?(?:seem|look|sound|appear|come across|feel)\b`),
  new RegExp(String.raw`\bwhere (?:is|are|was|were) cand (?:originally |really )?from\b|\bwhat is ${CAND} (?:background|nationality|religion|ethnicity|age|accent|first language)\b`),
  /\b(?:body language|eye contact|facial|(?<!regular )expressions?|posture|tone|voice|manner|mood|vibes?|charisma|attitude|demeanou?r|confidence(?!\s+(?:interval|level|score))|composure|poise|nerves|emotion\w*|feelings?|cried|crying|laugh\w*|smil\w*|frown\w*|sigh(?:ed|s|ing)?)\b/,
  /\b(?:go|goes|went|gone|going) (?:silent|quiet)\b|\blong silences?\b|\bslow to (?:answer|respond|reply)\b/,
];

const anyOf = (rules: readonly RegExp[], s: string): boolean => rules.some((r) => r.test(s));

export type JudgementCode = 'judges' | 'personal';

/** What Milo wrote (a coach suggestion, a private answer, a plan's why): the first rule it breaks, or null. */
export function judgeOutput(text: string): JudgementCode | null {
  const n = normalise(text);
  if (anyOf(OUTPUT_PERSONAL, n)) return 'personal';
  if (anyOf(OUTPUT_JUDGES, n)) return 'judges';
  if (!readsAsEnglish(text, false)) return 'judges';
  return null;
}

/** The lead's free-form question: the first rule it breaks, or null. Text that does not read as English is a judgement (refused). */
export function judgeAsk(text: string): JudgementCode | null {
  if (!readsAsEnglish(text)) return 'judges';
  const n = normalise(text);
  if (anyOf(ASK_PERSONAL_RULES, n) || anyOf(OUTPUT_PERSONAL, n)) return 'personal';
  if (anyOf(ASK_JUDGE_RULES, n) || anyOf(OUTPUT_JUDGES, n)) return 'judges';
  return null;
}
