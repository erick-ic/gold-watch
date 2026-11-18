# GoldWatch 部署踩坑记录与决策备忘

本文是 [DEPLOY.md](DEPLOY.md) 的补充：部署中遇到的坑、当时的判断依据、以及上线后的故障排查表。**执行部署时以 SOP 为准，本文仅用于理解原因和排障。** 文中 `demo.com`、`203.0.113.10` 等均为虚构示例值，命名与替换规则见 DEPLOY.md 开头的对照表。

## 一、踩坑记录（2026-11-17 首次上线实录）

### 坑 1：`*.workers.dev` 在国内被 DNS 污染

**现象**：Worker 部署成功（wrangler 返回版本号），但 `nslookup goldwatch-api.demo.workers.dev`（Worker 名.账号子域.workers.dev）连续查询返回 Twitter/Facebook 的 IP（如 `104.244.46.71`、`69.171.224.40`），从未返回 Cloudflare 真实 IP；手机流量完全无法访问；偶尔电脑浏览器能开。

**原因**：浏览器自带 DoH（加密 DNS）绕过了本地 DNS 污染，造成"时好时坏"的假象。污染是持续性的，不是 DNS 未生效。

**结论**：`*.workers.dev` 默认域名在国内**一律不可用**，必须绑自定义域名。诊断要点：多查几次 DNS，单次成功不代表可用；手机和 curl 用的系统 DNS 才是真实表现。

### 坑 2：Cloudflare 扫描 DNS 记录不可靠

**现象**：添加站点时扫描显示 "Records we found: 0"，但该域名实际有在用的网站（5 条有效记录）。

**原因**：Cloudflare 对非自家托管的 zone 扫描经常漏记录，原因不明（可能与注册商 DNS 的 AXFR 限制有关）。

**纪律**：永远手动对照原 DNS 服务商的记录清单重建，扫描结果仅参考。迁移顺序固定为：**新平台建齐记录 → 核对 → 换 NS → 等 Active → 过一段时间再清理旧平台记录**（防 TTL 期内回查旧 NS）。

### 坑 3：已有网站的记录必须保持"灰色 DNS only"

**现象**：Cloudflare 激活后弹窗提示 "not fully protected"，诱导点亮橙色云朵。

**风险**：橙色（Proxied）会把网站流量改道 Cloudflare 境外节点，国内访客访问国内服务器明显变慢甚至超时。

**做法**：现有网站记录保持灰色（DNS only），弹窗点 "I'll do this later"。Worker 的 Custom Domain 由 Worker 路由接管，与云朵设置无关，不用管。

### 坑 4：电脑 VPN 干扰国内直连站点

**现象**：不开 VPN 一切正常，开启后打不开站点。

**原因**：本方案的域名（github.io 与自有域名）在国内均直连可达；开 VPN 后流量绕境外节点，撞上线路质量或分流规则问题。

**解法**：VPN 规则增加直连（Clash 系配置示例）：

```
DOMAIN-SUFFIX,github.io,DIRECT
DOMAIN-SUFFIX,demo.com,DIRECT
```

诊断网络问题时先关 VPN 排除。

## 二、关键决策及依据

### 决策 1：API 用 Cloudflare Worker，不用国内云函数

- 代码零改动：复用 `server/data/` 适配器，`wrangler.toml` 开 `nodejs_compat` 兼容 `process.env`；国内云函数（腾讯云 SCF/阿里云 FC）需要适配层，约半天工作量
- 免费额度充足：个人 5 秒轮询远低于 Workers 每日 10 万次请求限制
- 跨请求状态：Worker 用 module 级变量 + 4s TTL 快照模拟"单例轮询"，避免每次请求都打上游行情源

**曾担心的风险（实测未发生）**：Cloudflare 境外节点拉取新浪/东财/京东接口被限制。实测四类行情齐全。若将来发生，代码里的 gold-api 兜底会自动给出沪金参考换算价，再不行才考虑加备选源——迁平台是最后手段。

### 决策 2：前端用 GitHub Pages，不用 Cloudflare Pages

- 与代码仓库同平台，发布链短（`gh-pages` 分支一条命令）
- `vite.config.ts` 的 `base: './'` 相对路径同时兼容 Pages 项目子路径和将来换域名

### 决策 3：前端生产环境用轮询，不用 SSE

- Cloudflare Workers 免费版不支持长连接流式响应（SSE）给稳定输出，且 Pages 静态站 + Worker API 架构下轮询更简单可靠
- 代码已按此设计：`VITE_API_BASE` 非空时自动切 5 秒轮询；为空（本地开发）仍走 SSE + Vite 代理

### 决策 4：PWA 的 Service Worker 仅生产环境注册

- `import.meta.env.PROD` 判断，避免开发时缓存干扰调试
- SW 策略：静态资源 cache-first + 后台更新，API 请求（`/api`）与非 GET 一律网络直出，不缓存行情数据

## 三、故障排查表

| 症状 | 排查方向 |
| --- | --- |
| 手机打不开 Pages 站点 | Pages 是否选 gh-pages 分支；等 1–2 分钟；换手机网络试 |
| 页面能开但没行情数据 | F12/抓包确认 API 请求地址是 goldwatch.demo.com；浏览器直开 `/api/health`；查 `.env.production` 是否少了 `https://` |
| `/api/health` 通但 `/api/quotes` 慢或缺品种 | Worker 拉取某行情源失败：`lastError` 字段看原因；上游超时为 8s，多源串行最坏情况首请求较慢，属正常 |
| 电脑开 VPN 打不开 | 见坑 4 |
| 桌面图标打开是旧版界面 | Service Worker 缓存：删除图标重新添加，或等 SW 自动更新（下次打开即换新） |
| 主站打不开 | Cloudflare DNS 记录是否被点亮成橙色（应灰色） |
| `nslookup` 返回陌生 IP | 该域名被 DNS 污染；本方案的 API 地址是自定义域名 `goldwatch.demo.com`，不要使用 workers.dev 默认域名 |
| 换了电脑/重装后 `deploy:web` 要重新装 gh-pages | 已固定为 devDependency，重新 `npm install` 即可 |

## 四、遗留的已知限制

- gh-pages 线上产物中必然包含 API 域名（浏览器发起请求所需，无法隐藏）；API 为只读公开行情，无鉴权数据，暴露域名无实际风险。若在意，可在 Worker 加 Origin 校验
- 自定义域名依赖 Cloudflare 托管 DNS；若未来 Cloudflare 国内可达性恶化，备选方案是迁国内云函数（决策 1 的反向路径，工作量约半天）
