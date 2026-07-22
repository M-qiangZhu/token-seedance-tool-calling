import crypto from 'node:crypto';
import { PostgresStore } from '../server/postgres-store.js';
import { hashPassword } from '../server/security.js';

if (!process.env.DATABASE_URL) throw new Error('请设置 DATABASE_URL');
const username = String(process.argv[2] || '').trim();
const password = process.env.ADMIN_PASSWORD;
if (!username || !password) throw new Error('用法：ADMIN_PASSWORD=临时密码 pnpm admin:create 用户名');

const store = new PostgresStore(process.env.DATABASE_URL);
await store.init();
const existing = await store.findUserByUsername(username);
if (existing) {
  await store.updateUser(existing.id, { passwordHash: await hashPassword(password), role: 'ADMIN', disabled: false, mustChangePassword: true });
  console.log(`Administrator reset: ${username}`);
} else {
  await store.createUser({ id: crypto.randomUUID(), username, passwordHash: await hashPassword(password), role: 'ADMIN', mustChangePassword: true });
  console.log(`Administrator created: ${username}`);
}
await store.close();
