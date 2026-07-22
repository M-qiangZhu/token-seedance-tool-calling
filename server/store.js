import crypto from 'node:crypto';
import { DEFAULT_PRICES } from './models.js';

export const DEFAULT_SETTINGS = Object.freeze({
  globalActiveLimit: 20,
  perUserActiveLimit: 2,
  perUserQueueLimit: 5,
  perKeyActiveLimit: 5,
  globalQueueLimit: 100,
  pollIntervalMs: 10_000,
  taskTimeoutMs: 60 * 60 * 1000
});

export class MemoryStore {
  constructor() {
    this.users = new Map();
    this.sessions = new Map();
    this.tasks = new Map();
    this.prices = new Map(DEFAULT_PRICES.map((item) => [priceKey(item.model, item.resolution), { ...item, updatedAt: now() }]));
    this.settings = { ...DEFAULT_SETTINGS };
    this.audits = [];
  }

  async init() {}
  async close() {}
  async countUsers() { return this.users.size; }
  async createUser(input) {
    if ([...this.users.values()].some((user) => user.username.toLowerCase() === input.username.toLowerCase())) {
      throw duplicateError('用户名已存在');
    }
    const user = { id: input.id || crypto.randomUUID(), role: 'USER', disabled: false, mustChangePassword: true, discountRate: 1, createdAt: now(), ...input };
    this.users.set(user.id, user);
    return { ...user };
  }
  async findUserByUsername(username) { return clone([...this.users.values()].find((user) => user.username.toLowerCase() === String(username).toLowerCase()) || null); }
  async findUserById(id) { return clone(this.users.get(id) || null); }
  async listUsers() { return [...this.users.values()].map(clone).sort((a, b) => a.username.localeCompare(b.username)); }
  async updateUser(id, patch) {
    const current = this.users.get(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: now() };
    this.users.set(id, next);
    return clone(next);
  }

  async createSession(session) { this.sessions.set(session.hash, { ...session }); }
  async findSession(hash) {
    const session = this.sessions.get(hash);
    if (!session || new Date(session.expiresAt).getTime() <= Date.now()) return null;
    const user = this.users.get(session.userId);
    return user ? { ...clone(session), user: clone(user) } : null;
  }
  async touchSession(hash, expiresAt) { const value = this.sessions.get(hash); if (value) value.expiresAt = expiresAt; }
  async deleteSession(hash) { this.sessions.delete(hash); }

  async createTask(task) { this.tasks.set(task.id, clone(task)); return clone(task); }
  async getTask(id) { return clone(this.tasks.get(id) || null); }
  async updateTask(id, patch) {
    const current = this.tasks.get(id);
    if (!current) return null;
    const next = { ...current, ...clone(patch), updatedAt: now() };
    this.tasks.set(id, next);
    return clone(next);
  }
  async listTasksByUser(userId, limit = 100) { return this.#visibleTasks().filter((task) => task.userId === userId).slice(0, limit); }
  async listTasksAdmin(limit = 200) {
    return this.#visibleTasks().slice(0, limit).map((task) => ({ ...task, username: this.users.get(task.userId)?.username || null }));
  }
  async listProcessableTasks() { return this.#visibleTasks(false).filter((task) => ['LOCAL_QUEUED', 'PENDING', 'RUNNING', 'AUTH_REQUIRED'].includes(task.status)); }
  async resumeAuthTasks(userId, keyFingerprint) {
    let resumed = 0;
    for (const task of this.tasks.values()) {
      if (task.userId === userId && task.status === 'AUTH_REQUIRED' && task.keyFingerprint === keyFingerprint) {
        task.status = task.remoteTaskId ? 'PENDING' : 'LOCAL_QUEUED';
        task.message = null;
        task.updatedAt = now();
        resumed += 1;
      }
    }
    return resumed;
  }
  async markAllNonterminalAuthRequired() {
    for (const task of this.tasks.values()) {
      if (['LOCAL_QUEUED', 'SUBMITTING', 'PENDING', 'RUNNING'].includes(task.status)) task.status = 'AUTH_REQUIRED';
    }
  }
  async deleteTasksOlderThan(cutoff) {
    const time = new Date(cutoff).getTime();
    for (const [id, task] of this.tasks) if (new Date(task.createdAt).getTime() < time) this.tasks.delete(id);
  }

  async listPricing() { return [...this.prices.values()].map(clone).sort((a, b) => `${a.model}:${a.resolution}`.localeCompare(`${b.model}:${b.resolution}`)); }
  async getPricing(model, resolution) { return clone(this.prices.get(priceKey(model, resolution)) || null); }
  async upsertPricing(input) {
    const key = priceKey(input.model, input.resolution);
    const current = this.prices.get(key);
    const next = { ...current, ...input, version: (current?.version || 0) + 1, updatedAt: now() };
    this.prices.set(key, next);
    return clone(next);
  }
  async getSettings() { return clone(this.settings); }
  async updateSettings(patch) { this.settings = { ...this.settings, ...patch }; return clone(this.settings); }
  async createAudit(entry) { this.audits.unshift({ id: crypto.randomUUID(), createdAt: now(), ...clone(entry) }); }
  async listAudits(limit = 100) { return this.audits.slice(0, limit).map(clone); }
  async dashboard() { return dashboardFromTasks(this.#visibleTasks(false)); }

  #visibleTasks(desc = true) { return this.#tasks(desc).filter((task) => !task.deletedAt); }

  #tasks(desc = true) {
    return [...this.tasks.values()].map(clone).sort((a, b) => desc
      ? new Date(b.createdAt) - new Date(a.createdAt)
      : new Date(a.createdAt) - new Date(b.createdAt));
  }
}

export function dashboardFromTasks(tasks) {
  const result = { total: tasks.length, active: 0, queued: 0, succeeded: 0, failed: 0, unknown: 0, totalTokens: 0, totalCost: 0 };
  for (const task of tasks) {
    if (['PENDING', 'RUNNING', 'AUTH_REQUIRED'].includes(task.status) && task.remoteTaskId) result.active += 1;
    if (['LOCAL_QUEUED', 'AUTH_REQUIRED'].includes(task.status) && !task.remoteTaskId) result.queued += 1;
    if (task.status === 'SUCCEEDED') result.succeeded += 1;
    if (task.status === 'FAILED') result.failed += 1;
    if (task.status === 'UNKNOWN') result.unknown += 1;
    result.totalTokens += Number(task.cost?.totalTokens || 0);
    result.totalCost += Number(task.cost?.totalCost || 0);
  }
  result.totalCost = Number(result.totalCost.toFixed(6));
  return result;
}

export function publicUser(user) {
  if (!user) return null;
  const { passwordHash: _passwordHash, ...safe } = user;
  return safe;
}

export function priceKey(model, resolution) { return `${model}::${String(resolution).toLowerCase()}`; }
function now() { return new Date().toISOString(); }
function clone(value) { return value === null || value === undefined ? value : structuredClone(value); }
function duplicateError(message) { const error = new Error(message); error.code = 'DUPLICATE'; return error; }
