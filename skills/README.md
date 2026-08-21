# legacy richie skills

这个目录只保留给早期的平铺 skill 结构兼容：

```text
skills/<skill-name>/SKILL.md
```

新项目不要放这里。请使用项目级结构：

```text
projects/<project-name>/skills/<skill-name>/SKILL.md
```

richie 会继续扫描本目录，但会把这里的 skill 归到 `legacy/<skill-name>`，并安装成 `legacy--<skill-name>`。为了避免项目混淆，新 skill 一律放到 `projects/`。
