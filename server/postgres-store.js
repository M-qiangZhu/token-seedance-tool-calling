import pg from 'pg';
import { DEFAULT_PRICES } from './models.js';
import { DEFAULT_SETTINGS, dashboardFromTasks } from './store.js';

export class PostgresStore {
  constructor(connectionString) {
    this.pool = new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id uuid PRIMARY KEY, username text NOT NULL UNIQUE, password_hash text NOT NULL,
        role text NOT NULL, disabled boolean NOT NULL DEFAULT false,
        must_change_password boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS tasks_user_created_idx ON tasks(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS tasks_status_created_idx ON tasks(status, created_at);
      CREATE TABLE IF NOT EXISTS pricing (
        model text NOT NULL, resolution text NOT NULL, input_rate numeric(18,6) NOT NULL,
        output_rate numeric(18,6) NOT NULL, currency text NOT NULL DEFAULT 'CNY', version integer NOT NULL DEFAULT 1,
        updated_by uuid REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(model, resolution)
      );
      CREATE TABLE IF NOT EXISTS app_settings (id integer PRIMARY KEY CHECK(id=1), data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS audit_logs (
        id bigserial PRIMARY KEY, actor_id uuid REFERENCES users(id), action text NOT NULL,
        data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    for (const item of DEFAULT_PRICES) {
      await this.pool.query(`INSERT INTO pricing(model,resolution,input_rate,output_rate,currency,version)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(model,resolution) DO NOTHING`,
      [item.model, item.resolution, item.inputRate, item.outputRate, item.currency, item.version]);
    }
    await this.pool.query('INSERT INTO app_settings(id,data) VALUES(1,$1) ON CONFLICT(id) DO NOTHING', [DEFAULT_SETTINGS]);
  }

  async close() { await this.pool.end(); }
  async countUsers() { return Number((await this.pool.query('SELECT count(*) AS count FROM users')).rows[0].count); }
  async createUser(input) {
    try {
      const result = await this.pool.query(`INSERT INTO users(id,username,password_hash,role,disabled,must_change_password)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [input.id, input.username, input.passwordHash, input.role || 'USER', Boolean(input.disabled), input.mustChangePassword !== false]);
      return userRow(result.rows[0]);
    } catch (error) {
      if (error.code === '23505') { error.code = 'DUPLICATE'; error.message = '用户名已存在'; }
      throw error;
    }
  }
  async findUserByUsername(username) { return userRow((await this.pool.query('SELECT * FROM users WHERE lower(username)=lower($1)', [username])).rows[0]); }
  async findUserById(id) { return userRow((await this.pool.query('SELECT * FROM users WHERE id=$1', [id])).rows[0]); }
  async listUsers() { return (await this.pool.query('SELECT * FROM users ORDER BY username')).rows.map(userRow); }
  async updateUser(id, patch) {
    const current = await this.findUserById(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    return userRow((await this.pool.query(`UPDATE users SET password_hash=$2,role=$3,disabled=$4,must_change_password=$5,updated_at=now() WHERE id=$1 RETURNING *`,
      [id, next.passwordHash, next.role, next.disabled, next.mustChangePassword])).rows[0]);
  }

  async createSession(value) { await this.pool.query('INSERT INTO auth_sessions(hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,$4)', [value.hash, value.userId, value.csrfToken, value.expiresAt]); }
  async findSession(hash) {
    const row = (await this.pool.query(`SELECT s.hash,s.user_id,s.csrf_token,s.expires_at,u.* FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=$1 AND s.expires_at>now()`, [hash])).rows[0];
    return row ? { hash: row.hash, userId: row.user_id, csrfToken: row.csrf_token, expiresAt: row.expires_at, user: userRow(row) } : null;
  }
  async touchSession(hash, expiresAt) { await this.pool.query('UPDATE auth_sessions SET expires_at=$2 WHERE hash=$1', [hash, expiresAt]); }
  async deleteSession(hash) { await this.pool.query('DELETE FROM auth_sessions WHERE hash=$1', [hash]); }

  async createTask(task) {
    await this.pool.query('INSERT INTO tasks(id,user_id,status,data,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6)', [task.id, task.userId, task.status, task, task.createdAt, task.updatedAt]);
    return task;
  }
  async getTask(id) { return taskRow((await this.pool.query('SELECT data,status,created_at,updated_at FROM tasks WHERE id=$1', [id])).rows[0]); }
  async updateTask(id, patch) {
    const result = await this.pool.query(`UPDATE tasks SET data=data || $2::jsonb,status=COALESCE($3,status),updated_at=now() WHERE id=$1 RETURNING data,status,created_at,updated_at`, [id, JSON.stringify(patch), patch.status || null]);
    return taskRow(result.rows[0]);
  }
  async listTasksByUser(userId, limit = 100) { return (await this.pool.query('SELECT data,status,created_at,updated_at FROM tasks WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2', [userId, limit])).rows.map(taskRow); }
  async listTasksAdmin(limit = 200) { return (await this.pool.query('SELECT data,status,created_at,updated_at FROM tasks ORDER BY created_at DESC LIMIT $1', [limit])).rows.map(taskRow); }
  async listProcessableTasks() { return (await this.pool.query(`SELECT data,status,created_at,updated_at FROM tasks WHERE status=ANY($1) ORDER BY created_at`, [['LOCAL_QUEUED','PENDING','RUNNING','AUTH_REQUIRED']])).rows.map(taskRow); }
  async rebindAuthTasks(userId, sessionHash, keyFingerprint) {
    const rows = await this.pool.query(`SELECT id,data FROM tasks WHERE user_id=$1 AND status='AUTH_REQUIRED'`, [userId]);
    for (const row of rows.rows) {
      const patch = { sessionHash, keyFingerprint, status: row.data.remoteTaskId ? 'PENDING' : 'LOCAL_QUEUED' };
      await this.updateTask(row.id, patch);
    }
  }
  async markAllNonterminalAuthRequired() { await this.pool.query(`UPDATE tasks SET status='AUTH_REQUIRED',data=jsonb_set(data,'{status}','"AUTH_REQUIRED"'),updated_at=now() WHERE status=ANY($1)`, [['LOCAL_QUEUED','SUBMITTING','PENDING','RUNNING']]); }
  async deleteTasksOlderThan(cutoff) { await this.pool.query('DELETE FROM tasks WHERE created_at<$1', [cutoff]); }

  async listPricing() { return (await this.pool.query('SELECT * FROM pricing ORDER BY model,resolution')).rows.map(priceRow); }
  async getPricing(model, resolution) { return priceRow((await this.pool.query('SELECT * FROM pricing WHERE model=$1 AND resolution=$2', [model, resolution])).rows[0]); }
  async upsertPricing(input) {
    const row = (await this.pool.query(`INSERT INTO pricing(model,resolution,input_rate,output_rate,currency,version,updated_by)
      VALUES($1,$2,$3,$4,$5,1,$6) ON CONFLICT(model,resolution) DO UPDATE SET input_rate=excluded.input_rate,output_rate=excluded.output_rate,currency=excluded.currency,version=pricing.version+1,updated_by=excluded.updated_by,updated_at=now() RETURNING *`,
    [input.model, input.resolution, input.inputRate, input.outputRate, input.currency || 'CNY', input.updatedBy || null])).rows[0];
    return priceRow(row);
  }
  async getSettings() { return (await this.pool.query('SELECT data FROM app_settings WHERE id=1')).rows[0]?.data || { ...DEFAULT_SETTINGS }; }
  async updateSettings(patch) { return (await this.pool.query(`UPDATE app_settings SET data=data || $1::jsonb,updated_at=now() WHERE id=1 RETURNING data`, [JSON.stringify(patch)])).rows[0].data; }
  async createAudit(entry) { await this.pool.query('INSERT INTO audit_logs(actor_id,action,data) VALUES($1,$2,$3)', [entry.actorId || null, entry.action, entry.data || {}]); }
  async listAudits(limit = 100) { return (await this.pool.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1', [limit])).rows; }
  async dashboard() { return dashboardFromTasks((await this.listTasksAdmin(10_000))); }
}

function userRow(row) { return row ? { id: row.id, username: row.username, passwordHash: row.password_hash, role: row.role, disabled: row.disabled, mustChangePassword: row.must_change_password, createdAt: row.created_at, updatedAt: row.updated_at } : null; }
function taskRow(row) { return row ? { ...row.data, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at } : null; }
function priceRow(row) { return row ? { model: row.model, resolution: row.resolution, inputRate: Number(row.input_rate), outputRate: Number(row.output_rate), currency: row.currency, version: row.version, updatedBy: row.updated_by, updatedAt: row.updated_at } : null; }
