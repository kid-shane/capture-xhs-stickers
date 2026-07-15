# 安装、配置与隐私

## 运行要求

- Node.js 20 或更高版本。
- 能执行本地脚本、向进程标准输入写入链接，并查看本地图片的 Agent 平台。
- 可访问小红书公开页面、图片 CDN 和飞书开放平台。
- 发送到飞书时需要 `lark-cli`，并使用安装者自己的飞书应用机器人。

自动裁掉常见底部平台水印当前依赖 macOS 自带的 `/usr/bin/sips`。Linux 或只读托管沙箱仍可抓取原图，但 `autoCleanupAvailable=false`；此时必须逐张目视确认，仍有水印就停止发送。若平台没有本地图像查看能力，本 Skill 只能抓取，不能安全完成发送流程。

## 飞书初始化

1. 用安装者自己的飞书应用配置 `lark-cli`：

   ```bash
   lark-cli config init --new
   ```

2. 在飞书开放平台启用机器人能力、发布应用，并开通：

   - `im:resource`
   - `im:message:send_as_bot`

3. 创建安装者自己的私密收件群，把应用机器人加入群。取得群 `chat_id` 后配置：

   ```bash
   node <skill-dir>/scripts/run.mjs configure \
     --chat-id oc_xxxxxxxxxxxxxxxxxxxxxxxx \
     --chat-name 表情包收件箱
   ```

   `chat_id` 会写到 Skill 目录之外的用户配置目录。也可以仅通过环境变量注入：

   ```text
   XHS_STICKER_FEISHU_CHAT_ID=oc_xxx
   XHS_STICKER_FEISHU_CHAT_NAME=表情包收件箱
   ```

4. 运行 `node <skill-dir>/scripts/run.mjs status` 检查配置。不要用测试消息验证；首次正式发送会验证最终权限和群成员关系。

## 多图发送方式

- 选择多张图片时，Skill 会先逐张上传飞书图片资源；全部上传成功后，再用一条 `post` 富文本消息按原顺序发出，因此一组表情通常只占一个消息气泡。
- 每张图片在富文本中占一个独立段落。飞书客户端会纵向展示这些图片，这不是原生九宫格相册。
- 单张图片仍使用飞书原生图片消息。只有富文本内容超过飞书 30 KB 上限时，多图才会自动拆成多条批量消息。
- 上传任一图片失败时，不发送可见消息；机器人权限仍只需要 `im:resource` 与 `im:message:send_as_bot`。

## 存储位置

- 配置：`${XHS_STICKER_CONFIG}`；未设置时为用户配置目录下的 `capture-xhs-stickers/config.json`。
- 捕获缓存：`${XHS_STICKER_CACHE_DIR}`；未设置时为用户缓存目录下的 `capture-xhs-stickers/`。
- `lark-cli` 自己管理飞书 App ID、App Secret 和访问令牌；本 Skill 不读取或复制这些凭证。

缓存包含用户抓取的图片、笔记标题、作者、任务 ID 和经过脱敏的来源地址。不要把缓存目录一同上传；不再需要时由安装者自行删除。

## 分发包隐私边界

标准分发包只应包含：

```text
capture-xhs-stickers/
├── SKILL.md
├── agents/openai.yaml
├── references/setup.md
└── scripts/
    ├── run.mjs
    └── lib/
        ├── runtime.mjs
        └── xhs.mjs
```

包内不应包含：

- Webhook URL 或签名密钥；当前实现完全不使用 Webhook。
- App ID、App Secret、access token、tenant token 或用户登录态。
- 真实 `chat_id`、个人用户名、个人绝对路径。
- 抓取缓存、图片、manifest、分享链接或小红书访问参数。

如果目标平台没有 Node.js、本地脚本执行、标准输入、本地图像查看或 `lark-cli`，需要为该平台另写适配器；仅上传 `SKILL.md` 不能获得完整能力。
