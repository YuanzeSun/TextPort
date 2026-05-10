# TextPort

一个极简的跨设备文字共享工具。

主要用于解决Mac（及其他苹果设备）和Windows间传输文本困难的问题。

打开同一个私密链接后，可以在 iPhone、Mac、Windows 之间发送文字，不依赖局域网。

## 功能

- 发送文字
- 查看最近 5 条文字
- 点击任意文字自动复制

## 使用方法

在所有设备上访问同一个私密链接：

```text
https://你的地址.workers.dev/#token=你的私密密钥
```

打开后直接输入文字并点击发送。文字会暂存在云端，其他设备之后再打开同一个链接并点击刷新，就能看到最新内容；两台设备不需要同时在线。点击任意一条文字可以复制；点击清空剪切板会删除当前保存的文字。

只会保留最近 5 条文字。

## 费用

个人使用，Cloudflare Workers Free + D1 Free 通常足够。

截至 2026-05-11，Cloudflare 官方计费规则大致如下：

| 项目 | 免费计划 | 付费计划起点 |
| --- | --- | --- |
| Workers 请求 | 100,000 requests/day | Workers Paid，$5/month 起，包含 10M requests/month |
| Workers CPU time | 每次请求 10 ms CPU time | 每次请求默认 30,000 ms CPU time，可配置 |
| D1 rows read | 5M rows/day | 25B rows/month |
| D1 rows written | 100k rows/day | 50M rows/month |
| D1 storage | 5 GB | 5 GB included，超出后按量计费 |
| D1 数据库数量 | 10 个 | 50,000 个 |

免费计划超过额度后通常不是自动扣费，而是相关请求失败或被限制。具体规则以 Cloudflare 官方计费页为准。

Worker 的 request 按打到 Worker 的 HTTP 请求计算，不按数据库读写次数计算。D1 读写单独计算，主要看 rows read、rows written 和 storage。

常见操作大致对应：

| 操作 | Worker requests | D1 使用 |
| --- | ---: | --- |
| 打开页面且已有 token | 通常 2 次 | 读取最近 5 条 |
| 打开页面但没有 token | 通常 1 次 | 0 |
| 点击刷新 | 1 次 | 读取最近 5 条 |
| 点击发送 | 通常 2 次 | 插入 1 条，删除超出的旧条，再读取列表 |
| 点击清空剪切板 | 通常 2 次 | 删除现有记录，再读取列表 |

如果有爬虫或 AI 扫描裸地址，它会消耗 Worker requests，但正常不会消耗 D1。原因是它没有 `APP_TOKEN`，API 会在进数据库前返回 `Unauthorized`。另外，token 放在 `#token=...` 里，URL fragment 正常不会被浏览器发送到服务器。

本项目已经提供：

- `/robots.txt`：`Disallow: /`
- `X-Robots-Tag: noindex, nofollow`

这些设置能减少守规矩的搜索引擎和爬虫收录，但不能阻止恶意扫描。不要把带 token 的完整链接发布到网页、GitHub、论坛或公开聊天记录。

官方计费文档：

- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/d1/platform/pricing/

## 查看用量

Cloudflare Dashboard 里可以这样看：

- Worker 请求量：`Workers & Pages` -> `textport` -> `Metrics`
- D1 用量：`Storage & Databases` 或 `D1` -> `textport_db` -> `Metrics`
- 账号级可计费用量：`Billing` -> `Billable Usage`

## 准备

你需要：

- 一个 Cloudflare 账号
- 本机安装 Node.js 18 或更高版本
- 一个随机私密密钥

生成密钥可以用：

```bash
openssl rand -hex 32
```

输出类似：

```text
0f3c6c9e9d6a4e5e9c7c7c6c1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c
```

后面把它记作 `APP_TOKEN`。

## 第一次部署

进入项目目录：

```bash
cd TextPort
```

安装依赖：

```bash
npm install
```

登录 Cloudflare：

```bash
npx wrangler login
```

浏览器会打开 Cloudflare 授权页，登录并授权 Wrangler。

创建 D1 数据库：

```bash
npx wrangler d1 create textport_db
```

命令输出里会有类似这样的内容：

```json
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "textport_db",
      "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
    }
  ]
}
```

复制配置模板：

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

打开 `wrangler.jsonc`，把：

```jsonc
"database_id": "REPLACE_WITH_D1_DATABASE_ID"
```

替换成你自己的 `database_id`。

应用数据库迁移：

```bash
npx wrangler d1 migrations apply textport_db --remote
```

设置访问密钥：

```bash
npx wrangler secret put APP_TOKEN
```

它会提示你输入值。粘贴刚才生成的随机密钥，然后回车。

部署：

```bash
npx wrangler deploy
```

成功后会看到 Worker 地址，类似：

```text
https://textport.你的账号.workers.dev
```

最终访问链接是：

```text
https://textport.你的账号.workers.dev/#token=你的私密密钥
```

把这个链接分别在 iPhone、Mac、Windows 打开即可。

## 部署时常见提示

创建 D1 数据库后，如果 Wrangler 问：

```text
Would you like Wrangler to add it on your behalf?
```

选择 `no`。本项目代码使用的绑定名是 `DB`，自动添加通常会用数据库名作为绑定名，容易和代码不一致。只需要手动把输出里的 `database_id` 填到 `wrangler.jsonc`。

设置 `APP_TOKEN` 时，如果 Wrangler 问：

```text
There doesn't seem to be a Worker called "textport". Do you want to create a new Worker with that name and add secrets to it?
```

选择 `yes`。这是第一次部署前的正常提示，它会先创建同名 Worker 并保存 secret。

第一次部署时，如果 Wrangler 问：

```text
Would you like to register a workers.dev subdomain now?
```

选择 `yes`。这是给账号启用默认的 `workers.dev` 访问域名。

部署后看到这些 warning 通常可以忽略：

- `workers_dev is not in your Wrangler file`
- `preview_urls setting is not in your Wrangler file`

它们只是说明 Wrangler 使用了默认配置，不影响这个工具使用。

## iPhone 使用建议

用 Safari 打开最终链接，然后：

```text
分享按钮 -> 添加到主屏幕
```

以后就像一个小 App 一样打开。

## Windows / Mac 使用建议

把最终链接加入浏览器书签。也可以在 Edge / Chrome 里安装为应用：

```text
浏览器菜单 -> 保存并共享 / 应用 -> 将此站点安装为应用
```

不同浏览器菜单名字略有差异。

## 本地预览

本地开发需要先设置 `.dev.vars`：

```bash
APP_TOKEN=你的私密密钥
```

然后应用本地 D1 迁移：

```bash
npx wrangler d1 migrations apply textport_db --local
```

启动本地 Worker：

```bash
npm run dev
```

打开终端里显示的本地地址，并追加 token：

```text
http://127.0.0.1:8787/#token=你的私密密钥
```

## 后续修改

改完代码后重新部署：

```bash
npx wrangler deploy
```

## 其他

超过 5 条的历史记录会被实际从 `messages` 表中删除，不只是前端隐藏。清空剪切板也会删除当前保存的全部文字。

但从当前表里删除不等于云服务层面的不可恢复安全擦除。Cloudflare D1 有 Time Travel/恢复能力，所以不要传输密码、验证码、私钥等高敏感内容。
