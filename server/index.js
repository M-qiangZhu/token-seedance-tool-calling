import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { PostgresStore } from './postgres-store.js';
import { MemoryStore } from './store.js';
import { createPromptCipher, hashPassword } from './security.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 18081);
const production = process.env.NODE_ENV === 'production';

if (production && !process.env.DATABASE_URL) throw new Error('生产环境必须配置 DATABASE_URL');
if (production && !process.env.PROMPT_ENCRYPTION_KEY) throw new Error('生产环境必须配置 PROMPT_ENCRYPTION_KEY');

const store = process.env.DATABASE_URL ? new PostgresStore(process.env.DATABASE_URL) : new MemoryStore();
await store.init();
await bootstrapAdmin(store);
if (process.env.DATABASE_URL) await store.markAllNonterminalAuthRequired();

const staticDir = production ? path.resolve(dirname, '../dist') : undefined;
const app = createApp({
  staticDir, store, startWorker: true, secureCookies: production && process.env.COOKIE_SECURE !== 'false',
  promptCipher: createPromptCipher(process.env.PROMPT_ENCRYPTION_KEY || 'local-development-only')
});
const server = app.listen(port, '0.0.0.0', () => console.log(`TokenHub Seedance API listening on http://0.0.0.0:${port}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    app.locals.worker.stop();
    server.close(async () => { await store.close(); process.exit(0); });
  });
}

async function bootstrapAdmin(target) {
  if (await target.countUsers()) return;
  const username = process.env.BOOTSTRAP_ADMIN_USERNAME;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!username || !password) {
    throw new Error('系统尚无用户，请设置 BOOTSTRAP_ADMIN_USERNAME 和 BOOTSTRAP_ADMIN_PASSWORD 完成首次启动');
  }
  await target.createUser({
    id: crypto.randomUUID(), username, passwordHash: await hashPassword(password),
    role: 'ADMIN', disabled: false, mustChangePassword: true
  });
  console.log(`Bootstrap administrator created: ${username}`);
}
