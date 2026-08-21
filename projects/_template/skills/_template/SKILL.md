---
name: project-skill-template
description: Template for adding a project-scoped richie skill. Copy this folder, rename it, and replace these instructions.
---

# project skill template

Use this skill only as a template for creating a real project-scoped richie skill.

## When To Use

- The user explicitly names this project and skill.
- The user's task clearly belongs to this project and matches the workflow described here.

## Instructions

1. Confirm the project context before acting if the user's request is ambiguous.
2. Read any project-level context in `../../PROJECT.md` when it matters.
3. Use files under this skill folder for skill-specific references, scripts, and assets.
4. Keep outputs scoped to the current Feishu topic and the requested project.

## Quality Bar

- Do not use a similarly named skill from another project unless the user asks for it.
- Ask which project to use when multiple project skills match.
- Include verification steps when the skill creates or changes files.
