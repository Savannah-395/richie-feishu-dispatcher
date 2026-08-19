# richie Feishu dispatcher

这是本机给飞书机器人 `richie` 跑的后台：通过飞书长连接收消息，在原话题内回复；需要本机文件、截图、表格、代码、或 skill 的任务会转给本机 Codex CLI 执行。

参考压缩包里的 `Lark Claude Plugins`，这里保留核心思路：

- 飞书长连接只作为消息入口，不需要公网回调地址
- 每个飞书话题独立排队，避免同一话题并发串上下文
- Codex 任务在本机执行，产物放进 `logs/codex-runs/<taskId>/artifacts`
- 机器人始终以 `richie` 身份提示，不使用参考项目里的机器人身份
- 仓库里的 `skills/` 每 10 分钟从 GitHub 拉取一次，并镜像到本机 Codex skills

## 目录

```text
src/
  index.js            # 飞书长连接入口和消息路由
  codex-runner.js     # 启动本机 Codex CLI
  skill-sync.js       # git pull + skills 安装
skills/
  _template/          # skill 模板，不会被安装
scripts/
  start-richie-background.ps1
  sync-richie-skills.ps1
```

## 配置

复制 `.env.example` 到 `.env` 并填写：

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`

`BOT_DISPLAY_NAME` 默认是 `richie`。如果飞书后台显示名大小写不同，也建议这里保持同名。

回复策略默认是每条消息都必须 @ richie：

```env
BOT_REQUIRE_MENTION_TO_START=true
BOT_REQUIRE_MENTION_TO_REPLY=true
```

`BOT_REQUIRE_MENTION_TO_REPLY=true` 时，即使一个话题之前已经和 richie 互动过，后续没有 @ 的消息也会被忽略。

GitHub 同步相关默认值：

```env
RICHIE_GIT_SYNC_ENABLED=true
RICHIE_GIT_SYNC_INTERVAL_SECONDS=600
RICHIE_GIT_REMOTE=origin
RICHIE_GIT_BRANCH=
RICHIE_SKILLS_DIR=skills
RICHIE_INSTALL_CODEX_SKILLS=true
RICHIE_CODEX_SKILLS_DIR=
RICHIE_SKILL_PREFIX=
```

`RICHIE_CODEX_SKILLS_DIR` 留空时默认使用 `%USERPROFILE%\.codex\skills`。

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

重启已存在的 `src\index.js` bot 进程：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-richie-background.ps1 -Restart
```

## GitHub skill 工作流

每个 skill 是 `skills/<skill-name>/SKILL.md`：

```text
skills/
  product-research/
    SKILL.md
    references/
    scripts/
    assets/
```

在其他电脑上新增或修改 skill 后：

```bash
git add skills/product-research
git commit -m "Update product research skill"
git push
```

本机 richie 后台会启动即同步一次，之后每 10 分钟执行一次 `git pull --ff-only`。同步后会把有效 skill 镜像到 Codex user skills 目录。

手动同步一次：

```powershell
npm run sync:once
```

飞书里查看当前同步到本机的 skill：

```text
/skills
```

或：

```text
技能列表
```

## 飞书后台需要打开

- 应用能力：机器人
- 事件订阅：长连接
- 事件：`im.message.receive_v1`
- 权限：接收群消息、发送消息、上传/下载资源、表情回应
- 把机器人 `richie` 拉进目标群

如果只希望在特定群里工作，设置 `BOT_ALLOWED_CHAT_IDS`。
