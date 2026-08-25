# richie Feishu dispatcher

这是本机给飞书机器人 `richie` 跑的后台。它只负责飞书长连接、消息路由、本机 Codex CLI 执行、以及把 GitHub 上可读的项目 repo 同步到本机后加载 skills。

重要：`richie-feishu-dispatcher` 是 runner 仓库，不是业务项目仓库。业务项目应该是和它同级的独立 GitHub repo，这样 GitHub 权限可以按 repo 分别开给不同的人。

推荐结构：

```text
GitHub / Savannah-395
  richie-feishu-dispatcher        # 本仓库，只运行后台
  amazon-spc-wall-panel           # 一个业务项目 repo
  supplier-pricing                # 另一个业务项目 repo
```

本机结构会被 richie 自动同步成：

```text
workspace/
  richie-feishu-dispatcher/
  amazon-spc-wall-panel/
    PROJECT.md
    skills/
      research/
        SKILL.md
        references/
        scripts/
        assets/
  supplier-pricing/
    PROJECT.md
    skills/
      quote-check/
        SKILL.md
```

richie 每 10 分钟会：

1. `git pull --ff-only` 更新 `richie-feishu-dispatcher` 自己。
2. 从 `RICHIE_GITHUB_PROJECT_OWNER` 下发现 richie 可读的项目 repo。
3. 本机没有的项目 repo 自动 clone 到同级目录，已有的项目 repo 自动 pull。
4. 扫描每个项目的 `skills/<skill-name>/SKILL.md`。
5. 把 skill 安装到本机 Codex skills，命名为 `<project-name>--<skill-name>`。

飞书里调用时使用：

```text
<project-name>/<skill-name>
```

这样不同项目都可以有 `research`、`report` 这类同名 skill，不会互相覆盖。如果只说 `research` 且多个项目都有，richie 应该先问你用哪个项目。

## 项目 repo 规范

每个业务项目 repo 至少放：

```text
PROJECT.md
skills/
  your-skill-name/
    SKILL.md
```

如果某个飞书群固定属于一个项目 skill，在项目 repo 里放：

```text
deploy/richie/allowed-chats.json
```

最简单格式：

```json
{
  "allowed_chat_ids": ["oc_xxxxxxxxxxxxxxxxxxxx"]
}
```

当项目只有一个 skill 时，dispatcher 会把这些群里的消息直接路由到这个 skill；没有命中群聊或显式 skill 的消息，才回到普通回复兜底。

可以从本仓库的模板复制：

```text
templates/project/
```

AmandaYYL 或其他协作者只需要被授予对应业务项目 repo 的写权限，然后从自己的电脑 push 到那个项目 repo。本机 richie 会通过同步任务自动拉取，不需要他们登录这台机器。

## 配置

复制 `.env.example` 到 `.env` 并填写密钥。当前推荐同步配置：

```env
RICHIE_GIT_SYNC_ENABLED=true
RICHIE_GIT_SYNC_INTERVAL_SECONDS=600
RICHIE_PROJECT_ROOTS=..
RICHIE_GITHUB_PROJECT_OWNER=Savannah-395
RICHIE_GITHUB_AUTO_DISCOVER_PROJECT_REPOS=true
RICHIE_GITHUB_PROJECT_REPOS=
RICHIE_GITHUB_PROJECT_CLONE_ROOT=..
RICHIE_INSTALL_CODEX_SKILLS=true
```

如果不想自动发现所有可读 repo，可以关闭自动发现，并显式列项目：

```env
RICHIE_GITHUB_AUTO_DISCOVER_PROJECT_REPOS=false
RICHIE_GITHUB_PROJECT_REPOS=Savannah-395/project-a,Savannah-395/project-b
```

私有 repo 的发现优先使用 `GITHUB_TOKEN` / `GH_TOKEN`；如果没有环境变量，会尝试读取本机 Git Credential Manager 里已有的 GitHub 凭据。clone 和 pull 不会把 token 写进仓库。

回复策略默认分两层：

- 指定 skill 群：只要命中 `deploy/richie/allowed-chats.json` 或 skill description 里的 `chat_id`，不用 @，直接走该 skill。
- 非指定 skill 群：话题第一条消息必须 @ richie，后续同一话题内继续交互不需要重复 @。

项目 Skill 可以使用自己的 Card 2.0 发送器。Dispatcher 会为每个 Codex 任务注入
`RICHIE_NATIVE_REPLY_MARKER=<run>/native-reply.json`；项目发送器只有在飞书确认发送成功后才写入该标记。
标记存在时，Dispatcher 只记录任务状态，不再补发“任务已完成/未完成”卡。这样候选分页、澄清卡、错误卡和交付卡
不会再跟一张无业务价值的外层完成回执。

```env
BOT_REQUIRE_MENTION_TO_START=true
BOT_REQUIRE_MENTION_TO_REPLY=false
```

Windows 上必须固定 Python/Codex 的 UTF-8 运行环境，否则飞书前台可能把中文渲染成问号：

```env
PYTHONUTF8=1
PYTHONIOENCODING=utf-8
```

`scripts/start-richie-background.ps1` 会在启动前执行 `chcp 65001` 并设置上述环境变量。

## 启动

```powershell
npm install
npm run check
npm run start
```

后台启动：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-richie-background.ps1
```

重启已存在的 bot 进程：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-richie-background.ps1 -Restart
```

手动同步一次：

```powershell
npm run sync:once
```

飞书里查看当前已发现 skill：

```text
/skills
```

或：

```text
技能列表
```

## 飞书后台

需要开启：

- 应用能力：机器人
- 事件订阅：长连接
- 事件：`im.message.receive_v1`
- 权限：接收群消息、发送消息、上传/下载资源、表情回应
- 把机器人 `richie` 拉进目标群

如果只希望在特定群里工作，设置 `BOT_ALLOWED_CHAT_IDS`。

## Dispatcher routing and audit

Group messages are checked against dispatcher skill routes first. If a project skill is mapped to the Feishu group `chat_id`, Richie runs that project skill without requiring an @ mention. If no project skill matches, the normal mention policy applies: the first message in a topic must @ richie, then follow-up messages in that active topic do not need another @.

Preferred project-side mapping:

```markdown
# wall-panel-market-research
description: Used for Feishu group oc_xxxxxxxxxxxxxxxxxxxx to run wall panel market research.
```

The dispatcher also supports explicit project config:

```json
{
  "allowed_chat_ids": ["oc_xxxxxxxxxxxxxxxxxxxx"]
}
```

Audit group configuration is local-only:

```env
RICHIE_AUDIT_ENABLED=true
RICHIE_AUDIT_CHAT_ID=oc_xxxxxxxxxxxxxxxxxxxx
RICHIE_AUDIT_MAX_MESSAGE_CHARS=2000
```

When audit is enabled, Richie sends a start message with the user request, selected skill, route source, plan, run directory, and queue snapshot. When the task finishes, Richie replies under that audit message with the final response preview, artifacts, status, and updated queue snapshot. The audit group is output-only, so messages inside it do not trigger work.
