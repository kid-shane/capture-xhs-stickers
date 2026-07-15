# 小红书表情包捕获

一个可移植的 Codex Skill：从小红书公开图文笔记中捕获整组表情包，自动处理常见底部平台水印，逐张检查后按需整批发送到使用者自己的飞书收件群。

> `README.md` 用于介绍和安装；Agent 的实际执行规则以 [`SKILL.md`](SKILL.md) 为准。

## 功能

- 从小红书或 `xhslink` 分享链接解析公开图文笔记中的整组图片。
- 保持原始顺序，保存原图和处理后的本地图片。
- 自动裁掉常见的底部平台水印区域。
- 要求 Agent 在发送前逐张目视检查，避免残留水印或误伤表情内容。
- 可将全部图片或指定编号组成一条批量消息，发送到使用者自行配置的飞书群。
- 运行配置和抓取缓存保存在 Skill 目录之外，便于安全分发。

## 运行要求

- Node.js 20 或更高版本。
- 能执行本地脚本、写入标准输入并查看本地图片的 Agent 平台。
- 可访问小红书公开页面、图片 CDN，以及需要时访问飞书开放平台。
- 自动裁水印当前依赖 macOS 自带的 `/usr/bin/sips`。
- 发送到飞书时需要安装并配置 `lark-cli`。

Linux 或不具备 `/usr/bin/sips` 的托管环境仍可抓取原图，但不会自动裁水印；这种情况下必须由 Agent 逐张检查，确认无水印后才能发送。

## 安装

在 Codex 中，可以将仓库克隆到个人 Skills 目录：

```bash
git clone https://github.com/kid-shane/capture-xhs-stickers.git \
  ~/.codex/skills/capture-xhs-stickers
```

也可以下载仓库后，将整个目录上传到支持 Agent Skill 的平台。执行所需的核心文件是 `SKILL.md`、`agents/`、`references/` 和 `scripts/`；本 README 不参与运行。

安装后检查状态：

```bash
node ~/.codex/skills/capture-xhs-stickers/scripts/run.mjs status
```

## 使用示例

只抓取并检查，不发送：

```text
使用 capture-xhs-stickers 抓取这个小红书链接里的整组表情包，只保存不要发送：<小红书分享链接>
```

检查后发送到飞书收件群：

```text
使用 capture-xhs-stickers 抓取这个链接里的整组表情包，确认无平台水印后发送到我的飞书表情包收件群：<小红书分享链接>
```

也可以指定图片编号，例如只发送第 `1、3、5-7` 张。

选择多张图片时，Skill 会先上传全部图片资源，再按原顺序组成一条飞书富文本消息，因此一组表情通常只产生一个消息气泡；单张图片仍使用原生图片消息。若富文本内容超过飞书 30 KB 上限，才会自动拆成多批。

## 飞书配置

飞书发送使用安装者自己的应用机器人，不使用公共机器人或仓库作者的配置。

1. 使用 `lark-cli config init --new` 配置自己的飞书应用。
2. 在飞书开放平台启用机器人能力，并开通 `im:resource` 和 `im:message:send_as_bot`。
3. 创建自己的私密收件群，将机器人加入群聊。
4. 使用占位的群 ID 配置目标群：

   ```bash
   node <skill-dir>/scripts/run.mjs configure \
     --chat-id oc_xxxxxxxxxxxxxxxxxxxxxxxx \
     --chat-name 表情包收件箱
   ```

完整步骤见 [`references/setup.md`](references/setup.md)。

## 隐私说明

仓库中不包含，也不应提交：

- Webhook、App ID、App Secret、access token 或登录态。
- 真实飞书 `chat_id`、个人用户名或个人绝对路径。
- 小红书分享链接、抓取缓存、图片或访问参数。

当前实现不使用飞书 Webhook。群 ID 写入用户配置目录，飞书凭证由 `lark-cli` 自行管理，不会复制到 Skill 目录。

## 能力边界

- 仅面向可正常访问的小红书公开图文笔记，不用于账号分析或批量内容研究。
- 水印处理采用安全裁切，不会生成式补画被遮挡的内容。
- 作者署名、版权标识或作品内台标不视为平台水印，不应擅自删除。
- 当前自动发送出口是飞书群；不提供微信表情商店或微信个人表情的直接写入接口。
- 请只保存和分享你有权访问、使用的内容，并遵守相关平台规则和版权要求。

## 仓库结构

```text
capture-xhs-stickers/
├── README.md
├── SKILL.md
├── agents/openai.yaml
├── references/setup.md
└── scripts/
    ├── run.mjs
    └── lib/
        ├── runtime.mjs
        └── xhs.mjs
```
