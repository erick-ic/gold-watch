# GoldWatch 部署 SOP

按本文步骤顺序执行即可完成上线。文中出现的名称全部是虚构示例，替换规则如下：

| 示例值 | 来源与替换规则 |
| --- | --- |
| `demo.com` | **示例域名**，替换成你自己的域名（如 `example.com`） |
| `goldwatch.demo.com` | **API 域名** = 子域前缀 `goldwatch` + 你的域名。前缀可自选，取 `goldwatch` 是为与项目名一致、好记；想换别的（如 `api`）全程统一替换即可 |
| `goldwatch-api` | **Worker 名称**，来自 `wrangler.toml` 的 `name = "goldwatch-api"`，是 Cloudflare 上这个服务的名字，不用改 |
| `demo-user` | **GitHub 用户名**，替换成你自己的（如 `octocat`），决定 Pages 地址 `demo-user.github.io/gold-watch/` |
| `203.0.113.10` | **示例服务器 IP**（RFC 5737 保留地址，专用于文档），替换成你网站服务器的真实 IP |

派生关系：`goldwatch.demo.com` 中的 `demo.com` 必须与你的域名一致，`goldwatch` 前缀与 Worker 名称 `goldwatch-api` 相互独立，改名时各管各的。

踩坑记录、关键决策与故障排查见 [DEPLOY-NOTES.md](DEPLOY-NOTES.md)，遇到异常先去查，不要跳步。

## 目标架构

```
手机/电脑浏览器（PWA）
  │  HTTPS 轮询 /api/quotes、/api/history
  ▼
GitHub Pages 静态前端（demo-user.github.io/gold-watch/）
  ▼
Cloudflare Worker（自定义域名 goldwatch.demo.com）
  ▼
新浪财经 / 东方财富 / 京东金融 / gold-api.com
```

## 前置条件

- [ ] Cloudflare 账号（免费计划）
- [ ] 一个自有域名 `demo.com`，DNS 目前托管在注册商（如阿里云）
- [ ] GitHub 账号 `demo-user`，空仓库 `gold-watch` 已创建
- [ ] Node.js ≥ 20.11，项目已 `npm install`

## 步骤 1：部署 Worker

```bash
npx wrangler login        # 首次使用，浏览器授权
npm run deploy:api
```

**预期输出**：终端依次显示 `Uploaded goldwatch-api` 和 `Deployed goldwatch-api triggers` 即部署成功。此处无需单独验证 API——服务是否可用统一在步骤 4 通过自定义域名验证。

## 步骤 2：域名接入 Cloudflare

### 2.1 添加站点

1. Cloudflare 控制台 → **Add a domain** → 输入 `demo.com` → **Continue**
2. 计划选 **Free** → **Continue**
3. AI 爬虫策略页保持默认 → **Continue**

### 2.2 重建 DNS 记录

进入 **Review DNS records** 页面后，**忽略扫描结果**（经常漏记录），对照现有 DNS 服务商的记录逐条重建：

| 类型 | 名称 | 值 | 云朵 |
| --- | --- | --- | --- |
| A | `@` | `203.0.113.10` | 灰 |
| A | `www` | `203.0.113.10` | 灰 |
| A | `feed` | `203.0.113.10` | 灰 |
| A | `*` | `203.0.113.10` | 灰 |
| TXT | `@` | `google-site-verification=...`（如有） | 灰 |

操作：点 **Add record** → Type/Name/Content 如上 → **Save**。已有网站的所有记录必须齐全，漏一条对应服务就断。

**纪律：先在本页建齐所有记录，再去 2.3 换 NS，顺序不可反。**

### 2.3 切换 DNS 服务器

1. 本页点 **Continue to activation**，记下两个 NS 地址（`xxxx.ns.cloudflare.com`）
2. 去域名注册商控制台（阿里云：域名 → 管理 → **DNS服务器**）改为这两个地址
3. 若注册商要求 DNS 授权校验，按其提示添加 TXT 记录

### 2.4 等待生效

Cloudflare 站点列表中该域名状态变为绿色 **Active**（几分钟到几小时）。期间旧解析继续工作，网站无感。

**验证**：

```bash
nslookup demo.com
```

返回 `203.0.113.10` 即解析正常（灰色云朵下流量仍直连原服务器）。

## 步骤 3：绑定 Workers Custom Domain

1. Cloudflare → **Workers & Pages** → `goldwatch-api`（Worker 名称）→ **Settings → Triggers → Custom Domains → Add Domain**
2. 输入 `goldwatch.demo.com`——即在 `demo.com` 前加子域前缀 `goldwatch`（前缀可自选，见开头对照表）→ 确认
3. 出现 "not fully protected" 提示时点 **I'll do this later**（橙色云朵仅用于主站时才需要避开，见 NOTES）

**预期**：1–2 分钟后 Custom Domains 列表出现该域名，证书自动签发。

## 步骤 4：验证 API（电脑 + 手机）

```bash
curl https://goldwatch.demo.com/api/health    # {"ok":true,...}
curl https://goldwatch.demo.com/api/quotes    # 四类行情齐全
```

然后**手机关 Wi-Fi 用流量**访问同一个 health 地址，返回 JSON 才算通过。

**核对点**：`/api/quotes` 中 `xauusd`、`au9999`、`autd`、`zsjcg` 四个品种都有报价、`usdcny` 非空。缺品种说明 Worker 拉取某行情源失败，查 NOTES。

## 步骤 5：发布前端

```bash
echo 'VITE_API_BASE=https://goldwatch.demo.com' > .env.production
npm run deploy:web
```

**预期输出**：构建成功 + `Published`（首次会提示安装 gh-pages，输 `y`）。

**验证**：

```bash
git ls-remote --heads origin gh-pages    # 有输出即推送成功
grep -o 'https://goldwatch.demo.com' dist/assets/*.js    # 确认 API 地址已打进产物
```

## 步骤 6：开启 GitHub Pages

1. 仓库 **Settings → Pages**
2. Source 选 **Deploy from a branch** → 分支 `gh-pages`、目录 `/` → **Save**
3. 顶部出现 `Your site is live at https://demo-user.github.io/gold-watch/` 即成功

首次发布等 1–2 分钟；以后每次 `deploy:web` 推送后 Pages 自动更新，无需再动这里。

## 步骤 7：手机验收与安装

1. 手机浏览器打开 `https://demo-user.github.io/gold-watch/`，行情卡片实时跳动
2. iOS：Safari → 分享 → **添加到主屏幕**；Android：Chrome → 菜单 → **安装应用**

完成。

## 后续更新

| 改动 | 命令 |
| --- | --- |
| 界面/前端逻辑 | `npm run deploy:web` |
| API/数据源逻辑 | `npm run deploy:api` |
| 发布前自检 | `npm run typecheck && npm test && npm run build:web` |

本地开发不受影响：`npm run dev` 仍是 Express + Vite 代理。
