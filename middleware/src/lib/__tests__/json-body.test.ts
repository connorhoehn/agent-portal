// The app's JSON parser (lib/json-body.ts): express's 100 KB everywhere, and the larger limit a few routes need so their own
// size checks (the board checkpoint's MAX_BOARD_SCENE_BYTES, the kit's per-board boardBytes) are what refuses, not a bare 413.
jest.mock('../../config.js', () => ({ config: { mock: { aurora: true } } }));
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { jsonBody } from '../json-body.js';
import { INTERVIEWS_LARGE_JSON, INTERVIEWS_MOUNT } from '../../routes/interviews/body-limits.js';
import { MAX_BOARD_SCENE_BYTES } from '../interviews/board/snapshots.js';
import { KIT_LIMITS } from '../interviews/kit.js';

const app = express();
app.use(jsonBody(INTERVIEWS_LARGE_JSON));
app.use((req, res) => { res.json({ bytes: JSON.stringify(req.body ?? null).length }); });

const body = (bytes: number) => ({ elements: [{ id: 'a', type: 'text', text: 'x'.repeat(bytes) }] });

describe('the JSON parser', () => {
  it('lets a board checkpoint past the scene cap reach the route, so the route\'s own check refuses it', async () => {
    const res = await request(app).post('/api/interviews/interviews/iv-a/board/snapshots').send(body(MAX_BOARD_SCENE_BYTES + 1024));
    expect(res.status).toBe(200);
    expect(res.body.bytes).toBeGreaterThan(MAX_BOARD_SCENE_BYTES);
  });

  it('lets a kit carrying a board at its cap reach the kit route', async () => {
    const res = await request(app).put('/api/interviews/openings/op-1/kit').send(body(KIT_LIMITS.boardBytes + 1024));
    expect(res.status).toBe(200);
  });

  it('keeps 100 KB for every other route and method', async () => {
    expect((await request(app).post('/api/interviews/interviews/iv-a/pad').send(body(200 * 1024))).status).toBe(413);
    expect((await request(app).put('/api/interviews/interviews/iv-a/board/snapshots').send(body(200 * 1024))).status).toBe(413);
    expect((await request(app).post('/api/interviews/interviews/iv-a/board/snapshots/x').send(body(200 * 1024))).status).toBe(413);
    expect((await request(app).post('/api/interviews/interviews/iv-a/board/snapshots').send(body(10))).status).toBe(200);
  });

  it('names the interviews router where index.ts mounts it', () => {
    const index = readFileSync(join(__dirname, '..', '..', 'index.ts'), 'utf8');
    expect(index).toContain(`app.use('${INTERVIEWS_MOUNT}', requireTenant('interviews')`);
    expect(index).toContain('app.use(jsonBody(INTERVIEWS_LARGE_JSON, captureRawBody));');
  });
});
