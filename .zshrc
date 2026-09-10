# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.zshrc.
# Initialization code that may require console input (password prompts, [y/n]
# confirmations, etc.) must go above this block; everything else may go below.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
 source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

#### -------------------------------------------------
#### 0. SAFETY + SPEED SETTINGS
#### -------------------------------------------------
setopt prompt_subst
setopt no_beep
setopt auto_cd

# Enable zsh caching for completions & `.zwc` bytecode
zstyle ':completion:*' use-cache yes
zstyle ':completion:*' cache-path ~/.zcompcache

# zcompile your config if changed
if [[ ! -f ~/.zshrc.zwc || ~/.zshrc -nt ~/.zshrc.zwc ]]; then
  zcompile ~/.zshrc
fi

#### -------------------------------------------------
#### 1. PATH
#### -------------------------------------------------
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
export PATH="/Users/levi/.codeium/windsurf/bin:$PATH"


#### -------------------------------------------------
#### 2. Aliases (from your original config)
#### -------------------------------------------------
alias devin="devin --permission-mode dangerous"
alias code='codium'
alias oc="opencode"
alias term="ghostty"
alias claude-safe="command claude"
alias claudex="ANTHROPIC_BASE_URL=http://localhost:18765 \
ANTHROPIC_AUTH_TOKEN=unused \
ANTHROPIC_MODEL=gpt-5.6-sol[1m] \
ANTHROPIC_SMALL_FAST_MODEL=gpt-5.6-luna[1m] \
CLAUDE_CODE_AUTO_COMPACT_WINDOW=272000 \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1 \
  claude"
alias claude="command claude --dangerously-skip-permissions"
alias ls='eza --all --icons'
alias lsl='eza --all --header --git --icons --long --no-permissions'
alias ..="cd .."
alias src='source ~/.zshrc'
alias dotfiles="/usr/bin/git --git-dir=$HOME/.dotfiles/ --work-tree=$HOME"
alias vim="nvim"
alias dotfiles='/usr/bin/git --git-dir=$HOME/.dotfiles/ --work-tree=$HOME'
alias note='afplay /System/Library/Sounds/Glass.aiff'
alias find='fd'
alias grep='rg'
alias ga="git add"
alias gc="git commit"
alias gcf="git commit --fixup"
alias gca="git commit --amend"
alias gs="git status"
alias gl="git log --oneline"
alias gp="git push"
alias gpf="git push --force-with-lease"
gbl() {
  for branch in $(git branch -r | grep -v HEAD); do
    local date_info=$(git show --format="%cd %cr" --date=format:'%m/%d/%y' "$branch" | head -n 1)
    # Strip "origin/" prefix but keep "upstream/" prefix
    local display_branch=${branch#origin/}
    echo -e "${date_info}\t${display_branch}"
  done | sort
}
alias unsetAWS='unset $(env | grep AWS | grep -v AWS_REGION | grep -v AWS_DEFAULT_REGION | sed '\''s|=.*||'\'')'
# Music player: focus the dedicated spotatui window, or launch it.
# --title locks the Ghostty window title to "Spotatui".
spot() {
  local win_id
  win_id=$(aerospace list-windows --all --format '%{window-id}|%{window-title}' \
    | awk -F'|' '$2 == "Spotatui" {print $1; exit}')
  if [[ -z $win_id ]]; then
    open -na Ghostty --args --title=Spotatui --window-save-state=never -e spotatui
    # AeroSpace reads the title before Ghostty publishes it, so the
    # on-window-detected rule can miss. Wait for the window and move it here.
    for _ in {1..50}; do
      sleep 0.1
      win_id=$(aerospace list-windows --all --format '%{window-id}|%{window-title}' \
        | awk -F'|' '$2 == "Spotatui" {print $1; exit}')
      [[ -n $win_id ]] && break
    done
    if [[ -z $win_id ]]; then
      echo "spotify: Spotatui window did not appear" >&2
      return 1
    fi
    aerospace move-node-to-workspace --window-id "$win_id" music
  fi
  aerospace focus --window-id "$win_id"
}

#### -------------------------------------------------
#### 3. Key Bindings
#### -------------------------------------------------
bindkey '\e[1;3D' backward-word   # Ctrl+Left  (WezTerm)
bindkey '\e[1;3C' forward-word    # Ctrl+Right (WezTerm)
bindkey '\e[1;5D' backward-word   # Ctrl+Left  (mod=5)
bindkey '\e[1;5C' forward-word    # Ctrl+Right (mod=5)
bindkey '\e[5D'   backward-word   # Ctrl+Left  (alternate)
bindkey '\e[5C'   forward-word    # Ctrl+Right (alternate)
bindkey '\eb'     backward-word   # Ctrl+Left  (VSCodium)
bindkey '\ef'     forward-word    # Ctrl+Right (VSCodium)

#### -------------------------------------------------
#### 4. Environment & Editor
#### -------------------------------------------------
export EDITOR="nvim"

# Claude Code otherwise downgrades truecolor to ANSI-256 inside tmux.
export CLAUDE_CODE_TMUX_TRUECOLOR=1

#### -------------------------------------------------
#### 4. Plugins
#### -------------------------------------------------
# Gets znap if not already installed
[[ -r ~/.zsh/znap/znap.zsh ]] ||
    git clone --depth 1 -- https://github.com/marlonrichert/zsh-snap.git ~/.zsh/znap
source ~/.zsh/znap/znap.zsh
# Loads plugins
znap source romkatv/powerlevel10k
znap source zsh-users/zsh-autosuggestions
znap source zsh-users/zsh-syntax-highlighting
# znap source marlonrichert/zsh-autocomplete
# Initializes p10k theme
[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh

# bun completions
[ -s "/Users/levi/.bun/_bun" ] && source "/Users/levi/.bun/_bun"

# bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
export PATH="$HOME/.local/bin:$PATH"

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion
export PATH="$HOME/.local/bin:$PATH"

# pnpm
export PNPM_HOME="/Users/levi/.local/share/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac
# pnpm end
export PATH=$PATH:$HOME/.maestro/bin

# fzf (key bindings: Ctrl+T files, Ctrl+R history, Alt+C cd; + completion)
# Use fd so fzf respects .gitignore (skips node_modules etc.); --hidden keeps dotfiles
export FZF_DEFAULT_COMMAND='fd --type f --hidden --exclude .git'
export FZF_CTRL_T_COMMAND="$FZF_DEFAULT_COMMAND"
export FZF_ALT_C_COMMAND='fd --type d --hidden --exclude .git'
eval "$(fzf --zsh)"

# Added by LM Studio CLI (lms)
export PATH="$PATH:/Users/levi/.lmstudio/bin"
# End of LM Studio CLI section


# sentry
fpath=("/Users/levi/.local/share/zsh/site-functions" $fpath)

# Tree-scoped .npmrc (a parent-dir .npmrc applies to all subfolders)
source "$HOME/.config/zsh/npmrc-tree.zsh"

# Android / Java toolchain for Tauri
export JAVA_HOME="$HOME/.jdks/jdk-21.0.12+8/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export NDK_HOME="$ANDROID_HOME/ndk/28.2.13676358"
export ANDROID_AVD_HOME="$HOME/.android/avd"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

# tabtab source for packages
# uninstall by removing these lines
[[ -f ~/.config/tabtab/zsh/__tabtab.zsh ]] && . ~/.config/tabtab/zsh/__tabtab.zsh || true

# Vite+ bin (https://viteplus.dev)
. "$HOME/.config/vite-plus/env"

# Switch Claude profiles automatically by directory.
if command -v direnv >/dev/null 2>&1; then
  eval "$(direnv hook zsh)"
fi
