import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Check, ChevronDown, CircleAlert, Clock3, Copy, Download, ExternalLink,
  Film, KeyRound, LoaderCircle, Play, RefreshCw, Settings2, Sparkles, Wifi
} from 'lucide-react';
import './styles.css';

const TASKS_KEY = 'tokenhub-seedance-tasks';
const PUBLIC_CONFIG_KEY = 'tokenhub-seedance-config';
const ACTIVE_STATES = new Set(['PENDING', 'RUNNING']);

function App() {
  const saved = readSession(PUBLIC_CONFIG_KEY, {});
  const [config, setConfig] = useState({
    url: saved.url || '',
    apiKey: '',
    model: saved.model || ''
  });
  const [configured, setConfigured] = useState(false);
  const [maskedKey, setMaskedKey] = useState('');
  const [models, setModels] = useState([]);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [configBusy, setConfigBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [form, setForm] = useState({
    prompt: '', resolution: '720p', ratio: '16:9', duration: '5', generateAudio: false, watermark: false
  });
  const [submitting, setSubmitting] = useState(false);
  const [tasks, setTasks] = useState(() => readSession(TASKS_KEY, []));
  const polling = useRef(new Set());

  useEffect(() => {
    api('/api/config').then((data) => {
      if (!data.configured) return;
      setConfigured(true);
      setMaskedKey(data.config.apiKeyMasked);
      setConfig((current) => ({
        ...current,
        url: data.config.submitUrl,
        model: data.config.model
      }));
      setSettingsOpen(false);
    }).catch(() => {});
  }, []);

  useEffect(() => writeSession(TASKS_KEY, tasks), [tasks]);
  useEffect(() => writeSession(PUBLIC_CONFIG_KEY, { url: config.url, model: config.model }), [config.url, config.model]);

  const saveConfig = async ({ discover = false } = {}) => {
    setConfigBusy(true);
    setNotice(null);
    try {
      const savedConfig = await api('/api/config', {
        method: 'POST', body: JSON.stringify(config)
      });
      setConfigured(true);
      setMaskedKey(savedConfig.config.apiKeyMasked);
      setConfig((current) => ({ ...current, url: savedConfig.config.submitUrl, apiKey: '' }));
      if (discover) {
        const discovered = await api('/api/models/discover', { method: 'POST' });
        setModels(discovered.models);
        const videoModels = discovered.models.filter(isVideoModel);
        setNotice({ type: 'success', text: `Key 验证成功，发现 ${discovered.models.length} 个模型${videoModels.length ? `，其中 ${videoModels.length} 个可能支持视频` : ''}。模型可见不代表视频生成路由已开通。` });
      } else {
        setNotice({ type: 'success', text: '配置已保存到本机内存，本页不会持久化 API Key。' });
        setSettingsOpen(false);
      }
    } catch (error) {
      setNotice({ type: 'error', text: error.message });
    } finally {
      setConfigBusy(false);
    }
  };

  const submitTask = async (event) => {
    event.preventDefault();
    if (!configured) {
      setSettingsOpen(true);
      setNotice({ type: 'error', text: '请先保存 TokenHub 配置。' });
      return;
    }
    setSubmitting(true);
    setNotice(null);
    try {
      const data = await api('/api/video/tasks', {
        method: 'POST',
        body: JSON.stringify({ ...form, model: config.model })
      });
      setTasks((current) => [data.task, ...current.filter((item) => item.id !== data.task.id)]);
      setNotice({ type: 'success', text: '视频任务已提交，系统将每 10 秒自动查询一次。' });
    } catch (error) {
      setNotice({ type: 'error', text: error.message });
    } finally {
      setSubmitting(false);
    }
  };

  const pollTask = useCallback(async (id, manual = false) => {
    if (polling.current.has(id)) return;
    polling.current.add(id);
    try {
      const data = await api(`/api/video/tasks/${encodeURIComponent(id)}`);
      setTasks((current) => current.map((item) => item.id === id ? data.task : item));
    } catch (error) {
      if (manual || error.status === 401 || error.status === 404) {
        setNotice({ type: 'error', text: error.message });
      }
    } finally {
      polling.current.delete(id);
    }
  }, []);

  useEffect(() => {
    const active = tasks.filter((task) => ACTIVE_STATES.has(task.status));
    if (!active.length || !configured) return undefined;
    const timer = window.setInterval(() => active.forEach((task) => pollTask(task.id)), 10_000);
    return () => window.clearInterval(timer);
  }, [tasks, configured, pollTask]);

  const videoModels = models.filter(isVideoModel);
  const anyActive = tasks.some((task) => ACTIVE_STATES.has(task.status));

  return (
    <main>
      <header className="hero">
        <div className="brand"><Sparkles size={18} /> 江苏电信 TokenHub</div>
        <div className="hero-copy">
          <span className="eyebrow">SEEDANCE VIDEO STUDIO</span>
          <h1>把一句想法，变成一段画面。</h1>
          <p>配置你的 TokenHub 网关，提交文生视频任务，并在同一个页面等待、预览和保存结果。</p>
        </div>
        <div className={`connection ${configured ? 'online' : ''}`}>
          <span className="connection-dot" />
          {configured ? `配置已就绪 · ${maskedKey}` : '等待配置'}
        </div>
      </header>

      {notice && <div className={`notice ${notice.type}`}>
        {notice.type === 'success' ? <Check size={18} /> : <CircleAlert size={18} />}
        <span>{notice.text}</span>
        <button onClick={() => setNotice(null)} aria-label="关闭提示">×</button>
      </div>}

      <section className="settings card">
        <button className="section-toggle" onClick={() => setSettingsOpen((value) => !value)} aria-expanded={settingsOpen}>
          <span className="section-title"><Settings2 size={19} /> 连接配置</span>
          <span className="settings-summary">{configured ? `${shortUrl(config.url)} · ${config.model}` : '填写 URL、API Key 和模型名称'}</span>
          <ChevronDown className={settingsOpen ? 'rotated' : ''} size={19} />
        </button>
        {settingsOpen && <div className="settings-body">
          <div className="field span-2">
            <label htmlFor="gateway-url">文生视频 URL</label>
            <div className="input-icon"><Wifi size={17} /><input id="gateway-url" type="url" placeholder="https://网关地址/v1 或完整生成地址" value={config.url} onChange={(e) => setConfig({ ...config, url: e.target.value })} /></div>
            <small>支持 Base URL，或以 /v1/videos/generations 结尾的完整地址</small>
          </div>
          <div className="field">
            <label htmlFor="api-key">API Key</label>
            <div className="input-icon"><KeyRound size={17} /><input id="api-key" type="password" autoComplete="off" placeholder={configured ? `${maskedKey}（留空保持不变）` : '仅保存在本机服务内存'} value={config.apiKey} onChange={(e) => setConfig({ ...config, apiKey: e.target.value })} /></div>
          </div>
          <div className="field">
            <label htmlFor="model">Seedance 模型名称</label>
            <input id="model" list="video-models" placeholder="例如平台模型详情页中的名称" value={config.model} onChange={(e) => setConfig({ ...config, model: e.target.value })} />
            <datalist id="video-models">{(videoModels.length ? videoModels : models).map((model) => <option key={model} value={model} />)}</datalist>
          </div>
          <div className="settings-actions span-2">
            <button className="button secondary" disabled={configBusy} onClick={() => saveConfig({ discover: true })}>
              {configBusy ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />} 保存并检查模型
            </button>
            <button className="button primary compact" disabled={configBusy} onClick={() => saveConfig()}>
              保存配置
            </button>
          </div>
        </div>}
      </section>

      <div className="workspace">
        <section className="composer card">
          <div className="section-heading">
            <div><span className="step">01</span><h2>描述你想看到的画面</h2></div>
            <span className="model-chip">{config.model || '未选择模型'}</span>
          </div>
          <form onSubmit={submitTask}>
            <div className="prompt-wrap">
              <textarea required maxLength={5000} placeholder="例如：清晨的南京长江大桥笼罩在薄雾中，镜头沿江面缓慢向前推进，电影感，柔和自然光……" value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} />
              <span className="char-count">{form.prompt.length} / 5000</span>
            </div>
            <div className="parameter-grid">
              <label>分辨率<select value={form.resolution} onChange={(e) => setForm({ ...form, resolution: e.target.value })}>
                <option value="720p">720p</option>
                <option value="480p">480p</option>
              </select></label>
              <label>画面比例<select value={form.ratio} onChange={(e) => setForm({ ...form, ratio: e.target.value })}>
                <option value="16:9">16:9 横屏</option>
                <option value="9:16">9:16 竖屏</option>
                <option value="1:1">1:1 方形</option>
                <option value="4:3">4:3</option>
                <option value="3:4">3:4</option>
                <option value="21:9">21:9 超宽屏</option>
              </select></label>
              <label>时长（秒）<input type="number" min="4" max="15" step="1" value={form.duration} onChange={(e) => setForm({ ...form, duration: e.target.value })} /></label>
              <label className="switch-label"><span>生成音频</span><button type="button" className={`switch ${form.generateAudio ? 'on' : ''}`} onClick={() => setForm({ ...form, generateAudio: !form.generateAudio })} aria-pressed={form.generateAudio}><span /></button></label>
              <label className="switch-label"><span>添加水印</span><button type="button" className={`switch ${form.watermark ? 'on' : ''}`} onClick={() => setForm({ ...form, watermark: !form.watermark })} aria-pressed={form.watermark}><span /></button></label>
            </div>
            <p className="model-hint">Seedance 2.0 Mini 支持 480p / 720p、4–15 秒；该协议不发送反向提示词和随机种子。</p>
            <button className="generate" disabled={submitting || anyActive || !configured}>
              {submitting ? <LoaderCircle className="spin" size={20} /> : <Play size={19} fill="currentColor" />}
              {submitting ? '正在提交…' : anyActive ? '已有任务正在生成' : configured ? '开始生成视频' : '请先完成连接配置'}
            </button>
            <p className="cost-hint">提交会产生真实模型调用费用，请在确认参数后操作。</p>
          </form>
        </section>

        <section className="results card">
          <div className="section-heading"><div><span className="step">02</span><h2>生成结果</h2></div><span className="task-count">{tasks.length} 个任务</span></div>
          {!tasks.length ? <EmptyResult /> : <div className="task-list">
            {tasks.map((task) => <TaskCard key={task.id} task={task} onRefresh={() => pollTask(task.id, true)} />)}
          </div>}
        </section>
      </div>

      <footer>API Key 不写入磁盘 · 任务链接由 TokenHub 返回 · 请勿在公共设备保存敏感配置</footer>
    </main>
  );
}

function EmptyResult() {
  return <div className="empty-result"><div className="film-icon"><Film size={31} /></div><h3>视频将在这里出现</h3><p>提交任务后，可以离开页面做其他工作。生成过程中我们会自动更新状态。</p></div>;
}

function TaskCard({ task, onRefresh }) {
  const active = ACTIVE_STATES.has(task.status);
  const statusText = { PENDING: '排队中', RUNNING: '生成中', SUCCEEDED: '已完成', FAILED: '失败', UNKNOWN: '状态未知' }[task.status] || task.status;
  const copyUrl = async () => task.videoUrl && navigator.clipboard.writeText(task.videoUrl);
  return <article className={`task ${task.status.toLowerCase()}`}>
    <div className="task-top">
      <div className="task-status">{active ? <LoaderCircle className="spin" size={17} /> : task.status === 'SUCCEEDED' ? <Check size={17} /> : <CircleAlert size={17} />} {statusText}</div>
      <button className="icon-button" onClick={onRefresh} disabled={active && false} title="立即刷新"><RefreshCw size={16} /></button>
    </div>
    {task.videoUrl && <div className="video-wrap"><video src={task.videoUrl} controls preload="metadata" /></div>}
    <p className="task-prompt">{task.prompt}</p>
    <div className="task-meta"><span><Clock3 size={14} /> {formatDate(task.createdAt)}</span><span>{task.model}</span></div>
    {task.status === 'FAILED' && <div className="task-error">{task.message || task.code || '平台未返回具体失败原因'}</div>}
    {task.videoUrl && <div className="video-actions">
      <button onClick={copyUrl}><Copy size={15} /> 复制链接</button>
      <a href={task.videoUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} /> 打开原视频</a>
      <a href={task.videoUrl} download><Download size={15} /> 下载</a>
    </div>}
    <div className="task-id" title={task.id}>任务 ID：{task.id}</div>
    {task.status === 'SUCCEEDED' && <p className="expiry">视频链接通常仅有效 24 小时，请及时保存。</p>}
  </article>;
}

async function api(url, options) {
  const response = await fetch(url, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const requestId = data?.error?.requestId;
    const suffix = requestId ? `（请求 ID：${requestId}）` : '';
    const error = new Error(`${data?.error?.message || `请求失败（${response.status}）`}${suffix}`);
    error.status = response.status;
    error.code = data?.error?.code;
    error.requestId = requestId;
    throw error;
  }
  return data;
}

function isVideoModel(model) { return /seedance|t2v|video|wan|happyhorse/i.test(model); }
function shortUrl(value) { try { return new URL(value).host; } catch { return value || ''; } }
function formatDate(value) { return value ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '-'; }
function readSession(key, fallback) { try { return JSON.parse(sessionStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function writeSession(key, value) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch {} }

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
