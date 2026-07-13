# TokenHub Seedance 部门工作台

面向部门同事的文生视频工具：账号隔离、API Key自动发现模型、模型联动参数、服务端持久队列、Token与费用统计、管理员后台。

## 支持模型

| 模型 | 分辨率 | 默认输出单价（元/百万Token） |
|---|---|---:|
| `doubao-seedance-2-0-260128` | 1080P / 4K | 51 / 26 |
| `doubao-seedance-2-0-fast-260128` | 480P / 720P | 37 |
| `doubao-seedance-2-0-mini-260615` | 480P / 720P | 23 |

API Key仅保存在Node进程内存，服务器重启后需要重新填写。任务状态、远端任务ID、用量和费用保存在PostgreSQL；系统不会因为重启而重新创建远端任务。

## 本地开发

要求 Node.js 24+、pnpm 10+。开发时可使用内存存储：

```bash
export BOOTSTRAP_ADMIN_USERNAME=admin
export BOOTSTRAP_ADMIN_PASSWORD='ChangeThis123'
pnpm install
pnpm dev
```

- 前端：http://localhost:18080
- 后端：http://localhost:18081

开发内存模式重启会清空账号和任务。完整持久化验证使用 Docker Compose。

## Docker运行

```bash
cp .env.example .env
# 修改.env中的所有密码与加密密钥
docker compose up -d --build
curl http://127.0.0.1:19405/api/health/ready
```

生产环境由Nginx在 `19404` 提供HTTPS，反向代理到仅本机可访问的 `19405`。参考 [`deploy/nginx-seedance.conf`](deploy/nginx-seedance.conf)。PostgreSQL不映射到宿主机或公网。

公网IP证书使用Certbot 5.4以上版本和Let's Encrypt短周期证书。签发前必须确保公网 `80` 端口能访问 [`deploy/nginx-acme.conf`](deploy/nginx-acme.conf) 配置的ACME目录；证书签发成功后安装并启用 `deploy/seedance-certbot-renew.*` 定时续期单元。

若云安全组暂未开放 `80`，不得把登录页降级为明文HTTP。可临时使用 [`deploy/nginx-seedance-selfsigned.conf`](deploy/nginx-seedance-selfsigned.conf) 保持传输加密，但浏览器不会信任自签名证书；开放 `80` 后应尽快切换到受信任证书。

## 管理员

首次启动由 `.env` 中的 `BOOTSTRAP_ADMIN_USERNAME` 和 `BOOTSTRAP_ADMIN_PASSWORD` 创建管理员，首次登录强制修改密码。以后可以在后台创建用户，也可用命令重置管理员：

```bash
ADMIN_PASSWORD='NewTemporary123' pnpm admin:create admin
```

## 验证

```bash
pnpm test
pnpm build
pnpm check
```

测试覆盖身份认证、CSRF、模型发现、Standard 4K、计费、权限隔离、不重复提交，以及100个排队任务下的20并发限制。测试使用模拟TokenHub，不产生真实调用费用。

## 安全边界

- 不在数据库、浏览器存储、响应或日志中保存API Key。
- 管理员只能查看任务元数据和费用，不能查看用户的完整提示词与视频地址。
- 提示词使用AES-256-GCM加密保存，任务明细保留90天。
- 视频文件不经过本服务器代理或落盘。
