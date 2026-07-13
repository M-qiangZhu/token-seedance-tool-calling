# 江苏电信 TokenHub Seedance 文生视频工具

一个本机运行的中文 Web 工具，用于通过江苏电信 TokenHub 提交文生视频任务、自动查询生成状态并预览或保存结果。

## 快速开始

需要 Node.js 20+ 和 pnpm。

```bash
pnpm install
pnpm dev
```

打开 <http://localhost:18080>。本地 API 运行在 <http://localhost:18081>，健康检查地址为 <http://localhost:18081/api/health>。

如果这两个端口已被另一套 TokenHub 工具占用，可执行 `pnpm dev:alt`，改用前端 `18180` 和 API `18181`。

在“连接配置”中填写：

1. TokenHub Base URL（例如 `https://网关地址/v1`）或完整的 `/v1/videos/generations` 地址。
2. 从 TokenHub “API 管理”中取得的 API Key。
3. Seedance 模型详情页显示的准确模型名称。

点击“保存并检查模型”可以调用 `/v1/models` 检查当前 Key 可见的模型。接口若不支持模型发现，也可以直接保存已确认的模型名称。

## 可用命令

```bash
pnpm dev      # 同时启动前端和 API
pnpm dev:alt  # 端口冲突时改用 18180/18181
pnpm test     # 运行单元和模拟上游测试
pnpm build    # 构建前端生产文件
pnpm start    # 从 API 服务提供已构建的前端（端口 18081）
pnpm check    # 测试并构建
```

生产模式先执行 `pnpm build`，再执行 `pnpm start`，访问 <http://localhost:18081>。

## 安全与费用

- API Key 只保存在 Node.js 进程内存，通过 HttpOnly 会话 Cookie 关联；不会写入源码、浏览器存储、日志或磁盘。
- 会话默认 8 小时失效，服务重启后需要重新填写 API Key。
- 浏览器 `sessionStorage` 只保存脱敏后的公开配置和当前任务信息，以便刷新页面后继续查看。
- “开始生成视频”会产生真实 TokenHub 模型调用和相应费用。本项目的自动测试使用模拟上游，不会调用或计费。
- TokenHub 返回的视频 URL 通常只有有限有效期，请生成成功后及时下载。

## 接口协议

当前按 TokenHub 路由和 Seedance 2.0 原生请求结构实现：

- `POST /v1/videos/generations` 创建任务。
- `GET /v1/videos/generations/task/{taskId}` 查询任务。
- Seedance 模型使用 `application/json`，提示词放在顶层 `content: [{ type: "text", text: "..." }]` 中。
- 创建请求携带 `X-DashScope-Async: enable`，并可使用顶层 `resolution`、`ratio`、`duration`、`generate_audio` 和 `watermark`。
- `doubao-seedance-2-0-mini-260615` 仅接受 `480p/720p` 和 4–15 秒，不发送反向提示词或随机种子。
- Wan/HappyHorse 等随附文档模型继续使用 `model`、`input.prompt` 和 `parameters`。

TokenHub 模型详情页当前对所有视频模型复用 Wan 示例，该示例不是 Seedance Mini 的请求体。

模型详情请以 [Seedance 2.0 Mini（id=66）](https://token.telecomjs.com/modelDetail?id=66) 为准；`id=65` 是 Fast，不要混用模型或请求参数。Seedance 请求结构同时参考 [BytePlus 创建任务接口](https://docs.byteplus.com/en/docs/modelark/1520757)和 [Seedance 2.0 Mini 教程](https://docs.byteplus.com/en/docs/ModelArk/2291680)。
