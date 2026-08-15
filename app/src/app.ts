import Fastify from 'fastify';
import pg from 'pg';

export function buildApp() {
  const app = Fastify({ logger: true });
  const pool = process.env.DATABASE_URL
    ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
    : null;

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/', async () => ({
    service: 'l5-docker',
    hostname: process.env.HOSTNAME ?? 'unknown', // ← container id
    user: process.getuid?.() === 0 ? 'root ⚠️' : `uid=${process.getuid?.()}`,
    node: process.version,
    db: pool ? 'setup' : 'not setup',
  }));

  app.get('/db', async (_req, reply) => {
    if (!pool) return reply.code(503).send({ error: 'DATABASE_URL not assigned' });
    const { rows } = await pool.query('select now() as time, current_user as who');
    return rows[0];
  });

  app.addHook('onClose', async () => {
    await pool?.end();
  });

  return app;
}
