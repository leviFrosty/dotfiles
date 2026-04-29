---
name: create-work-yml
description: Walk the user through creating a `work.yml` smug config for the current project so they can launch their full dev workstation (editor + tmux panes with all dev servers) with a single `work` command. Use when invoked via /create-work-yml, when the user asks to set up `work` for a project, or when they say their `work.yml` is missing.
---

# create-work-yml

Goal: produce a `work.yml` at the project root that, when consumed by the `work` script, launches the user's complete dev workstation: editor in one window (auto-routed by their tiling window manager) and a tmux session containing all the long-running dev processes for this project.

The script (`work`) runs `smug start -f ./work.yml --attach`. So this skill produces a [smug](https://github.com/ivaaaan/smug) project config tailored to the current repo.

## When to invoke

- User typed `/create-work-yml`.
- User runs `work` in a project with no `work.yml` and accepts the bootstrap prompt.
- User asks to "add work.yml", "set up smug", or similar for the current project.

## What you must do

### 1. Confirm context

- `pwd` — note the project root.
- If `work.yml` already exists, read it and offer two paths: **edit** the existing one, or **regenerate** from scratch. Default to edit.

### 2. Explore the project

Don't ask the user what dev servers exist — go find them yourself. Look for:

- `package.json` at the root and in workspace dirs (check `workspaces` / `pnpm-workspace.yaml` / `lerna.json` / `nx.json` / `turbo.json`). Pull `scripts.dev` (or `start`, `serve`, `watch`) from each.
- `docker-compose.yml` / `compose.yml` — services that should be running before dev (databases, queues, etc.).
- `Procfile`, `Procfile.dev`, `mprocs.yaml`, `.foreman` — explicit lists of dev processes the project already maintains.
- `Makefile` / `justfile` / `mise.toml` / `Taskfile.yml` — recipes named `dev`, `serve`, `up`, `start`.
- Backend frameworks: `manage.py runserver`, `bin/rails s`, `cargo watch`, `air`, `mix phx.server`, `wrangler dev`.
- Mobile: `expo start`, `yarn ios`, `react-native start`.
- A `.envrc` (direnv) or `.tool-versions` (mise/asdf) to know how the shell needs to be set up.
- `README.md` and any `CONTRIBUTING.md` / `docs/` for "Getting started" / "Local development" sections.

Be exhaustive — if there are five dev scripts you missed, the user will discover that the hard way.

### 3. Clarify intent

Do NOT pick layout for the user without asking. Ask focused questions, then draft. Ranked by importance:

1. **Which dev servers should auto-start every time?** Some have side effects (auth flows, tunneling, hot rebuilds that hit external APIs). List every dev script you found and let the user pick a subset. Default suggestion: all of them.
2. **Preconditions** — should we run `docker compose up -d`, DB migrations, seed scripts, or other setup commands before launching the dev panes?
3. **Layout** — single window with N panes (everything visible) or one window per service (cleaner focus, switch with prefix-n/p)? Default: single window, panes.
4. **Extra shells** — does the user want a "scratch" pane at repo root for ad-hoc commands?
5. **Long-running utilities** — DB studio (drizzle/prisma), log tailers, queue dashboards. Yes/no.
6. **Editor** — confirm `WORK_EDITOR` default (`codium`) is right for this project. Some users have project-specific editor preferences.

### 4. Draft the work.yml

Write the smug config. Smug schema reference (the form you'll use most often):

```yaml
session: <name>          # tmux session name; defaults to lowercased dir basename
root: <abs path>         # cwd for all commands; use the project root
on_project_start:        # commands run once before any windows are created
  - pnpm docker:up
windows:
  - name: dev
    root: <abs path>     # optional override; inherits session root
    layout: tiled        # tiled | even-horizontal | even-vertical | main-horizontal | main-vertical
    commands:            # runs in the window's initial pane (pane 1)
      - cd apps/promo-admin
      - pnpm dev
    panes:               # each entry creates an ADDITIONAL pane (panes 2..N)
      - commands:
          - cd apps/promo-api
          - pnpm dev
```

Notes:

- **`root`** should be the absolute project path, not relative.
- **`session`** should be short and unique — usually the repo basename (e.g. `shopify`, not `my-shopify-project-fork`).
- **Pane-count gotcha (important).** Smug always creates one starter pane when the window opens. Window-level `commands:` runs in that starter pane. Each entry in `panes:` adds *another* pane on top. So **N services → window `commands:` for service #1 + (N-1) entries in `panes:`**. Putting all N services in `panes:` produces N+1 panes (one empty starter shell at the top). Verified Apr 2026 with smug 0.3.17.
- Each pane's `commands` is a list. The first command often `cd`s into a workspace dir; the next runs the dev server. Smug runs them in order in the new pane.
- Use `on_project_start` for one-shots (docker up, migrate). It blocks pane creation until done — keep these commands fast.
- The `tiled` layout auto-balances; if the user wants a specific arrangement, suggest `main-vertical` (one big pane, others stacked) or splits via custom layouts.

A reference example is bundled at `resources/work.yml.example` — read it for a complete working sample if you need a template.

### 5. Confirm and write

- Show the user the draft. Ask once if they want changes.
- Write to `<project_root>/work.yml`.

### 6. Verify install

After writing, check:

- `command -v work` exists. If not, the user hasn't installed the launcher script yet. Offer to install it from this skill's `resources/work` to `~/.local/bin/work`:
  ```bash
  install -m 0755 <skill_dir>/resources/work ~/.local/bin/work
  ```
  Confirm `~/.local/bin` is on PATH (it usually is on this user's setup; check `echo $PATH`).
- `command -v smug` and `command -v tmux` — if missing, suggest `brew install tmux smug`.

### 7. Smoke test (optional but valuable)

Offer to do a dry-run that doesn't fight for the user's terminal:

```bash
smug start -f work.yml --detach   # creates the session in the background
tmux ls                            # confirm session exists with right windows/panes
smug stop -f work.yml              # tear it down
```

If the user accepts, run those, report what you saw, then stop.

### 8. Suggest dotfiles tracking

If the user uses the bare-repo dotfiles pattern (alias `dotfiles=git --git-dir=$HOME/.dotfiles --work-tree=$HOME` or similar), suggest:

```bash
dotfiles add ~/.local/bin/work
```

so the launcher syncs to other machines.

## Things to avoid

- Don't invent dev scripts that don't exist in the project. If you can't find a real `scripts.dev` or equivalent, say so and ask.
- Don't include destructive commands (`db:reset`, `clean`, force-push) in `on_project_start`. Preconditions should be idempotent.
- Don't put long-running commands in `on_project_start` — they block. Put them in panes.
- Don't write a config with zero panes. If the project genuinely has nothing to run, ask the user what they want before writing the file.
- Don't overwrite an existing `work.yml` without showing the diff and getting consent.

## Success criteria

- `work.yml` exists at the project root.
- `work` is on PATH.
- Running `work` from the project root launches the editor and a tmux session with the user's expected panes, each running the right dev process.
