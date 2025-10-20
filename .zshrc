# Aliases
alias ls='ls -a --color'
alias ..="cd .."
alias src='source ~/.zshrc'
alias dotfiles="/usr/bin/git --git-dir=$HOME/.dotfiles/ --work-tree=$HOME"
alias vim="nvim"
alias v="vim"
alias c="code"
alias dotfiles='/usr/bin/git --git-dir=$HOME/.dotfiles/ --work-tree=$HOME'
alias note='afplay /System/Library/Sounds/Glass.aiff'
alias find='fd'
alias grep='rg'

# Aliases - Git
alias ga="git add"
alias gc="git commit"
alias gs="git status"
alias gl="git log"
alias gp="git push"

# Set the directory we want to store zinit and plugins
ZINIT_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}/zinit/zinit.git"

if [[ -f "/opt/homebrew/bin/brew" ]] then
  eval "$(/opt/homebrew/bin/brew shellenv)" # Makes any brew installed apps available in home path.
fi

# Download Zinit, if it's not there yet
if [ ! -d "$ZINIT_HOME" ]; then
   mkdir -p "$(dirname $ZINIT_HOME)"
   git clone https://github.com/zdharma-continuum/zinit.git "$ZINIT_HOME"
fi

# Source/Load zinit
source "${ZINIT_HOME}/zinit.zsh"

# Plugins
zinit light zsh-users/zsh-syntax-highlighting
zinit light zsh-users/zsh-completions
zinit light zsh-users/zsh-autosuggestions
zinit light Aloxaf/fzf-tab

# Load completions
autoload -Uz compinit && compinit

zinit cdreplay -q


# History
HISTSIZE=5000
HISTFILE=~/.zsh_history
SAVEHIST=$HISTSIZE
HISTDUP=erase
setopt appendhistory
setopt sharehistory
setopt hist_ignore_space
setopt hist_ignore_all_dups
setopt hist_save_no_dups
setopt hist_ignore_dups
setopt hist_find_no_dups

# Completion styling
zstyle ':completion:*' matcher-list 'm:{a-z}={A-Za-z}'
zstyle ':completion:*' list-colors "${(s.:.)LS_COLORS}"
zstyle ':completion:*' menu no
zstyle ':fzf-tab:complete:cd:*' fzf-preview 'ls --color $realpath'
zstyle ':fzf-tab:complete:__zoxide_z:*' fzf-preview 'ls --color $realpath'

# Autocorrect commands
setopt correct

# Shell integrations
eval "$(fzf --zsh)"

# Track vscode / cursor extensions
if [ "$PWD" = "$HOME" ]; then
  mkdir -p "$HOME/.config"

  # Write extensions to config file
  [ -x "$(command -v code)" ] && code --list-extensions > "$HOME/.config/vscode-extensions.txt"
  [ -x "$(command -v cursor)" ] && cursor --list-extensions > "$HOME/.config/cursor-extensions.txt"
fi

export PATH="$HOME/.local/bin:$PATH"

# Expo Eas CLI
eval 
EAS_AC_ZSH_SETUP_PATH=/Users/levi/Library/Caches/eas-cli/autocomplete/zsh_setup && test -f $EAS_AC_ZSH_SETUP_PATH && source $EAS_AC_ZSH_SETUP_PATH; # eas autocomplete setup

# pnpm
export PNPM_HOME="/Users/levi/Library/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac
# pnpm end

# bun completions
[ -s "/Users/levi/.bun/_bun" ] && source "/Users/levi/.bun/_bun"

# bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

#rust
export RUST_INSTALL="$HOME/.cargo"
export PATH="$RUST_INSTALL/bin:$PATH"

eval "$(starship init zsh)" # Prompt. see https://starship.sh
eval "$(zoxide init --cmd cd zsh)" # Better `cd`. See https://github.com/ajeetdsouza/zoxide
