# Add deno completions to search path
if [[ ":$FPATH:" != *":/Users/levi/.zsh/completions:"* ]]; then export FPATH="/Users/levi/.zsh/completions:$FPATH"; fi
export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"


# Go pkgsite
export PATH="$HOME/go/bin/:$PATH"

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
. "/Users/levi/.deno/env"

alias ls='ls -a --color'
alias src='source ~/.zshrc'
alias dotfiles="/usr/bin/git --git-dir=$HOME/.dotfiles/ --work-tree=$HOME"
