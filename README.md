# dsh-image-gen

DeepSeek Harness 插件：通过 OpenAI 兼容的 `/images/generations` 接口生成图片。
会话头部加一个「生图」芯片，点开面板可管理 Provider（增/删/改）、默认
Provider 与模型，并快速生成一张测试图（内联预览 + 保存路径）。

## 组成
- `lib/index.js` — 宿主半部：注册 HTTP 中继 `POST /dsh-image/api`，代理调用上游
  图片接口并把返回的图片下载到本地。
- `lib/client.js` — 客户端半部：通过 slots 注入「生图」芯片 + 设置面板。

## 方法（POST /dsh-image/api `{method, args}`）
- `get-config` → `{ok, config}`
- `save-config` `{config}` → 校验后写盘
- `generate` `{prompt, provider?, model?, size?, n?}` → 调上游，下载图片到
  `<outputDir>\<时间戳>-<provider>.<ext>`，返回 `{ok, path, url, bytes, revised_prompt?}`
- `test` `{provider?, model?}` → 固定短提示词的 generate
- `list` → providers + 默认项 + 最近 10 张生成文件

## 配置
全局（非按项目）存于 `~/.dsh/image-gen-config.json`：
`{providers:[{name,baseURL,apiKey,models[]}], defaultProvider, defaultModel, outputDir}`。
文件不存在时自动用内置 seed（zhipu CogView + MiniMax H3，均已验证可用）写入。

## 安装
包体在 `<workspace>/dsh-image-gen`，安装到本 profile 的
`node_modules/dsh-image-gen`，并在 cordis.patch.yml 加 `- insert: - id: dsh-image-gen`。
**重启 harness 后生效。**
