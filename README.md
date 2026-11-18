# TextPort

一个极简的跨设备文字共享工具。在 iPhone、iPad、Mac 或 Windows 上打开同一个私密链接，就能互传文字。两台设备可以先后上线，也可以用不同的网络。

## 怎么用

在一台设备上输入文字并发送，在另一台设备打开或刷新页面即可看到。只保留最近 5 条，点击文字可复制，也可以删除单条或清空历史。

部署后，打开 Worker 地址，在页面输入 `APP_TOKEN` 并保存。也可以把密钥放在私密链接里，方便在自己的设备间使用。

```text
https://textport.example.workers.dev/#token=YOUR_TOKEN
```

请妥善保管密钥和带密钥的链接。

## 在 Cloudflare 控制台部署

整个过程可以在浏览器里完成。

1. 打开 **D1 SQL Database**，新建 `textport_db`。进入这个库的 **Console**，粘贴并执行 [初始化 SQL](migrations/0001_create_messages.sql)。
2. 在 **Workers & Pages** 用 Hello World 模板新建 `textport`。打开 **Edit Code**，用 [Worker 源码](src/worker.js) 替换模板内容，点击 **Deploy**。
3. 在 Worker 的 **Bindings → Add binding → D1 database** 中，变量名填 `DB`，数据库选刚创建的 `textport_db`。
4. 在 **Settings → Variables and Secrets** 添加类型为 **Secret** 的 `APP_TOKEN`，值填自行生成的随机字母数字密钥，再点 **Deploy**。
5. 打开部署生成的 `workers.dev` 地址，输入刚才设置的密钥。

## 费用

可用 Cloudflare 免费计划部署。额度和用量说明见 [Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/)和 [D1 定价](https://developers.cloudflare.com/d1/platform/pricing/)。

## 许可证

[MIT](LICENSE)
