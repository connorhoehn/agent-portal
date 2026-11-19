// "Design Twitter" in the master template's format (lib/interviews/board/templates.ts): the prompt and "Your design" on
// its starting board, and the answer key (the provided design, the questions' answers, the red flags) that only the
// lead and the panel read. The wording is this repo's own.
import type { KitDesignQuestion, KitRedFlag } from '../lib/interviews/types.js';
import type { MasterPromptSpec, ProvidedDesignSpec } from '../lib/interviews/board/templates.js';

export const TWITTER_QUESTIONS: KitDesignQuestion[] = [
  { text: 'Who are the actors, and how does each one interface with the system?',
    answer: 'People, through the web and mobile clients, call one public HTTPS API behind the gateway. The fan-out worker is an internal actor: it reacts to each new post it reads from the queue.' },
  { text: 'Where are the posts stored, and why there?',
    answer: 'In the post store, a relational table keyed by post id with an index on (author_id, created_at). Posts are small, written once and read by author or by id, and that store is the source of truth every cache is rebuilt from.' },
  { text: 'How is a person\'s home timeline produced?',
    answer: 'On write: the post service saves the post and puts an event on the queue; the fan-out worker reads the author\'s followers and adds the post id to the front of each follower\'s cached timeline. A read is one cache lookup, then the posts fetched by id in one batch.' },
  { text: 'How do you handle an account that millions of people follow?',
    answer: 'Do not fan its posts out. Mark heavy accounts; when a timeline is read, the timeline service merges the cached list with the recent posts of the heavy accounts that reader follows (push for most, pull for the few).' },
  { text: 'Add trending topics, computed in the background, and update your diagram.', enhancement: true,
    answer: 'A trends worker reads the same post events, counts terms and tags over sliding windows, and writes the top list per region to a trends cache that a getTrends call reads.' },
];

export const TWITTER_PROMPT: MasterPromptSpec = {
  title: 'Design Twitter',
  intro: [
    'Build the back end of a short-post social network: people write brief text posts, follow other people and read a home timeline made of the posts of everyone they follow.',
    'Leave the real product aside and do not list its features. The aim is to show how you would structure the system and handle its central technical problems.',
    'Talk through your choices as you draw: the reasoning matters more than naming every technology.',
  ],
  note: 'Rendering the timeline, the web and mobile clients and anything else that runs on the device are out of scope.',
  stories: [{ actor: 'Users', can: ['publish a text post of up to 280 characters', 'follow and unfollow another user', 'read their home timeline, newest posts first'] }],
  maybe: ['like a post', 'search posts by keyword', 'attach a photo or a video', 'be notified when someone follows them'],
  questions: TWITTER_QUESTIONS.map((q) => ({ text: q.text, ...(q.enhancement ? { enhancement: true } : {}) })),
};

export const TWITTER_DESIGN: ProvidedDesignSpec = {
  nodes: [
    { id: 'post-store', name: 'Post store', kind: 'store', col: 2, row: 0 },
    { id: 'clients', name: 'Web and mobile clients', kind: 'client', col: 0, row: 1 },
    { id: 'gateway', name: 'API gateway / load balancer', kind: 'service', col: 1, row: 1 },
    { id: 'posts', name: 'Post service', kind: 'service', col: 2, row: 1 },
    { id: 'queue', name: 'Post events queue', kind: 'queue', col: 3, row: 1 },
    { id: 'fanout', name: 'Fan-out worker', kind: 'worker', col: 4, row: 1 },
    { id: 'timeline', name: 'Timeline service', kind: 'service', col: 2, row: 2 },
    { id: 'timeline-cache', name: 'Timeline cache', kind: 'store', col: 3, row: 2 },
    { id: 'users', name: 'User and follow service', kind: 'service', col: 2, row: 3 },
    { id: 'follow-graph', name: 'Follow graph', kind: 'store', col: 3, row: 3 },
  ],
  links: [
    { from: 'clients', to: 'gateway', label: 'HTTPS' },
    { from: 'gateway', to: 'posts', label: 'createPost' },
    { from: 'gateway', to: 'timeline', label: 'getHomeTimeline' },
    { from: 'gateway', to: 'users', label: 'follow' },
    { from: 'posts', to: 'post-store', label: 'writes' },
    { from: 'posts', to: 'queue', label: 'post created' },
    { from: 'queue', to: 'fanout', label: 'consumes' },
    { from: 'fanout', to: 'timeline-cache', label: 'adds ids' },
    { from: 'fanout', to: 'follow-graph', label: 'reads followers' },
    { from: 'timeline', to: 'timeline-cache', label: 'reads' },
    { from: 'timeline', to: 'posts', label: 'posts by id' },
    { from: 'users', to: 'follow-graph', label: 'reads, writes' },
  ],
  purposes: [
    'API gateway: the one public entry; checks the session, limits the rate and routes each call.',
    'Post service: checks and stores posts, then announces each new post on the queue.',
    'Timeline service: answers the home timeline from the reader\'s cached list, merging in heavy accounts\' recent posts.',
    'Fan-out worker: for each new post, adds its id to every follower\'s cached timeline.',
    'User and follow service: profiles, follow and unfollow; owns the follow graph.',
  ],
  apis: [
    'createPost(userId: UserId, text: string): Post',
    'deletePost(userId: UserId, postId: PostId): void',
    'follow(userId: UserId, targetId: UserId): void',
    'unfollow(userId: UserId, targetId: UserId): void',
    'getHomeTimeline(userId: UserId, cursor?: string, limit?: int): Page<Post>',
    'getUserPosts(targetId: UserId, cursor?: string): Page<Post>',
  ],
  dataModel: {
    kind: 'Relational (Postgres) is the source of truth; a key-value cache (Redis) holds timelines.',
    tables: [
      'users(id bigint PK, handle varchar(30) unique, name text, follower_count int, created_at timestamptz)',
      'posts(id bigint PK, author_id bigint FK users, text varchar(280), created_at timestamptz); index (author_id, created_at)',
      'follows(follower_id bigint FK users, followee_id bigint FK users, created_at timestamptz); PK (follower_id, followee_id); index (followee_id)',
      'cache timeline:<userId> = post ids, newest first, at most 800',
    ],
  },
  answers: TWITTER_QUESTIONS.map((q) => q.answer!),
};

export const TWITTER_RED_FLAGS: KitRedFlag[] = [
  { group: 'over-engineering', text: 'A separate service for every noun (likes, hashtags, media) before the core flow works.' },
  { group: 'over-engineering', text: 'Sharding, several regions or a custom database drawn before any load was discussed.' },
  { group: 'responsibility', text: 'Fan-out on write for every account, including ones with millions of followers.' },
  { group: 'responsibility', text: 'No line between the cache and the source of truth: timelines kept only in the cache, or posts only on the queue.' },
  { group: 'responsibility', text: 'One service stores the post and builds every follower\'s timeline inside the request.' },
  { group: 'naming', text: 'API calls named as nouns (/posts/timeline/user) rather than for what they do.' },
  { group: 'naming', text: 'Vague service names (Manager, Handler, Processor) with no stated purpose.' },
  { group: 'other', text: 'A data model with no data types and no keys.' },
];
