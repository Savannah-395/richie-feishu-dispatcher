# richie skills

把你希望 richie 从 GitHub 同步的 Codex skill 放在这个目录下。

目录约定：

```text
skills/
  my-skill/
    SKILL.md
    references/
    scripts/
    assets/
```

每个可用 skill 必须至少包含一个 `SKILL.md`。本机 richie 后台会在启动时同步一次，之后每 10 分钟执行一次：

1. `git pull --ff-only`
2. 扫描 `skills/*/SKILL.md`
3. 镜像到 `%USERPROFILE%\.codex\skills`
4. 飞书里触发 Codex 任务时，把可用 skill 列表写进任务提示

飞书里可以发送 `/skills` 或 `技能列表` 查看当前本机已同步的 skill。

新增 skill 后，在任意电脑上提交并推送：

```bash
git add skills/my-skill
git commit -m "Add my richie skill"
git push
```

本机 richie 最迟 10 分钟后会拉取并安装。
