import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity, Check, CircleAlert, Clock3, Copy, Download, ExternalLink, Film, Gauge,
  KeyRound, LayoutDashboard, LoaderCircle, LogOut, Play, RefreshCw, Save, Settings2,
  ShieldCheck, Sparkles, UserPlus, Users, Wifi
} from 'lucide-react';
import './styles.css';

const ACTIVE_STATES = new Set(['LOCAL_QUEUED', 'SUBMITTING', 'PENDING', 'RUNNING', 'AUTH_REQUIRED']);

function App() {
  const [auth, setAuth] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { api('/api/auth/me').then(setAuth).catch(() => setAuth(null)).finally(() => setLoading(false)); }, []);
  if (loading) return <PageLoader text="正在连接部门工作台…" />;
  if (!auth) return <Login onLogin={setAuth} />;
  if (auth.user.mustChangePassword) return <ChangePassword auth={auth} onChanged={(user) => setAuth({ ...auth, user })} />;
  return <Portal auth={auth} onLogout={() => setAuth(null)} />;
}

function Login({ onLogin }) {
  const [form, setForm] = useState({ username: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event) => {
    event.preventDefault(); setBusy(true); setError('');
    try { onLogin(await api('/api/auth/login', { method: 'POST', body: form })); }
    catch (reason) { setError(reason.message); } finally { setBusy(false); }
  };
  return <div className="auth-page"><section className="auth-card">
    <div className="auth-logo"><Sparkles /> 江苏电信 TokenHub</div>
    <h1>Seedance 部门工作台</h1><p>使用管理员分配的账号登录。API Key仅保存在本次服务器会话内。</p>
    {error && <InlineError text={error} />}
    <form onSubmit={submit} className="auth-form">
      <label>用户名<input autoFocus autoComplete="username" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} /></label>
      <label>密码<input type="password" autoComplete="current-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label>
      <button className="button primary" disabled={busy}>{busy ? <LoaderCircle className="spin" /> : <ShieldCheck />} 登录</button>
    </form>
  </section></div>;
}

function ChangePassword({ auth, onChanged }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const submit = async (event) => {
    event.preventDefault(); setError('');
    try { const data = await api('/api/auth/change-password', { method: 'POST', csrf: auth.csrfToken, body: { password } }); onChanged(data.user); }
    catch (reason) { setError(reason.message); }
  };
  return <div className="auth-page"><section className="auth-card"><KeyRound size={36} />
    <h1>请修改初始密码</h1><p>新密码至少10位，并同时包含字母和数字。</p>{error && <InlineError text={error} />}
    <form onSubmit={submit} className="auth-form"><label>新密码<input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label><button className="button primary">保存新密码</button></form>
  </section></div>;
}

function Portal({ auth, onLogout }) {
  const [view, setView] = useState('studio');
  const logout = async () => { try { await api('/api/auth/logout', { method: 'POST', csrf: auth.csrfToken }); } finally { onLogout(); } };
  return <>
    <nav className="topbar"><div className="topbar-brand"><Sparkles size={18} /> Seedance 部门工作台</div><div className="topbar-actions">
      <button className={view === 'studio' ? 'active' : ''} onClick={() => setView('studio')}><Film size={16} /> 视频生成</button>
      {auth.user.role === 'ADMIN' && <button className={view === 'admin' ? 'active' : ''} onClick={() => setView('admin')}><LayoutDashboard size={16} /> 管理后台</button>}
      <span className="user-pill">{auth.user.username} · {auth.user.role}</span><button onClick={logout}><LogOut size={16} /> 退出</button>
    </div></nav>
    {view === 'admin' ? <AdminPanel auth={auth} /> : <Studio auth={auth} />}
  </>;
}

function Studio({ auth }) {
  const [config, setConfig] = useState({ url: 'https://aigw.telecomjs.com/v1/videos/generations', apiKey: '', model: '' });
  const [models, setModels] = useState([]);
  const [configured, setConfigured] = useState(false);
  const [maskedKey, setMaskedKey] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [notice, setNotice] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({ prompt: '', resolution: '720p', ratio: '16:9', duration: 5, generateAudio: false, watermark: false });
  const lastDiscovery = useRef('');

  const refreshTasks = useCallback(async () => {
    try { const data = await api('/api/video/tasks'); setTasks(data.tasks); }
    catch (error) { if (error.status !== 401) setNotice({ type: 'error', text: error.message }); }
  }, []);

  useEffect(() => {
    Promise.all([api('/api/config'), api('/api/video/tasks')]).then(([saved, taskData]) => {
      setTasks(taskData.tasks);
      if (saved.configured) {
        setConfigured(true); setMaskedKey(saved.config.apiKeyMasked); setModels(saved.config.models || []);
        setConfig((current) => ({ ...current, url: saved.config.submitUrl, model: saved.config.model }));
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!tasks.some((task) => ACTIVE_STATES.has(task.status))) return undefined;
    const timer = window.setInterval(refreshTasks, 5000);
    return () => window.clearInterval(timer);
  }, [tasks, refreshTasks]);

  const discover = useCallback(async (automatic = false) => {
    const signature = `${config.url}|${config.apiKey}`;
    if (!config.apiKey || config.apiKey.length < 8 || !isHttpUrl(config.url) || (automatic && signature === lastDiscovery.current)) return;
    lastDiscovery.current = signature; setDiscovering(true); setNotice(null);
    try {
      const data = await api('/api/config/discover', { method: 'POST', csrf: auth.csrfToken, body: { url: config.url, apiKey: config.apiKey } });
      setConfigured(true); setMaskedKey(data.config.apiKeyMasked); setModels(data.models); setConfig((current) => ({ ...current, apiKey: '', url: data.config.submitUrl, model: data.config.model }));
      const selected = data.models.find((item) => item.id === data.config.model) || data.models[0];
      setForm((current) => ({ ...current, resolution: selected.defaultResolution }));
      setNotice({ type: 'success', text: `连接成功，发现 ${data.models.length} 个可用 Seedance 模型。` });
    } catch (error) { setNotice({ type: 'error', text: error.message }); }
    finally { setDiscovering(false); }
  }, [auth.csrfToken, config.apiKey, config.url]);

  useEffect(() => {
    if (!config.apiKey) return undefined;
    const timer = window.setTimeout(() => discover(true), 800);
    return () => window.clearTimeout(timer);
  }, [config.apiKey, config.url, discover]);

  const selectModel = async (model) => {
    const descriptor = models.find((item) => item.id === model);
    setConfig((current) => ({ ...current, model }));
    if (descriptor) setForm((current) => ({ ...current, resolution: descriptor.defaultResolution }));
    try { await api('/api/config/model', { method: 'PUT', csrf: auth.csrfToken, body: { model } }); }
    catch (error) { setNotice({ type: 'error', text: error.message }); }
  };

  const submit = async (event) => {
    event.preventDefault(); setSubmitting(true); setNotice(null);
    try {
      const data = await api('/api/video/tasks', { method: 'POST', csrf: auth.csrfToken, body: { ...form, model: config.model } });
      setTasks((current) => [data.task, ...current]);
      setForm((current) => ({ ...current, prompt: '' }));
      setNotice({ type: 'success', text: `任务已进入队列，当前位置约为 ${data.queuePosition}。页面关闭后后台仍会继续处理。` });
    } catch (error) { setNotice({ type: 'error', text: error.message }); }
    finally { setSubmitting(false); }
  };

  const descriptor = models.find((item) => item.id === config.model);
  return <main>
    <header className="hero compact-hero"><div className="brand"><Sparkles size={18} /> 江苏电信 TokenHub</div><div className="hero-copy"><span className="eyebrow">SEEDANCE VIDEO STUDIO</span><h1>把一句想法，变成一段画面。</h1><p>账号隔离、后台排队、自动轮询，并按 TokenHub真实用量核算费用。</p></div><div className={`connection ${configured ? 'online' : ''}`}><span className="connection-dot" />{configured ? `已连接 · ${maskedKey}` : '等待配置'}</div></header>
    {notice && <Notice notice={notice} onClose={() => setNotice(null)} />}
    <section className="settings card"><div className="settings-body always-open">
      <div className="field span-2"><label>文生视频 URL</label><div className="input-icon"><Wifi size={17} /><input type="url" value={config.url} onChange={(event) => setConfig({ ...config, url: event.target.value })} /></div></div>
      <div className="field"><label>API Key</label><div className="input-icon"><KeyRound size={17} /><input type="password" autoComplete="off" placeholder={configured ? `${maskedKey}（重新填写可更换）` : '停止输入800毫秒后自动检测'} value={config.apiKey} onChange={(event) => setConfig({ ...config, apiKey: event.target.value })} /></div><small>仅保存在服务器内存，不写入数据库或浏览器</small></div>
      <div className="field"><label>Seedance 模型名称</label><select value={config.model} disabled={!models.length} onChange={(event) => selectModel(event.target.value)}>{!models.length && <option value="">填写 Key 后自动发现</option>}{models.map((model) => <option key={model.id} value={model.id}>{model.label} · {model.id}</option>)}</select></div>
      <div className="settings-actions span-2"><button className="button secondary" disabled={discovering || !config.apiKey} onClick={() => discover(false)}>{discovering ? <LoaderCircle className="spin" /> : <RefreshCw />} 重新检测模型</button></div>
    </div></section>
    <div className="workspace">
      <section className="composer card"><div className="section-heading"><div><span className="step">01</span><h2>描述你想看到的画面</h2></div><span className="model-chip">{descriptor?.label || '未选择模型'}</span></div>
        <form onSubmit={submit}><div className="prompt-wrap"><textarea required maxLength={5000} value={form.prompt} onChange={(event) => setForm({ ...form, prompt: event.target.value })} placeholder="例如：清晨的南京长江大桥笼罩在薄雾中，镜头沿江面缓慢向前推进，电影感……" /><span className="char-count">{form.prompt.length} / 5000</span></div>
          <div className="parameter-grid"><label>分辨率<select value={form.resolution} onChange={(event) => setForm({ ...form, resolution: event.target.value })}>{(descriptor?.resolutions || ['720p']).map((value) => <option key={value} value={value}>{value.toUpperCase()}</option>)}</select></label>
            <label>画面比例<select value={form.ratio} onChange={(event) => setForm({ ...form, ratio: event.target.value })}>{['16:9','9:16','1:1','4:3','3:4','21:9'].map((value) => <option key={value}>{value}</option>)}</select></label>
            <label>时长（秒）<input type="number" min="4" max="15" value={form.duration} onChange={(event) => setForm({ ...form, duration: Number(event.target.value) })} /></label>
            <Toggle label="生成音频" value={form.generateAudio} onChange={(value) => setForm({ ...form, generateAudio: value })} />
            <Toggle label="添加水印" value={form.watermark} onChange={(value) => setForm({ ...form, watermark: value })} />
          </div><p className="model-hint">{descriptor ? `${descriptor.label} 支持 ${descriptor.resolutions.join(' / ')}、4–15秒。` : '请先配置并选择模型。'}</p>
          <button className="generate" disabled={submitting || !configured || !descriptor}>{submitting ? <LoaderCircle className="spin" /> : <Play fill="currentColor" />} {submitting ? '正在入队…' : '开始生成视频'}</button><p className="cost-hint">提交会产生真实模型调用费用；排队任务由服务器统一控制并发。</p>
        </form></section>
      <section className="results card"><div className="section-heading"><div><span className="step">02</span><h2>我的任务</h2></div><button className="icon-button" onClick={refreshTasks}><RefreshCw size={16} /></button></div>{tasks.length ? <div className="task-list">{tasks.map((task) => <TaskCard key={task.id} task={task} />)}</div> : <EmptyResult />}</section>
    </div><footer>API Key不落盘 · 任务记录保留90天 · 视频链接通常仅有效24小时</footer>
  </main>;
}

function AdminPanel({ auth }) {
  const [data, setData] = useState({ users: [], pricing: [], settings: {}, tasks: [], dashboard: {} });
  const [notice, setNotice] = useState(null);
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'USER' });
  const load = useCallback(async () => {
    try {
      const [users, pricing, settings, tasks, dashboard] = await Promise.all(['/api/admin/users','/api/admin/pricing','/api/admin/settings','/api/admin/tasks','/api/admin/dashboard'].map((url) => api(url)));
      setData({ users: users.users, pricing: pricing.pricing, settings: settings.settings, tasks: tasks.tasks, dashboard: dashboard.dashboard });
    } catch (error) { setNotice({ type: 'error', text: error.message }); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const createUser = async (event) => { event.preventDefault(); try { await api('/api/admin/users', { method: 'POST', csrf: auth.csrfToken, body: newUser }); setNewUser({ username: '', password: '', role: 'USER' }); setNotice({ type: 'success', text: '账号已创建，首次登录将要求修改密码。' }); load(); } catch (error) { setNotice({ type: 'error', text: error.message }); } };
  const updateUser = async (id, patch) => { try { await api(`/api/admin/users/${id}`, { method: 'PATCH', csrf: auth.csrfToken, body: patch }); load(); } catch (error) { setNotice({ type: 'error', text: error.message }); } };
  return <main className="admin-main"><header className="admin-heading"><div><span className="eyebrow">ADMIN CONSOLE</span><h1>部门使用与费用管理</h1><p>管理员只能查看任务元数据，无法读取同事的完整提示词和视频地址。</p></div><button className="button secondary" onClick={load}><RefreshCw /> 刷新</button></header>{notice && <Notice notice={notice} onClose={() => setNotice(null)} />}
    <DashboardCards dashboard={data.dashboard} />
    <section className="admin-grid"><div className="card admin-card"><div className="section-heading"><div><Users /><h2>账号管理</h2></div></div><form className="inline-form" onSubmit={createUser}><input placeholder="用户名" value={newUser.username} onChange={(event) => setNewUser({ ...newUser, username: event.target.value })} /><input type="password" placeholder="临时密码" value={newUser.password} onChange={(event) => setNewUser({ ...newUser, password: event.target.value })} /><select value={newUser.role} onChange={(event) => setNewUser({ ...newUser, role: event.target.value })}><option>USER</option><option>ADMIN</option></select><button className="button primary"><UserPlus /> 新建</button></form><div className="table-wrap"><table><thead><tr><th>账号</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>{data.users.map((user) => <tr key={user.id}><td>{user.username}</td><td>{user.role}</td><td>{user.disabled ? '已禁用' : user.mustChangePassword ? '待改密码' : '正常'}</td><td><button disabled={user.id === auth.user.id} onClick={() => updateUser(user.id, { disabled: !user.disabled })}>{user.disabled ? '启用' : '禁用'}</button></td></tr>)}</tbody></table></div></div>
      <PricingCard pricing={data.pricing} auth={auth} onSaved={load} onError={(text) => setNotice({ type: 'error', text })} />
    </section>
    <SettingsCard settings={data.settings} auth={auth} onSaved={load} />
    <section className="card admin-card"><div className="section-heading"><div><Activity /><h2>最近任务（已脱敏）</h2></div></div><div className="table-wrap"><table><thead><tr><th>时间</th><th>用户ID</th><th>模型</th><th>分辨率</th><th>状态</th><th>Token</th><th>费用</th></tr></thead><tbody>{data.tasks.map((task) => <tr key={task.id}><td>{formatDate(task.createdAt, true)}</td><td className="mono">{task.userId.slice(0, 8)}</td><td>{shortModel(task.model)}</td><td>{task.resolution}</td><td>{statusText(task.status)}</td><td>{task.cost?.totalTokens ?? '—'}</td><td>{task.cost ? `¥${task.cost.totalCost.toFixed(4)}` : '—'}</td></tr>)}</tbody></table></div></section>
  </main>;
}

function PricingCard({ pricing, auth, onSaved, onError }) {
  const [rows, setRows] = useState(pricing);
  useEffect(() => setRows(pricing), [pricing]);
  const save = async (row) => { try { await api('/api/admin/pricing', { method: 'PUT', csrf: auth.csrfToken, body: row }); onSaved(); } catch (error) { onError(error.message); } };
  const change = (index, field, value) => setRows((current) => current.map((row, idx) => idx === index ? { ...row, [field]: Number(value) } : row));
  return <div className="card admin-card"><div className="section-heading"><div><Gauge /><h2>Token单价</h2></div></div><div className="table-wrap"><table><thead><tr><th>模型</th><th>分辨率</th><th>输入/百万</th><th>输出/百万</th><th></th></tr></thead><tbody>{rows.map((row, index) => <tr key={`${row.model}-${row.resolution}`}><td>{shortModel(row.model)}</td><td>{row.resolution}</td><td><input type="number" min="0" step="0.01" value={row.inputRate} onChange={(event) => change(index, 'inputRate', event.target.value)} /></td><td><input type="number" min="0" step="0.01" value={row.outputRate} onChange={(event) => change(index, 'outputRate', event.target.value)} /></td><td><button onClick={() => save(row)}><Save size={15} /></button></td></tr>)}</tbody></table></div></div>;
}

function SettingsCard({ settings, auth, onSaved }) {
  const [form, setForm] = useState(settings);
  useEffect(() => setForm(settings), [settings]);
  const fields = [['globalActiveLimit','全局活跃'],['perUserActiveLimit','每人活跃'],['perUserQueueLimit','每人排队'],['perKeyActiveLimit','同Key活跃'],['globalQueueLimit','全局排队']];
  const save = async () => { await api('/api/admin/settings', { method: 'PUT', csrf: auth.csrfToken, body: form }); onSaved(); };
  return <section className="card admin-card"><div className="section-heading"><div><Settings2 /><h2>并发与队列</h2></div><button className="button primary compact" onClick={save}><Save /> 保存</button></div><div className="settings-row">{fields.map(([key,label]) => <label key={key}>{label}<input type="number" min="1" value={form[key] || ''} onChange={(event) => setForm({ ...form, [key]: Number(event.target.value) })} /></label>)}</div></section>;
}

function DashboardCards({ dashboard }) { const cards = [[Activity,'活跃任务',dashboard.active],[Clock3,'排队任务',dashboard.queued],[Check,'成功任务',dashboard.succeeded],[Gauge,'累计费用',`¥${Number(dashboard.totalCost || 0).toFixed(4)}`]]; return <div className="metrics">{cards.map(([Icon,label,value]) => <div className="metric" key={label}><Icon /><div><span>{label}</span><strong>{value ?? 0}</strong></div></div>)}</div>; }
function TaskCard({ task }) { const active = ACTIVE_STATES.has(task.status); return <article className={`task ${task.status.toLowerCase()}`}><div className="task-top"><div className="task-status">{active ? <LoaderCircle className="spin" /> : task.status === 'SUCCEEDED' ? <Check /> : <CircleAlert />} {statusText(task.status)}</div><span className="model-chip">{task.resolution?.toUpperCase()}</span></div>{task.videoUrl && <div className="video-wrap"><video src={task.videoUrl} controls preload="metadata" /></div>}<p className="task-prompt">{task.prompt}</p><div className="task-meta"><span><Clock3 /> {formatDate(task.createdAt)}</span><span>{shortModel(task.model)}</span></div>{task.message && ['FAILED','UNKNOWN'].includes(task.status) && <div className="task-error">{task.message}</div>}{task.cost ? <div className="usage-box"><span>输入 {task.cost.promptTokens}</span><span>输出 {task.cost.completionTokens}</span><strong>¥{task.cost.totalCost.toFixed(4)}</strong></div> : task.status === 'SUCCEEDED' && <div className="usage-box muted">TokenHub未返回用量，无法精确计费</div>}{task.videoUrl && <div className="video-actions"><button onClick={() => navigator.clipboard.writeText(task.videoUrl)}><Copy />复制链接</button><a href={task.videoUrl} target="_blank" rel="noreferrer"><ExternalLink />打开</a><a href={task.videoUrl} download><Download />下载</a></div>}<div className="task-id">本地任务：{task.id}{task.remoteTaskId ? ` · 远端：${task.remoteTaskId}` : ''}</div></article>; }
function Toggle({ label, value, onChange }) { return <label className="switch-label"><span>{label}</span><button type="button" className={`switch ${value ? 'on' : ''}`} onClick={() => onChange(!value)}><span /></button></label>; }
function EmptyResult() { return <div className="empty-result"><div className="film-icon"><Film /></div><h3>视频将在这里出现</h3><p>提交后可以关闭页面，服务器会继续排队和查询。</p></div>; }
function Notice({ notice, onClose }) { return <div className={`notice ${notice.type}`}>{notice.type === 'success' ? <Check /> : <CircleAlert />}<span>{notice.text}</span><button onClick={onClose}>×</button></div>; }
function InlineError({ text }) { return <div className="inline-error"><CircleAlert />{text}</div>; }
function PageLoader({ text }) { return <div className="page-loader"><LoaderCircle className="spin" /><span>{text}</span></div>; }

async function api(url, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.csrf ? { 'X-CSRF-Token': options.csrf } : {}), ...(options.headers || {}) };
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data?.error?.message || `请求失败（${response.status}）`); error.status = response.status; error.code = data?.error?.code; throw error; }
  return data;
}
function isHttpUrl(value) { try { return ['http:','https:'].includes(new URL(value).protocol); } catch { return false; } }
function shortModel(value = '') { return value.replace('doubao-seedance-2-0-', '').replace('-260128','').replace('-260615','') || '—'; }
function statusText(value) { return { LOCAL_QUEUED:'本地排队',SUBMITTING:'正在提交',PENDING:'远端排队',RUNNING:'生成中',AUTH_REQUIRED:'等待重新填写API Key',SUCCEEDED:'已完成',FAILED:'失败',UNKNOWN:'状态待核对' }[value] || value; }
function formatDate(value, date = false) { return value ? new Intl.DateTimeFormat('zh-CN', date ? { month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit' } : { hour:'2-digit',minute:'2-digit' }).format(new Date(value)) : '—'; }

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
