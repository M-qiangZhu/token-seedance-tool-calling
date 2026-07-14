import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity, AlertTriangle, Check, CircleAlert, Clock3, Copy, Download, ExternalLink, Film, Gauge,
  KeyRound, LayoutDashboard, LoaderCircle, LogOut, Play, RefreshCw, Save, Settings2,
  ShieldCheck, Sparkles, Trash2, UserPlus, Users, Wifi, X
} from 'lucide-react';
import './styles.css';

const ACTIVE_STATES = new Set(['LOCAL_QUEUED', 'SUBMITTING', 'PENDING', 'RUNNING', 'AUTH_REQUIRED']);
const PROMPT_PRESETS = [
  {
    category: '自然风景治愈风',
    prompts: [
      '清晨山间云雾缓缓流动，晨光穿透林海，微风拂动青草，山谷静谧空灵，全景慢推镜头，高清写实画质',
      '海边落日余晖洒满海面，层层海浪温柔拍打沙滩，晚风卷起细碎浪花，暖色调氛围感，动态柔和慢镜头',
      '秋日森林漫山红叶飘落，林间光影斑驳，溪流缓缓流淌，落叶随水飘动，沉浸式自然治愈画面，长焦柔和运镜',
      '星空旷野草地，漫天星河缓慢流转，晚风拂动萤火飞舞，夜空澄澈通透，极简治愈，全景延时动态',
      '春日烟雨江南，薄雾笼罩水乡，河面泛起涟漪，垂柳随风轻摆，古风诗意风景，柔和朦胧动态效果'
    ]
  },
  {
    category: '治愈短剧情风',
    prompts: [
      '傍晚街头，少年骑着单车穿行晚风里，街边路灯次第亮起，晚霞铺满天空，温柔治愈青春氛围感，动态跟随镜头',
      '窗边少女静坐看书，阳光透过玻璃窗洒落，光影缓缓移动，微风吹动窗帘，安静温柔的治愈日常，慢节奏特写',
      '雨天街头，行人撑伞缓步走过，雨水打湿路面倒映霓虹灯光，城市温柔氛围感，沉浸式雨天动态画面',
      '秋日午后，猫咪蜷在窗台晒太阳，轻轻伸懒腰，落叶随风落在窗边，慵懒松弛的生活瞬间，近距离动态抓拍',
      '深夜书桌前，暖黄台灯亮起，指尖轻翻书页，窗外月色皎洁，安静治愈的独处时刻，氛围感沉浸式镜头'
    ]
  },
  {
    category: '太空科幻风',
    prompts: [
      '浩瀚深邃宇宙，璀璨星云缓缓流动旋转，星际粒子漫天飘散，宇宙飞船缓缓穿梭星云之间，宏大科幻全景，超高清动态',
      '月球表面全景视角，俯瞰蓝色地球悬浮太空，星空静谧闪烁，宇宙尘埃缓缓浮动，极简高级太空氛围感，慢推运镜',
      '未来星际空间站漂浮宇宙，机甲飞行器快速穿梭，灯光霓虹闪烁，星际光束划过夜空，赛博科幻动态镜头',
      '黑洞视界动态特效，时空扭曲流转，星河被引力缓缓吞噬，粒子爆发闪烁，极致炫酷科幻画面，沉浸式动态流转',
      '火星荒芜地貌，红色戈壁绵延无尽，漫天橘红色沙尘缓缓飘动，远处星河浮现，孤寂宏大的星际风景'
    ]
  },
  {
    category: '游戏氛围感风',
    prompts: [
      '古风仙侠场景，白衣剑客立于云海之巅，长风猎猎，衣袂翻飞，拔剑释放流光剑气，全屏光影特效，流畅动态动作',
      '赛博朋克都市，雨夜霓虹闪烁，光影交错，游戏角色穿梭街头，身法飘逸，残影流动，未来都市战斗氛围感',
      '魔幻秘境场景，悬浮岛屿云雾缭绕，七彩流光漫天飞舞，魔法能量汇聚涌动，秘境光影动态，沉浸式游戏场景',
      '末世废土风格，残破城市废墟，风沙漫天，战士持枪缓步前行，逆光剪影，氛围感拉满，硬核游戏动态镜头',
      '二次元竞速场景，科幻赛车穿梭光影赛道，拖尾流光绚烂夺目，速度感拉满，流畅高速动态画面'
    ]
  },
  {
    category: '漫画二次元风',
    prompts: [
      '日系清新漫画画风，夏日JK少女站在樱花树下，漫天樱花缓缓飘落，微风拂动发丝，清新治愈二次元动态',
      '热血少年漫画风格，少年迎风奔跑，发丝飞扬，衣角飘动，逆光光影柔和，青春热血动感分镜画面',
      '治愈二次元夜景，城市街头灯火璀璨，少女漫步街头，晚风裹挟星光，画面温柔清新，低饱和漫画质感',
      '古风二次元漫画，古装美人撑伞走在烟雨巷中，薄雾朦胧，衣角随风轻摆，诗意唯美动态画面',
      '赛博二次元少女，立于霓虹街头，光影在眼底流动，发丝自带流光特效，炫酷温柔兼具，漫画动态特写'
    ]
  }
];

function App() {
  const [auth, setAuth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const notify = useCallback((notice) => setToast({ ...notice, id: `${Date.now()}-${Math.random()}` }), []);
  useEffect(() => { api('/api/auth/me').then(setAuth).catch(() => setAuth(null)).finally(() => setLoading(false)); }, []);
  let content;
  if (loading) content = <PageLoader text="正在连接部门工作台…" />;
  else if (!auth) content = <Login onLogin={setAuth} />;
  else if (auth.user.mustChangePassword) content = <ChangePassword auth={auth} onChanged={(user) => setAuth({ ...auth, user })} />;
  else content = <Portal auth={auth} onLogout={() => setAuth(null)} notify={notify} />;
  return <><Toast toast={toast} onClose={() => setToast(null)} />{content}</>;
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
    <div className="auth-logo"><Sparkles /> 南通电信智云中心 seedance API Tools</div>
    <h1>Seedance 工作台</h1><p>使用管理员分配的账号登录。API Key仅保存在本次服务器会话内。</p>
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

function Portal({ auth, onLogout, notify }) {
  const [view, setView] = useState('studio');
  const logout = async () => { try { await api('/api/auth/logout', { method: 'POST', csrf: auth.csrfToken }); } finally { onLogout(); } };
  return <>
    <nav className="topbar"><div className="topbar-brand"><Sparkles size={18} /> 南通电信智云中心 seedance API Tools</div><div className="topbar-actions">
      <button className={view === 'studio' ? 'active' : ''} onClick={() => setView('studio')}><Film size={16} /> 视频生成</button>
      {auth.user.role === 'ADMIN' && <button className={view === 'admin' ? 'active' : ''} onClick={() => setView('admin')}><LayoutDashboard size={16} /> 管理后台</button>}
      <span className="user-pill">{auth.user.username} · {auth.user.role}</span><button onClick={logout}><LogOut size={16} /> 退出</button>
    </div></nav>
    {view === 'admin' ? <AdminPanel auth={auth} notify={notify} /> : <Studio auth={auth} notify={notify} />}
  </>;
}

function Studio({ auth, notify }) {
  const [config, setConfig] = useState({ url: 'https://aigw.telecomjs.com/v1/videos/generations', apiKey: '', model: '' });
  const [models, setModels] = useState([]);
  const [configured, setConfigured] = useState(false);
  const [maskedKey, setMaskedKey] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [taskAction, setTaskAction] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const [form, setForm] = useState({ prompt: '', resolution: '720p', ratio: '16:9', duration: 5, generateAudio: false, watermark: false });
  const [presetCategory, setPresetCategory] = useState(PROMPT_PRESETS[0].category);
  const lastDiscovery = useRef('');

  const refreshTasks = useCallback(async () => {
    try { const data = await api('/api/video/tasks'); setTasks(data.tasks); }
    catch (error) { if (error.status !== 401) notify({ type: 'error', text: error.message }); }
  }, [notify]);

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
    lastDiscovery.current = signature; setDiscovering(true);
    try {
      const data = await api('/api/config/discover', { method: 'POST', csrf: auth.csrfToken, body: { url: config.url, apiKey: config.apiKey } });
      setConfigured(true); setMaskedKey(data.config.apiKeyMasked); setModels(data.models); setConfig((current) => ({ ...current, apiKey: '', url: data.config.submitUrl, model: data.config.model }));
      const selected = data.models.find((item) => item.id === data.config.model) || data.models[0];
      setForm((current) => ({ ...current, resolution: selected.defaultResolution }));
      const resumed = Number(data.resumedTaskCount || 0);
      notify({ type: 'success', text: `连接成功，发现 ${data.models.length} 个可用 Seedance 模型。${resumed ? `已恢复 ${resumed} 个待处理任务。` : ''}` });
    } catch (error) { notify({ type: 'error', text: error.message }); }
    finally { setDiscovering(false); }
  }, [auth.csrfToken, config.apiKey, config.url, notify]);

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
    catch (error) { notify({ type: 'error', text: error.message }); }
  };

  const submit = async (event) => {
    event.preventDefault(); setSubmitting(true);
    try {
      const data = await api('/api/video/tasks', { method: 'POST', csrf: auth.csrfToken, body: { ...form, model: config.model } });
      setTasks((current) => [data.task, ...current]);
      setForm((current) => ({ ...current, prompt: '' }));
      notify({ type: 'success', text: `任务已进入队列，当前位置约为 ${data.queuePosition}。页面关闭后后台仍会继续处理。` });
    } catch (error) { notify({ type: 'error', text: error.message }); }
    finally { setSubmitting(false); }
  };

  const runTaskAction = async (task, action) => {
    const key = `${task.id}:${action}`;
    setTaskAction(key);
    try {
      if (action === 'retry-query') {
        const data = await api(`/api/video/tasks/${task.id}/retry-query`, { method: 'POST', csrf: auth.csrfToken });
        setTasks((current) => current.map((item) => item.id === task.id ? data.task : item));
        notify({ type: 'success', text: '已重新查询原远端任务，不会创建新任务或产生新的生成费用。' });
      } else if (action === 'regenerate') {
        const data = await api(`/api/video/tasks/${task.id}/regenerate`, { method: 'POST', csrf: auth.csrfToken });
        setTasks((current) => [data.task, ...current]);
        notify({ type: 'warning', text: `已创建新的生成任务，队列位置约为 ${data.queuePosition}，本次调用将按当前价格计费。` });
      } else {
        await api(`/api/video/tasks/${task.id}`, { method: 'DELETE', csrf: auth.csrfToken });
        setTasks((current) => current.filter((item) => item.id !== task.id));
        notify({ type: 'success', text: '任务已从列表移除，本地将不再跟踪该任务。' });
      }
    } catch (error) { notify({ type: 'error', text: error.message }); }
    finally { setTaskAction(null); setConfirmation(null); }
  };

  const requestRegenerate = (task) => setConfirmation({
    task, action: 'regenerate', title: '确认重新生成', confirmLabel: '创建新任务',
    type: task.status === 'UNKNOWN' ? 'warning' : 'info',
    text: task.status === 'UNKNOWN'
      ? '原远端任务状态仍不明确，可能仍在运行。重新生成会创建新的远端调用，可能出现重复视频和重复计费。'
      : '将使用当前 API Key、当前单价和折扣率创建一个新任务，原失败任务会保留。'
  });
  const requestDelete = (task) => setConfirmation({
    task, action: 'delete', title: '确认移除任务', confirmLabel: '移除任务', type: 'warning',
    text: task.remoteTaskId ? '移除只会停止本地跟踪并隐藏记录，不会取消 TokenHub 上的远端任务。' : '任务将从列表和统计中隐藏，审计记录仍会保留。'
  });

  const descriptor = models.find((item) => item.id === config.model);
  const activePreset = PROMPT_PRESETS.find((item) => item.category === presetCategory) || PROMPT_PRESETS[0];
  const latestTask = tasks[0];
  const historyTasks = tasks.slice(1);
  return <main>
    <header className="hero compact-hero"><div className="brand"><Sparkles size={18} /> 南通电信智云中心 seedance API Tools</div><div className="hero-copy"><span className="eyebrow"><span>Tokenhub — </span><strong>SEEDANCE VIDEO STUDIO</strong></span><h1>把一句想法，变成一段画面。</h1><p>账号隔离、后台排队、自动轮询，并按 TokenHub真实用量核算费用。</p></div><div className={`connection ${configured ? 'online' : ''}`}><span className="connection-dot" />{configured ? `已连接 · ${maskedKey}` : '等待配置'}</div></header>
    <section className="settings card"><div className="settings-body always-open">
      <div className="field span-2"><label>文生视频 URL</label><div className="input-icon"><Wifi size={17} /><input type="url" value={config.url} onChange={(event) => setConfig({ ...config, url: event.target.value })} /></div></div>
      <div className="field"><label>API Key</label><div className="input-icon"><KeyRound size={17} /><input type="password" autoComplete="off" placeholder={configured ? `${maskedKey}（重新填写可更换）` : '停止输入800毫秒后自动检测'} value={config.apiKey} onChange={(event) => setConfig({ ...config, apiKey: event.target.value })} /></div><small>仅保存在服务器内存，不写入数据库或浏览器</small></div>
      <div className="field"><label>Seedance 模型名称</label><select value={config.model} disabled={!models.length} onChange={(event) => selectModel(event.target.value)}>{!models.length && <option value="">填写 Key 后自动发现</option>}{models.map((model) => <option key={model.id} value={model.id}>{model.label} · {model.id}</option>)}</select></div>
      <div className="settings-actions span-2"><button className="button secondary" disabled={discovering || !config.apiKey} onClick={() => discover(false)}>{discovering ? <LoaderCircle className="spin" /> : <RefreshCw />} 重新检测模型</button></div>
    </div></section>
    <div className="workspace">
      <section className="composer card"><div className="section-heading"><div><span className="step">01</span><h2>描述你想看到的画面</h2></div><span className="model-chip">{descriptor?.label || '未选择模型'}</span></div>
        <form onSubmit={submit} className="composer-form"><div className="composer-layout"><div className="prompt-column"><div className="prompt-wrap"><textarea required maxLength={5000} value={form.prompt} onChange={(event) => setForm({ ...form, prompt: event.target.value })} placeholder="例如：清晨的南京长江大桥笼罩在薄雾中，镜头沿江面缓慢向前推进，电影感……" /><span className="char-count">{form.prompt.length} / 5000</span></div><p className="model-hint">{descriptor ? `${descriptor.label} 支持 ${descriptor.resolutions.join(' / ')}、4–15秒。` : '请先配置并选择模型。'}</p><div className="preset-panel"><div className="preset-tabs">{PROMPT_PRESETS.map((item) => <button type="button" key={item.category} className={item.category === presetCategory ? 'active' : ''} onClick={() => setPresetCategory(item.category)}>{item.category}</button>)}</div><div className="preset-list">{activePreset.prompts.map((prompt, index) => <button type="button" key={prompt} onClick={() => setForm((current) => ({ ...current, prompt }))}><span>{index + 1}</span>{prompt}</button>)}</div></div></div>
          <div className="parameter-grid"><label>分辨率<select value={form.resolution} onChange={(event) => setForm({ ...form, resolution: event.target.value })}>{(descriptor?.resolutions || ['720p']).map((value) => <option key={value} value={value}>{value.toUpperCase()}</option>)}</select></label>
            <label>画面比例<select value={form.ratio} onChange={(event) => setForm({ ...form, ratio: event.target.value })}>{['16:9','9:16','1:1','4:3','3:4','21:9'].map((value) => <option key={value}>{value}</option>)}</select></label>
            <label>时长（秒）<input type="number" min="4" max="15" value={form.duration} onChange={(event) => setForm({ ...form, duration: Number(event.target.value) })} /></label>
            <Toggle label="生成音频" value={form.generateAudio} onChange={(value) => setForm({ ...form, generateAudio: value })} />
            <Toggle label="添加水印" value={form.watermark} onChange={(value) => setForm({ ...form, watermark: value })} />
          </div></div>
          <button className="generate" disabled={submitting || !configured || !descriptor}>{submitting ? <LoaderCircle className="spin" /> : <Play fill="currentColor" />} {submitting ? '正在入队…' : '开始生成视频'}</button><p className="cost-hint">提交会产生真实模型调用费用；排队任务由服务器统一控制并发。</p>
        </form></section>
      <section className="results card"><div className="section-heading"><div><span className="step">02</span><h2>我的任务</h2></div><div className="results-heading-actions"><span className="task-count">{tasks.length} 条任务</span><button className="icon-button" type="button" onClick={refreshTasks} aria-label="刷新任务" title="刷新任务"><RefreshCw size={16} /></button></div></div>{latestTask ? <div className="task-list"><section className="latest-task" aria-label="最新任务"><div className="task-group-heading"><span>最新任务</span><small>最近提交</small></div><TaskCard task={latestTask} featured busyAction={taskAction} onRetryQuery={(task) => runTaskAction(task, 'retry-query')} onRegenerate={requestRegenerate} onDelete={requestDelete} /></section>{historyTasks.length > 0 && <section className="history-tasks" aria-label="历史任务"><div className="task-group-heading"><span>历史任务</span><small>{historyTasks.length} 条</small></div><div className="task-history">{historyTasks.map((task) => <TaskCard key={task.id} task={task} busyAction={taskAction} onRetryQuery={(item) => runTaskAction(item, 'retry-query')} onRegenerate={requestRegenerate} onDelete={requestDelete} />)}</div></section>}</div> : <EmptyResult />}</section>
    </div><footer>API Key不落盘 · 任务记录保留90天 · 视频链接通常仅有效24小时</footer>
    <ConfirmDialog confirmation={confirmation} busy={Boolean(taskAction)} onCancel={() => setConfirmation(null)} onConfirm={() => runTaskAction(confirmation.task, confirmation.action)} />
  </main>;
}

function AdminPanel({ auth, notify }) {
  const [data, setData] = useState({ users: [], pricing: [], settings: {}, tasks: [], dashboard: {} });
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'USER', discountRate: 1 });
  const [discountDrafts, setDiscountDrafts] = useState({});
  const [savingDiscount, setSavingDiscount] = useState(null);
  const [taskAction, setTaskAction] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const load = useCallback(async () => {
    try {
      const [users, pricing, settings, tasks, dashboard] = await Promise.all(['/api/admin/users','/api/admin/pricing','/api/admin/settings','/api/admin/tasks','/api/admin/dashboard'].map((url) => api(url)));
      setData({ users: users.users, pricing: pricing.pricing, settings: settings.settings, tasks: tasks.tasks, dashboard: dashboard.dashboard });
    } catch (error) { notify({ type: 'error', text: error.message }); }
  }, [notify]);
  useEffect(() => { load(); }, [load]);
  const createUser = async (event) => { event.preventDefault(); try { await api('/api/admin/users', { method: 'POST', csrf: auth.csrfToken, body: newUser }); setNewUser({ username: '', password: '', role: 'USER', discountRate: 1 }); notify({ type: 'success', text: '账号已创建，首次登录将要求修改密码。' }); load(); } catch (error) { notify({ type: 'error', text: error.message }); } };
  const updateUser = async (id, patch) => {
    try {
      const result = await api(`/api/admin/users/${id}`, { method: 'PATCH', csrf: auth.csrfToken, body: patch });
      setData((current) => ({ ...current, users: current.users.map((user) => user.id === id ? result.user : user) }));
      notify({ type: 'success', text: `账号 ${result.user.username} 已${result.user.disabled ? '禁用' : '启用'}。` });
    } catch (error) { notify({ type: 'error', text: error.message }); }
  };
  const saveDiscount = async (user) => {
    const draft = discountDrafts[user.id] ?? String(formatDiscountPercent(user.discountRate));
    const percent = Number(draft);
    if (draft === '' || !Number.isFinite(percent) || percent < 0 || percent > 100) {
      notify({ type: 'error', text: '折扣率必须是 0 到 100 之间的百分比。' });
      return;
    }
    setSavingDiscount(user.id);
    try {
      const result = await api(`/api/admin/users/${user.id}`, { method: 'PATCH', csrf: auth.csrfToken, body: { discountRate: percent / 100 } });
      setData((current) => ({ ...current, users: current.users.map((item) => item.id === user.id ? result.user : item) }));
      setDiscountDrafts((current) => { const next = { ...current }; delete next[user.id]; return next; });
      notify({ type: 'success', text: `账号 ${result.user.username} 的折扣率已保存为 ${formatDiscountPercent(result.user.discountRate)}%。` });
    } catch (error) { notify({ type: 'error', text: error.message }); }
    finally { setSavingDiscount(null); }
  };
  const retryAdminQuery = async (task) => {
    const key = `${task.id}:retry-query`;
    setTaskAction(key);
    try {
      const result = await api(`/api/admin/tasks/${task.id}/retry-query`, { method: 'POST', csrf: auth.csrfToken });
      setData((current) => ({ ...current, tasks: current.tasks.map((item) => item.id === task.id ? result.task : item) }));
      notify({ type: 'success', text: '已触发原远端任务查询，不会创建新的生成调用。' });
    } catch (error) { notify({ type: 'error', text: error.message }); }
    finally { setTaskAction(null); }
  };
  const deleteAdminTask = async (task) => {
    setTaskAction(`${task.id}:delete`);
    try {
      await api(`/api/admin/tasks/${task.id}`, { method: 'DELETE', csrf: auth.csrfToken });
      setData((current) => ({ ...current, tasks: current.tasks.filter((item) => item.id !== task.id) }));
      notify({ type: 'success', text: '任务已移除并停止本地跟踪。' });
    } catch (error) { notify({ type: 'error', text: error.message }); }
    finally { setTaskAction(null); setConfirmation(null); }
  };
  return <main className="admin-main"><header className="admin-heading"><div><span className="eyebrow">ADMIN CONSOLE</span><h1>部门使用与费用管理</h1><p>管理员只能查看任务元数据，无法读取同事的完整提示词和视频地址。</p></div><button className="button secondary" onClick={load}><RefreshCw /> 刷新</button></header>
    <DashboardCards dashboard={data.dashboard} />
    <section className="admin-grid"><div className="card admin-card"><div className="section-heading"><div><Users /><h2>账号管理</h2></div></div><form className="inline-form" onSubmit={createUser}><input placeholder="用户名" value={newUser.username} onChange={(event) => setNewUser({ ...newUser, username: event.target.value })} /><input type="password" placeholder="临时密码" value={newUser.password} onChange={(event) => setNewUser({ ...newUser, password: event.target.value })} /><select value={newUser.role} onChange={(event) => setNewUser({ ...newUser, role: event.target.value })}><option>USER</option><option>ADMIN</option></select><input type="number" min="0" max="100" step="1" title="折扣率百分比" value={formatDiscountPercent(newUser.discountRate)} onChange={(event) => setNewUser({ ...newUser, discountRate: percentToDiscount(event.target.value) })} /><button className="button primary"><UserPlus /> 新建</button></form><div className="table-wrap"><table><thead><tr><th>账号</th><th>角色</th><th>折扣率</th><th>状态</th><th>操作</th></tr></thead><tbody>{data.users.map((user) => { const draft = discountDrafts[user.id] ?? String(formatDiscountPercent(user.discountRate)); const dirty = Number(draft) !== formatDiscountPercent(user.discountRate); return <tr key={user.id}><td>{user.username}</td><td>{user.role}</td><td><div className="discount-editor"><input type="number" min="0" max="100" step="1" value={draft} onChange={(event) => setDiscountDrafts((current) => ({ ...current, [user.id]: event.target.value }))} /><span>%</span><button className="save-inline" disabled={!dirty || savingDiscount === user.id} onClick={() => saveDiscount(user)} title="保存折扣率">{savingDiscount === user.id ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />} 保存</button></div></td><td>{user.disabled ? '已禁用' : user.mustChangePassword ? '待改密码' : '正常'}</td><td><button disabled={user.id === auth.user.id} onClick={() => updateUser(user.id, { disabled: !user.disabled })}>{user.disabled ? '启用' : '禁用'}</button></td></tr>; })}</tbody></table></div></div>
      <PricingCard pricing={data.pricing} auth={auth} notify={notify} />
    </section>
    <SettingsCard settings={data.settings} auth={auth} notify={notify} />
    <section className="card admin-card"><div className="section-heading"><div><Activity /><h2>最近任务（已脱敏）</h2></div></div><div className="table-wrap"><table className="task-admin-table"><thead><tr><th>时间</th><th>任务 ID</th><th>用户名</th><th>模型</th><th>分辨率</th><th>状态</th><th>Token</th><th>费用</th><th>操作</th></tr></thead><tbody>{data.tasks.map((task) => <tr key={task.id}><td>{formatDate(task.createdAt, true)}</td><td><div className="admin-task-ids"><span title={`本地任务 ID：${task.id}`}>本地 {shortId(task.id)}</span>{task.remoteTaskId && <span title={`远端任务 ID：${task.remoteTaskId}`}>远端 {shortId(task.remoteTaskId)}</span>}</div></td><td>{task.username || '未知'} <span className="mono muted-id">{task.userId.slice(0, 8)}</span></td><td>{shortModel(task.model)}</td><td>{task.resolution}</td><td title={task.message || ''}>{statusText(task.status)}</td><td>{task.cost ? `${formatTokenMillions(task.cost.totalTokens)} 百万` : '—'}</td><td>{task.cost ? `¥${task.cost.totalCost.toFixed(4)}` : '—'}</td><td><div className="admin-task-actions">{canRetryQuery(task) && <button disabled={Boolean(taskAction)} onClick={() => retryAdminQuery(task)} title="查询原远端任务"><RefreshCw size={13} /> 重试查询</button>}{canDeleteTask(task) && <button className="danger" disabled={Boolean(taskAction)} onClick={() => setConfirmation({ task, title: '确认移除任务', confirmLabel: '移除任务', type: 'warning', text: task.remoteTaskId ? '移除只会停止本地跟踪，不会取消 TokenHub 上的远端任务。' : '任务将从最近任务和统计中隐藏，审计记录仍会保留。' })} title="移除任务"><Trash2 size={13} /></button>}</div></td></tr>)}</tbody></table></div></section>
    <ConfirmDialog confirmation={confirmation} busy={Boolean(taskAction)} onCancel={() => setConfirmation(null)} onConfirm={() => deleteAdminTask(confirmation.task)} />
  </main>;
}

function PricingCard({ pricing, auth, notify }) {
  const [rows, setRows] = useState(pricing);
  const [saving, setSaving] = useState(null);
  useEffect(() => setRows(pricing), [pricing]);
  const save = async (row) => {
    const id = `${row.model}:${row.resolution}`;
    setSaving(id);
    try {
      const result = await api('/api/admin/pricing', { method: 'PUT', csrf: auth.csrfToken, body: row });
      setRows((current) => current.map((item) => item.model === row.model && item.resolution === row.resolution ? result.pricing : item));
      notify({ type: 'success', text: `${shortModel(row.model)} ${row.resolution.toUpperCase()} 的 Token 单价已保存。` });
    } catch (error) { notify({ type: 'error', text: error.message }); }
    finally { setSaving(null); }
  };
  const change = (index, field, value) => setRows((current) => current.map((row, idx) => idx === index ? { ...row, [field]: Number(value) } : row));
  return <div className="card admin-card"><div className="section-heading"><div><Gauge /><h2>Token单价</h2></div></div><div className="table-wrap"><table><thead><tr><th>模型</th><th>分辨率</th><th>输入/百万</th><th>输出/百万</th><th></th></tr></thead><tbody>{rows.map((row, index) => { const id = `${row.model}:${row.resolution}`; return <tr key={id}><td>{shortModel(row.model)}</td><td>{row.resolution}</td><td><input type="number" min="0" step="0.01" value={row.inputRate} onChange={(event) => change(index, 'inputRate', event.target.value)} /></td><td><input type="number" min="0" step="0.01" value={row.outputRate} onChange={(event) => change(index, 'outputRate', event.target.value)} /></td><td><button disabled={saving === id} onClick={() => save(row)} title="保存 Token 单价">{saving === id ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}</button></td></tr>; })}</tbody></table></div></div>;
}

function SettingsCard({ settings, auth, notify }) {
  const [form, setForm] = useState(settings);
  const [saving, setSaving] = useState(false);
  useEffect(() => setForm(settings), [settings]);
  const fields = [
    ['globalActiveLimit','全局活跃','整个系统已提交远端且尚未结束的任务上限。'],
    ['perUserActiveLimit','每人活跃','单个用户可同时占用的远端任务上限。'],
    ['perUserQueueLimit','每人排队','单个用户尚未提交远端的本地排队任务上限。'],
    ['perKeyActiveLimit','同 Key 活跃','同一个 API Key 可同时运行的远端任务上限。'],
    ['globalQueueLimit','全局排队','整个系统允许等待提交远端的本地任务总上限。']
  ];
  const save = async () => {
    setSaving(true);
    try {
      const result = await api('/api/admin/settings', { method: 'PUT', csrf: auth.csrfToken, body: form });
      setForm(result.settings);
      notify({ type: 'success', text: '并发与队列设置已保存。' });
    } catch (error) { notify({ type: 'error', text: error.message }); }
    finally { setSaving(false); }
  };
  return <section className="card admin-card"><div className="section-heading"><div><Settings2 /><h2>并发与队列</h2></div><button className="button primary compact" disabled={saving} onClick={save}>{saving ? <LoaderCircle className="spin" /> : <Save />} 保存</button></div><p className="settings-explainer">活跃任务指已经提交到远端、目前处于远端排队或生成中的任务。本地排队任务尚未发送到 TokenHub，不会产生远端任务 ID。</p><div className="settings-row">{fields.map(([key,label,description]) => <label key={key}><strong>{label}</strong><small>{description}</small><input type="number" min="1" value={form[key] || ''} onChange={(event) => setForm({ ...form, [key]: Number(event.target.value) })} /></label>)}</div></section>;
}

function DashboardCards({ dashboard }) { const cards = [[Activity,'活跃任务',dashboard.active],[Clock3,'排队任务',dashboard.queued],[Check,'成功任务',dashboard.succeeded],[Gauge,'累计费用',`¥${Number(dashboard.totalCost || 0).toFixed(4)}`]]; return <div className="metrics">{cards.map(([Icon,label,value]) => <div className="metric" key={label}><Icon /><div><span>{label}</span><strong>{value ?? 0}</strong></div></div>)}</div>; }
function TaskCard({ task, featured = false, busyAction, onRetryQuery, onRegenerate, onDelete }) {
  const active = ACTIVE_STATES.has(task.status);
  const failed = ['FAILED','UNKNOWN'].includes(task.status);
  const busy = Boolean(busyAction?.startsWith(task.id));
  return <article className={`task ${featured ? 'featured' : ''} ${task.status.toLowerCase()}`}><div className="task-top"><div className="task-status">{active ? <LoaderCircle className="spin" /> : task.status === 'SUCCEEDED' ? <Check /> : <CircleAlert />} {statusText(task.status)}</div><span className="model-chip">{task.resolution?.toUpperCase()}</span></div>{task.videoUrl && <TaskVideo task={task} />}<p className="task-prompt">{task.prompt}</p><div className="task-meta"><span><Clock3 /> {formatDate(task.createdAt)}</span><span>{shortModel(task.model)}</span></div>{task.message && <div className={failed ? 'task-error' : 'task-warning'}>{task.message}</div>}{task.cost ? <div className="usage-box"><span>输入 {formatTokenMillions(task.cost.promptTokens)}百万</span><span>输出 {formatTokenMillions(task.cost.completionTokens)}百万</span><strong>¥{task.cost.totalCost.toFixed(4)}</strong></div> : task.status === 'SUCCEEDED' && <div className="usage-box muted">TokenHub未返回用量，无法精确计费</div>}{task.videoUrl && <div className="video-actions"><button onClick={() => navigator.clipboard.writeText(task.videoUrl)}><Copy />复制链接</button><a href={task.videoUrl} target="_blank" rel="noreferrer"><ExternalLink />打开</a><a href={task.videoUrl} download><Download />下载</a></div>}{(canRetryQuery(task) || failed || canDeleteTask(task)) && <div className="task-actions">{canRetryQuery(task) && <button disabled={busy} onClick={() => onRetryQuery(task)}><RefreshCw />重试查询</button>}{failed && <button disabled={busy} onClick={() => onRegenerate(task)}><Play />重新生成</button>}{canDeleteTask(task) && <button className="danger" disabled={busy} onClick={() => onDelete(task)}><Trash2 />移除</button>}{busy && <LoaderCircle className="spin task-action-loader" />}</div>}<div className="task-id">本地任务：{task.id}{task.remoteTaskId ? ` · 远端：${task.remoteTaskId}` : ''}</div></article>;
}
function TaskVideo({ task }) {
  const [aspectRatio, setAspectRatio] = useState(String(task.ratio || '16:9').replace(':', ' / '));
  const fitNativeRatio = (event) => {
    const { videoWidth, videoHeight } = event.currentTarget;
    if (videoWidth > 0 && videoHeight > 0) setAspectRatio(`${videoWidth} / ${videoHeight}`);
  };
  const [width, height] = aspectRatio.split('/').map(Number);
  const ratio = width > 0 && height > 0 ? width / height : 16 / 9;
  const orientation = ratio < .9 ? 'portrait' : ratio <= 1.1 ? 'square' : 'landscape';
  return <div className={`video-wrap ${orientation}`} style={{ aspectRatio }}><video src={task.videoUrl} controls playsInline preload="metadata" onLoadedMetadata={fitNativeRatio} /></div>;
}
function Toggle({ label, value, onChange }) { return <label className="switch-label"><span>{label}</span><button type="button" className={`switch ${value ? 'on' : ''}`} onClick={() => onChange(!value)}><span /></button></label>; }
function EmptyResult() { return <div className="empty-result"><div className="film-icon"><Film /></div><h3>视频将在这里出现</h3><p>提交后可以关闭页面，服务器会继续排队和查询。</p></div>; }
function Toast({ toast, onClose }) {
  useEffect(() => {
    if (!toast || !['success', 'info'].includes(toast.type)) return undefined;
    const timer = window.setTimeout(onClose, 3000);
    return () => window.clearTimeout(timer);
  }, [toast, onClose]);
  if (!toast) return null;
  const Icon = toast.type === 'success' ? Check : toast.type === 'warning' ? AlertTriangle : CircleAlert;
  return <div className="toast-host" aria-live="polite"><div key={toast.id} className={`toast ${toast.type}`} role={toast.type === 'error' || toast.type === 'warning' ? 'alert' : 'status'}><Icon /><span>{toast.text}</span><button onClick={onClose} aria-label="关闭提示" title="关闭提示"><X /></button></div></div>;
}
function ConfirmDialog({ confirmation, busy, onCancel, onConfirm }) {
  if (!confirmation) return null;
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}><section className={`confirm-dialog ${confirmation.type || 'info'}`} role="dialog" aria-modal="true" aria-labelledby="confirm-title"><div className="confirm-icon">{confirmation.type === 'warning' ? <AlertTriangle /> : <CircleAlert />}</div><div><h2 id="confirm-title">{confirmation.title}</h2><p>{confirmation.text}</p></div><div className="confirm-actions"><button className="button secondary" disabled={busy} onClick={onCancel}>取消</button><button className="button danger" disabled={busy} onClick={onConfirm}>{busy ? <LoaderCircle className="spin" /> : confirmation.action === 'regenerate' ? <Play /> : <Trash2 />}{confirmation.confirmLabel}</button></div></section></div>;
}
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
function shortId(value = '') { return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-5)}` : value; }
function canRetryQuery(task) { return Boolean(task.remoteTaskId && (task.status === 'UNKNOWN' || task.errorKind || task.upstreamStatus)); }
function canDeleteTask(task) { return ['FAILED', 'UNKNOWN', 'AUTH_REQUIRED'].includes(task.status); }
function statusText(value) { return { LOCAL_QUEUED:'本地排队',SUBMITTING:'正在提交',PENDING:'远端排队',RUNNING:'生成中',AUTH_REQUIRED:'等待重新填写API Key',SUCCEEDED:'已完成',FAILED:'失败',UNKNOWN:'状态待核对' }[value] || value; }
function formatDate(value, date = false) { return value ? new Intl.DateTimeFormat('zh-CN', date ? { month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit' } : { hour:'2-digit',minute:'2-digit' }).format(new Date(value)) : '—'; }
function formatTokenMillions(value) { return (Number(value || 0) / 1_000_000).toFixed(4); }
function formatDiscountPercent(value) { return Math.round(Number(value ?? 1) * 100); }
function percentToDiscount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.min(100, Math.max(0, number)) / 100;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
