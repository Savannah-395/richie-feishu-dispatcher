---
name: richie-skill-template
description: Template for adding a new richie skill. Copy this folder, rename it, and replace these instructions.
---

# richie skill template

Use this skill only as a template for creating a real richie skill.

## When To Use

- The user explicitly asks to create a new richie skill.
- You need an example of the required `SKILL.md` structure.

## Instructions

1. Copy `skills/_template` to `skills/<your-skill-name>`.
2. Replace the frontmatter `name` and `description`.
3. Describe when the skill should be used.
4. Add precise workflow steps.
5. Put reusable scripts in `scripts/`, reference docs in `references/`, and assets in `assets/`.

## Quality Bar

- Keep trigger rules specific.
- Make file paths relative to the skill directory.
- Include verification steps when the skill creates or changes files.
