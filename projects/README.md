# richie projects

richie 的 GitHub 仓库按项目分文件夹。每个项目有自己的说明、skills、脚本、参考资料和资产，避免多个业务项目之间互相串上下文。

推荐结构：

```text
projects/
  <project-name>/
    PROJECT.md
    skills/
      <skill-name>/
        SKILL.md
        references/
        scripts/
        assets/
    references/
    scripts/
    assets/
```

规则：

- 一个项目一个目录，例如 `amazon-spc-wall-panel`、`supplier-pricing`、`meeting-summary`。
- 一个 skill 必须放在某个项目下面：`projects/<project-name>/skills/<skill-name>/SKILL.md`。
- 不同项目可以有同名 skill，例如 `projects/a/skills/research` 和 `projects/b/skills/research`。
- richie 安装到本机 Codex 时会自动加项目作用域：`<project-name>--<skill-name>`。
- 飞书里要调用时尽量说清项目，例如“用 `amazon-spc-wall-panel/research` 调研...”。
- 如果只说了 skill 名而多个项目都存在，richie 应该先问你用哪个项目。

复制 `projects/_template` 创建新项目。
