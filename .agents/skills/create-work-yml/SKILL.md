---
name: create-work-yml
description: "Walk the user through creating a `work.yml` smug config for the current project so they can launch their full dev workstation (any GUI startup programs they want — editor, browser tabs, design tools, etc. — plus tmux panes with all dev servers) with a single `work` command. Terminal- and OS-agnostic: asks the user what they actually use rather than assuming. Use when invoked via /create-work-yml, when the user asks to set up `work` for a project, or when they say their `work.yml` is missing."
---

# create-work-yml

Goal: produce a `work.yml` at the project root that, when consumed by the `work` script, launches the user's complete dev workstation: any GUI startup programs they want (editor, browser tabs, design tool, chat app — whatever they reach for first) plus a tmux session containing all the long-running dev processes for this project.

The script (`work`) runs `smug start -f ./work.yml`. Outside tmux it uses `--attach` (creates/attaches the session normally, and smug runs `on_project_start`). Inside an existing tmux session it uses `--inside-current-session` and then *takes over the current window*: it builds the project's windows in your current session, folds the terminal you ran `work` from into the project's main window as a scratch pane (preserving your shell and scrollback), and drops the window you came from — so the project never spawns a separate, nested session. So this skill produces a [smug](https://github.com/ivaaaan/smug) project config tailored to the current repo.

This skill is **terminal- and OS-agnostic**: don't assume a specific editor, terminal emulator, shell, window manager, or install location. Ask the user what they actually use and shape the config to that.

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

Do NOT pick layout or startup programs for the user without asking. Ask focused questions, then draft. Ranked by importance:

1. **Which dev servers should auto-start every time?** Some have side effects (auth flows, tunneling, hot rebuilds that hit external APIs). List every dev script you found and let the user pick a subset. Default suggestion: all of them.
2. **Preconditions** — should we run `docker compose up -d`, DB migrations, seed scripts, or other setup commands before launching the dev panes?
3. **Startup programs (editor + extras)** — what GUI apps should open alongside the tmux session? Don't assume an editor; ask what they use. Then ask what *else* they want auto-launched for this project — for example:
   - Browser windows pointed at local URLs (`http://localhost:3000`, an admin panel, a staging dashboard)
   - A second browser profile or incognito window for testing
   - DB clients (TablePlus, DBeaver, Postico)
   - API clients (Postman, Insomnia, Bruno)
   - Design tools (Figma desktop), chat apps (Slack, Discord), docs (Notion)
   - Anything else they consistently open when starting work on this project
   These commands go into `on_project_start` and **must detach immediately** (trailing `&`, or use a launcher like macOS `open -a` / Linux `xdg-open` / Windows `start` that returns right away). Terminal-based editors (vim, nvim, helix) belong in a tmux pane instead, not `on_project_start`.
4. **Layout** — single window with N panes (everything visible) or one window per service (cleaner focus, switch with prefix-n/p)? Default: single window, panes.
5. **Scratch pane** — do NOT add a dedicated empty scratch pane (`- commands: []`) by default. When `work` runs inside an existing tmux session it folds the terminal you launched it from into the project's main window as a scratch pane — your shell and scrollback, preserved — so a separate empty pane would just duplicate that idle shell. Only add one if the user says they specifically want a scratch shell even when launching `work` from *outside* tmux (the attach path, where nothing gets folded in). If you're editing a work.yml that already has an empty scratch pane, offer to remove it.
6. **Long-running utilities** — DB studio (drizzle/prisma), log tailers, queue dashboards. Yes/no.

**Detect the user's OS** (`uname -s`: Darwin → macOS, Linux → Linux, etc.) so the launch commands you suggest in #3 actually work on their machine. macOS uses `open -a "App Name"` or `open URL`; Linux uses the binary directly (`google-chrome`, `firefox`) or `xdg-open URL`; Windows/WSL uses `cmd.exe /c start`. If you're unsure which form the user wants, ask rather than guess.

### 4. Draft the work.yml

Write the smug config. Smug schema reference (the form you'll use most often):

```yaml
session: <name>          # tmux session name; defaults to lowercased dir basename
root: <abs path>         # cwd for all commands; use the project root
on_project_start:        # commands run once before any windows are created
  - pnpm docker:up
  - codium . &                                                # editor (detached)
  - open -a "Google Chrome" --args --new-window http://localhost:3000 &   # macOS browser
windows:
  - name: <name>
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
- Use `on_project_start` for one-shots: preconditions (docker up, migrate) **and** GUI app launches (editor, browser, etc.). It blocks pane creation until each command returns, so anything long-running needs a trailing `&` to detach. Most native launchers (`codium`, `code`, `cursor`, `subl`, `idea`, macOS `open -a`, Linux `xdg-open`) return immediately on their own; adding `&` is still safer.
- The `tiled` layout auto-balances; if the user wants a specific arrangement, suggest `main-vertical` (one big pane, others stacked) or splits via custom layouts.

A reference example is bundled at `resources/work.yml.example` — read it for a complete working sample if you need a template.

### 5. Confirm and write

- Show the user the draft. Ask once if they want changes.
- Write to `<project_root>/work.yml`.

### 6. Verify install

After writing, check:

- `command -v work` exists. If not, the user hasn't installed the launcher script yet. Don't assume an install location — inspect their PATH (`echo "$PATH" | tr ':' '\n'`) and pick a writable user-owned directory that's already on it. Common candidates, in rough order of preference:
  1. `~/.local/bin` (XDG default, common on Linux and modern macOS setups)
  2. `~/bin` (older convention, still common)
  3. `/usr/local/bin` (system-wide; needs `sudo`, only suggest if the user prefers it)
  Show the user the candidate you found and confirm before installing:
  ```bash
  install -m 0755 <skill_dir>/resources/work <chosen_dir>/work
  ```
  If none of those are on PATH, ask the user which directory they'd like to use (or to add to PATH) rather than picking one yourself.
- `command -v smug` and `command -v tmux` — if missing, suggest installing via the user's package manager. Detect the OS first (`uname -s`) and tailor the suggestion: macOS → `brew install tmux smug`; Debian/Ubuntu → `apt install tmux` (smug usually needs `go install github.com/ivaaaan/smug@latest` or a release binary); Arch → `pacman -S tmux` + AUR for smug; etc. If unsure, just point at the smug README and let the user pick.

### 7. Smoke test

Offer to do a dry-run that doesn't fight for the user's terminal:

```bash
smug start -f work.yml --detach   # creates the session in the background
tmux ls                            # confirm session exists with right windows/panes
smug stop -f work.yml              # tear it down
```

If the user accepts, run those, report what you saw, then stop.

### 8. Suggest dotfiles tracking (only if applicable)

Don't assume the user manages dotfiles, or how. Probe before suggesting:

- Look for a `dotfiles` shell alias (`alias dotfiles 2>/dev/null`) or function — that's the bare-repo pattern.
- Look for known dotfile managers on PATH: `chezmoi`, `yadm`, `stow`, `rcm`, `home-manager`.
- Look for typical dotfiles repos: `~/.dotfiles`, `~/dotfiles`, `~/.config/dotfiles`.

If you find evidence of one of these, suggest the matching command to track the launcher you just installed (substituting the actual install path you chose in step 6):

```bash
# bare-repo pattern
dotfiles add <install_path>

# chezmoi
chezmoi add <install_path>

# yadm
yadm add <install_path>

# stow (the user already knows their package layout — just remind them)
```

If nothing turns up, skip this step entirely. Don't push a dotfiles workflow on a user who isn't using one.

### 9. Ignore work.yml via the user's global gitignore

`work.yml` is a per-developer workstation config — it shouldn't be committed and shouldn't pollute the project's `.gitignore` (other contributors don't use `work`). Use the user's global excludes file instead:

1. If the project isn't a git repo (no `.git` directory), skip this step silently.
2. Run `git check-ignore work.yml` from the project root. Exit 0 → already ignored, you're done.
3. Otherwise, resolve the global excludes file path in this order:
   - `git config --global --get core.excludesFile` (expand `~`)
   - else `${XDG_CONFIG_HOME:-$HOME/.config}/git/ignore` (Git's default on macOS/Linux)
4. 
5. If the resolved file doesn't exist, create it (and parent dirs), but first, Notify the user you're going to make a change to their global git config, removing this work.yml file from tracking. But do NOT set `core.excludesFile` yourself if it wasn't already set; the default path works without config. 
6. If `work.yml` isn't already a line in that file, append it (with a trailing newline). Leave existing entries untouched.
7. Re-run `git check-ignore work.yml` to confirm. If it still doesn't match, tell the user — something unusual is going on (e.g. the project's `.gitignore` has a `!work.yml` re-include) and let them resolve it.

Never touch the project's `.gitignore` for this — that defeats the point of using a global file.

## Things to avoid

- Don't invent dev scripts that don't exist in the project. If you can't find a real `scripts.dev` or equivalent, say so and ask.
- Don't include destructive commands (`db:reset`, `clean`, force-push) in `on_project_start`. Preconditions should be idempotent.
- Don't put long-running *foreground* commands in `on_project_start` — they block. Put dev servers in panes; for GUI launches, ensure they detach (`&` or a launcher that returns immediately).
- Don't assume the user's editor, terminal, shell, window manager, OS, or install paths. Detect (`uname -s`, `command -v`, inspect `$PATH`) or ask. The whole point is that this config follows the user, not the other way around.
- Don't pick startup programs for the user. Suggest categories (browser, DB client, chat, etc.) and let them choose; an empty `on_project_start` is a fine outcome if they don't want any.
- Don't write a config with zero panes. If the project genuinely has nothing to run, ask the user what they want before writing the file.
- Don't overwrite an existing `work.yml` without showing the diff and getting consent.

## Success criteria

- `work.yml` exists at the project root.
- `work.yml` is ignored via the user's global gitignore (not the project's `.gitignore`) so it won't be committed.
- `work` is on PATH (at a location the user explicitly chose).
- Running `work` from the project root launches every startup program the user asked for (editor, browser tabs, etc.) and a tmux session with the expected panes, each running the right dev process.
