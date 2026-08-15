import { buildApp } from './app.js';

const app = buildApp();

// graceful shutdown: without this docker stop waits 10s and then sends SIGKILL
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    console.log(`\n[${sig}] закриваюсь коректно…`);
    await app.close();
    process.exit(0);
  });
}

await app.listen({ port: 3000, host: '0.0.0.0' }); // 0.0.0.0, otherwise unreachable from outside the container
console.log(`слухаю :3000  ·  hostname=${process.env.HOSTNAME}  ·  uid=${process.getuid?.()}`);
