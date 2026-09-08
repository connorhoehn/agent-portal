// Jest `setupFilesAfterEnv` hook: give every test file exactly one listening
// HTTP server for supertest to reuse, and take it back down afterwards.
//
// This runs inside the test framework (unlike `setupFiles`, which runs before
// it), so `beforeAll`/`afterAll` exist here. It shares a module registry with
// the test file, and `test-support/http.ts` additionally parks its state on
// `globalThis`, so the server started here is the same one the suite's
// `request(...)` calls find.
//
// Files that never make an HTTP request pay one bind + one close, which is
// noise next to what they saved.

import { startSharedServer, stopSharedServer } from './http.js';

beforeAll(async () => {
  await startSharedServer();
});

afterAll(async () => {
  await stopSharedServer();
});
