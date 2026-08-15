import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';

const hasDb = Boolean(process.env.DATABASE_URL);

test('GET /health -> 200 ok', async (t) => {
  const app = buildApp();
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/health' });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });
});

test('GET / -> 200 з діагностикою', async (t) => {
  const app = buildApp();
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/' });
  const body = res.json();

  assert.equal(res.statusCode, 200);
  assert.equal(body.service, 'l5-docker');
  assert.match(body.user, /^(uid=\d+|root ⚠️)$/);
  assert.equal(body.node, process.version);
  assert.equal(body.db, hasDb ? 'налаштована' : 'не налаштована');
});

test('GET /unknown -> 404', async (t) => {
  const app = buildApp();
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/unknown' });

  assert.equal(res.statusCode, 404);
});

test('GET /db -> 503 без DATABASE_URL', {
  skip: hasDb && 'потрібен запуск без DATABASE_URL',
}, async (t) => {
  const app = buildApp();
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/db' });

  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.json(), { error: 'DATABASE_URL не задано' });
});

test('GET /db -> 200 з даними Postgres', {
  skip: !hasDb && 'потрібна DATABASE_URL (npm test у контейнері api)',
}, async (t) => {
  const app = buildApp();
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/db' });
  const body = res.json();

  assert.equal(res.statusCode, 200);
  assert.equal(body.who, 'app');
  assert.ok(body.time);
});
