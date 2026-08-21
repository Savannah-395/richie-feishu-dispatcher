# richie Feishu dispatcher

这是本机给飞书机器人 `richie` 跑的后台。它只负责飞书长连接、消息路由、本机 Codex CLI 执行、以及从同级业务项目里发现 skills。

`richie-feishu-dispatcher` 是 runner/基础设施仓库，不是业务项目。业务项目应该和它放在同一层级，可以是独立 GitHub 仓库，也可以是同级文件夹。

推荐本机布局：

```text
workspace/
  richie-feishu-dispatcher/       # 本仓库，只运行后台
  amazon-spc-wall-panel/          # 业务项目仓库/文件夹
    PROJECT.md
    skills/
      research/
        SKILL.md
        references/
        scripts/
        assets/
  supplier-pricing/               # 另一个业务项目仓库/文件夹
    PROJECT.md
    skills/
      research/
        SKILL.md
```

richie 会扫描 `RICHIE_PROJECT_ROOTS` 指定目录下的同级项目，跳过 `richie-feishu-dispatcher` 自己。每个项目的可调用 skill 是：

```text
<project-name>/<skill-name>
```

安装到本机 Codex user skills 时会自动加项目作用域：

```text
<project-name>--<skill-name>
```

这样不同项目都可以有 `research`、`report` 这类同名 skill，不会互相覆盖。飞书里调用时尽量说清项目，例如“用 `amazon-spc-wall-panel/research` 调研美国站 SPC 墙板”。如果只说 `research` 且多个项目都有，richie 应该先问你用哪个项目。

## 目录

```text
src/
  index.js            # 飞书长连接入口和消息路由
  codex-runner.js     # 启动本机 Codex CLI
  skill-sync.js       # git pull + 同级项目 skill 安装
templates/
  project/            # 新业务项目模板，复制到 dispatcher 同级目录使用
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

回复策略默认是话题第一条消息必须 @ richie，后续同一话题内继续交互不用重复 @：

```env
BOT_REQUIRE_MENTION_TO_START=true
BOT_REQUIRE_MENTION_TO_REPLY=false
```

同级项目扫描配置：

```env
RICHIE_GIT_SYNC_ENABLED=true
RICHIE_GIT_SYNC_INTERVAL_SECONDS=600
RICHIE_GIT_REMOTE=origin
RICHIE_GIT_BRANCH=
RICHIE_PROJECT_ROOTS=..
RICHIE_INSTALL_CODEX_SKILLS=true
RICHIE_CODEX_SKILLS_DIR=
RICHIE_SKILL_PREFIX=
```

`RICHIE_PROJECT_ROOTS=..` 表示扫描 dispatcher 父目录下的同级项目。多个根目录可用英文逗号分隔。richie 会对已存在且本身是 git repo 的同级项目执行 `git pull --ff-only`，但不会自动 clone 尚未在本机存在的新仓库。

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

## 同级业务项目工作流

创建新业务项目时，把模板复制到和 dispatcher 同级的位置：

```text
workspace/
  richie-feishu-dispatcher/
  your-project-name/
    PROJECT.md
    skills/
      your-skill-name/
        SKILL.md
```

如果 AmandaYYL 在其他电脑维护项目 repo，他只需要推业务项目仓库；本机这里需要先把该项目 clone 到 dispatcher 同级目录一次。之后 richie 每 10 分钟会自动 pull 已 clone 的同级项目。

手动同步一次：

```powershell
npm run sync:once
```

飞书里查看当前本机已发现的同级项目 skill：

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
