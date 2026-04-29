# Dotfiles

## Prerequisites

- [Homebrew](https://brew.sh/)
- [JetbrainsMono Nerd Font](https://github.com/ryanoasis/nerd-fonts/releases/download/v3.4.0/JetBrainsMono.zip)


## Get dotfiles setup on another machine:


```shell
alias dotfiles='/usr/bin/git --git-dir=$HOME/.dotfiles/ --work-tree=$HOME'
git clone --bare https://github.com/leviFrosty/dotfiles.git $HOME/.dotfiles
dotfiles config --local status.showUntrackedFiles no
dotfiles checkout
brew bundle --file=~/Brewfile
source ~/.zshrc
```

Aside: how to open Lazygit in dotfiles bare git repo

```shell
lazygit --git-dir=$HOME/.dotfiles --work-tree=$HOME
```

If some of the dotfiles are already present, you will see errors.

```
error: The following untracked working tree files would be overwritten by checkout:
 .bashrc
Please move or remove them before you switch branches.
Aborting
```

Remove or backup any collisions and repeat the checkout

```shell
mv ~/.zshrc ~/.zshrc_backup
dotfiles checkout
```

## Add new files to dotfiles

```shell
dotfiles add ~/.config/aerospace/**
dotfiles push
```

## Syncing from other machine

```shell
dotfiles pull
```

## Dump brew bundle into a file

```shell
brew bundle dump --describe --file=~/Brewfile --force
```

## Install brew bundle

```shell
brew bundle --file=~/Brewfile
```

## Install Sketchybar from FelixKratz (No longer used)

Due to visual conflicts with the native MacOS menu bar, I removed Sketchybar. I have the MacOS menu bar set to autohide.

[Source](https://github.com/FelixKratz/dotfiles/tree/master)

```shell
curl -L https://raw.githubusercontent.com/FelixKratz/dotfiles/master/install_sketchybar.sh | sh
```

## tmux

A `work` command launches the project's dev workstation: editor + a tmux session full of dev servers, all configured per-project by a `work.yml`. Session orchestration is handled by [smug](https://github.com/ivaaaan/smug). Custom config is in `~/.tmux.conf`; the launcher is `~/.local/bin/work`.

### Setup (new machine)

```shell
brew install tmux smug
# Ensure ~/.local/bin is on PATH (it's already on this machine; verify on a new one):
echo $PATH | tr ':' '\n' | grep -qx "$HOME/.local/bin" || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

### Set up a new project

In any project that doesn't yet have a `work.yml`:

```shell
cd ~/dev/some-project
work
```

When prompted, accept (default `Y`) to launch Claude Code with the `/create-work-yml` skill — it explores the repo, asks intent questions, and writes `work.yml` for you.

To run the skill manually inside an existing Claude session:

```
/create-work-yml
```

### Daily use

```shell
work                            # opens editor + attaches/starts the tmux session for this project
tmux ls                         # list active tmux sessions
tmux a -t <session>             # attach by name
tmux kill-session -t <session>  # kill one session
tmux kill-server                # nuke everything (use after tmux config changes if `prefix r` won't suffice)
```

### Keybindings

Prefix is `Ctrl-b`. Custom bindings live in `~/.tmux.conf`. Reload after edits with `prefix r`.

#### Pane navigation (vim hjkl)

| Keys | Action |
|---|---|
| `prefix h` / `j` / `k` / `l` | Focus pane left / down / up / right |
| `prefix o` | Cycle to next pane |
| `prefix q` then digit | Show pane numbers, jump to one |
| `prefix z` | Zoom (fullscreen) toggle on current pane |

#### Pane resize (vim HJKL — repeatable; hold prefix and tap)

| Keys | Action |
|---|---|
| `prefix H` / `J` / `K` / `L` | Resize pane left / down / up / right by 5 cells |

#### Splits (open in current pane's directory)

| Keys | Action |
|---|---|
| `prefix \|` | Split vertical (left / right) |
| `prefix -` | Split horizontal (top / bottom) |
| `prefix x` | Kill current pane (confirms) |

#### Windows

| Keys | Action |
|---|---|
| `prefix c` | New window (inherits cwd) |
| `prefix n` / `p` | Next / previous window |
| `prefix 0`..`9` | Jump to window by number |
| `prefix ,` | Rename current window |
| `prefix w` | Window picker |
| `prefix Tab` | Last-used window (was `prefix l` by default; remapped because `l` is now pane-right) |
| `prefix &` | Kill current window (confirms) |

#### Sessions

| Keys / Command | Action |
|---|---|
| `prefix d` | Detach (session keeps running in the background) |
| `prefix s` | Session picker |
| `prefix $` | Rename current session |
| `tmux ls` | List sessions (from shell) |
| `tmux a -t <name>` | Attach (from shell) |
| `tmux kill-session -t <name>` | Kill one session |
| `tmux kill-server` | Kill every session and the tmux daemon |

#### Copy mode (vim-style)

| Keys | Action |
|---|---|
| `prefix [` | Enter copy mode |
| `v` | Start selection |
| `Ctrl-v` | Toggle rectangular selection |
| `y` | Copy + exit; pipes through `pbcopy` so the system clipboard gets it |
| `q` or `Esc` | Exit copy mode |

#### Misc

| Keys | Action |
|---|---|
| `prefix r` | Reload `~/.tmux.conf` |
| `prefix ?` | Show every key binding |
| `prefix :` | Tmux command prompt (e.g. `:source-file ~/.tmux.conf`) |

### Editing `work.yml` — pane-count gotcha

Smug auto-creates one starter pane per window. Window-level `commands:` runs in that starter pane; entries in `panes:` add *additional* panes on top. So **N services → window `commands:` for service #1 + (N-1) entries in `panes:`**. Putting all N in `panes:` produces N+1 panes (one empty starter shell at the top).
