# dsh-feed：个性化内容推荐信息流

**把 meow-memory 里的记忆/兴趣变成可刷的推荐流——文字、图片、图文、视频。**

dsh-feed 读取 meow-memory 的记忆，判定哪些值得做成内容，再由 LLM + 图片/视频模型生成四种内容卡片，以滑动信息流呈现。喜欢/跳过反馈会回写兴趣，影响后续生成。

- **双触发**：会话里 `memory_remember` 写入新记忆时即时生成；定时扫描 meow DB 兜底处理。
- **兴趣分类**：先判定一条记忆是否值得做内容，过滤掉无延展性的记忆。
- **四种内容**：纯文本、纯图片、图文、纯视频。
- **兴趣管理**：支持暂停/恢复/重新生成/删除，跳过原因透明展示。
- **反馈聚合**：喜欢/跳过计数回写到对应兴趣。

## 安装

支持 **DSH 0.2.1-rc.2 Web 版**。需要 Node.js `^22.19.0` 或 `>=24.0.0`，并需配置可用 LLM 模型与图片/视频 provider 的 API key。

1. 打开 DSH 左侧 **插件 → 添加插件**。
2. 粘贴 tgz 地址安装：

```text
https://github.com/CC-ICT/dsh-feed/releases/latest/download/dsh-feed.tgz
```

或下载后本地安装：

```sh
dsh plugin --profile web add "/path/to/dsh-feed-0.1.0.tgz"
```

3. 启用插件，重启 `dsh web` 并刷新页面，左侧底部会出现 **✨ 个性化推荐**。

源码版宿主可以用 `pnpm dsh` 替代 `dsh`。升级后重启，原有内容数据继续使用。Release 包已自包含，DSH 运行时仅需提供 `better-sqlite3`。

## 配置

安装后在 DSH 设置界面填写，改后需重启 `dsh web` 生效：

| 配置项 | 说明 | 默认值 |
| --- | --- | --- |
| 图片/视频 provider | `baseUrl` / `apiKey` / `model`，在设置界面配置 | 默认指向内网地址 |
| `llm.provider` / `model` | LLM 服务 | `bailian-coding` / `glm-5.2` |
| `scanIntervalMinutes` | 定时扫描间隔 | `10` |
| `maxGeneratePerScan` | 每次扫描最多生成几条 | `3` |
| `regenIntervalHours` | 同一兴趣多久后可再生成 | `12` |

> 默认图片 provider 指向内网地址，仅在内网/VPN 下可用。非内网机器请在设置里改用公网 provider 并填入对应 API key。未配置 key 时图片/视频生成会跳过，纯文本生成不受影响。

## 怎么使用

1. 点击左下角 **✨ 个性化推荐** 进入信息流，上下滑动浏览。
2. 点 **喜欢** / **跳过**，反馈会聚合到对应兴趣。
3. 切到 **兴趣** 标签查看全部兴趣，可暂停 / 恢复 / 重新生成 / 删除。
4. 内容由 meow-memory 记忆驱动：在对话里让模型记下你的兴趣或偏好，dsh-feed 会即时生成。

## 数据

- 内容与兴趣数据保存在 `~/.dsh-feed/feed.db`。
- 生成的图片、视频落在 `~/.dsh-feed/images/`、`~/.dsh-feed/videos/`。
- 停用或卸载插件不会主动删除数据；备份迁移时请保留该目录。

## 仓库结构

| 路径 | 作用 |
| --- | --- |
| `lib/index.js` | 插件入口 |
| `lib/client.js` | 预编译 Web 界面 |
| `cordis.patch.yml` | DSH bundle 配置 |
| `src/` | TypeScript 源码，供阅读与二次开发 |
| `build.mjs` | 构建脚本 |

## License

[MIT](LICENSE)。
