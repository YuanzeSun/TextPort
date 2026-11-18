# TextPort

一个极简的跨设备剪贴板。在 iPhone、iPad、Mac 或 Windows 上打开同一个私密链接，就能互传文字和文件。两台设备可以先后上线，也可以用不同的网络。

## 怎么用

输入文字后点击「发送文字」。传文件时，点击「选择文件」，或在浏览器支持时将剪贴板中的文件或截图粘贴到输入框，再点击「上传文件」。每批最多选择 5 个文件，单个文件上限为 50 MiB。

在另一台设备打开或刷新页面，点击文字即可复制，点击文件旁的「下载」即可保存。文字和文件合计保留最近 5 条。删除单条、清空历史或自动移除较早的记录时，也会清理相应的 R2 文件。

部署后，打开 Worker 地址，在页面输入 `APP_TOKEN` 并保存。也可以把密钥放在私密链接里，方便在自己的设备间使用。

```text
https://textport.example.workers.dev/#token=YOUR_TOKEN
```

请妥善保管密钥和带密钥的链接。

## 在 Cloudflare 控制台部署

整个过程可以在浏览器里完成。

1. 打开 **D1 SQL Database**，新建 `textport_db`。进入这个库的 **Console**，依次执行 [初始化 SQL](migrations/0001_create_messages.sql) 和 [文件迁移 SQL](migrations/0002_add_file_messages.sql)。
2. 在 **Workers & Pages** 用 Hello World 模板新建 `textport`。打开 **Edit Code**，用 [Worker 源码](src/worker.js) 替换模板内容，点击 **Deploy**。
3. 在 Worker 的 **Bindings → Add binding → D1 database** 中，变量名填 `DB`，数据库选刚创建的 `textport_db`。
4. 在 **R2 Object Storage** 新建 `textport-files`，保持存储桶为私有。在 Worker 的 **Bindings → Add binding → R2 bucket** 中，变量名填 `FILES`，选择此存储桶。
5. 在 Worker 的 **Settings → Variables and Secrets** 添加类型为 **Secret** 的 `APP_TOKEN`，值填自行生成的随机字母数字密钥。
6. 在 Worker 中添加 Cron Trigger `0 * * * *`，每小时清理上传中断或删除失败后遗留的 R2 对象。
7. 打开部署生成的 `workers.dev` 地址，输入刚才设置的密钥。

### 升级已有部署

在现有 D1 数据库中执行一次 [文件迁移 SQL](migrations/0002_add_file_messages.sql)，再添加私有 R2 绑定、更新 Worker 源码并添加 Cron Trigger。现有文字和访问密钥会继续使用。

使用 Wrangler 的部署可在现有 `wrangler.jsonc` 中加入 [示例配置](wrangler.example.jsonc) 的 `r2_buckets` 和 `triggers`，运行 `npm run d1:migrate:remote` 后再运行 `npm run deploy`。

## 费用

用量和计费说明见 [Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/)、[D1 定价](https://developers.cloudflare.com/d1/platform/pricing/)和 [R2 定价](https://developers.cloudflare.com/r2/pricing/)。

## 许可证

[MIT](LICENSE)
