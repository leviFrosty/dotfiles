# -- START PERSONAL CUSTOMIZATIONS -- 
# Source zsh plugins
source $(brew --prefix)/share/zsh-fast-syntax-highlighting/fast-syntax-highlighting.plugin.zsh
source $(brew --prefix)/share/zsh-autosuggestions/zsh-autosuggestions.zsh

alias ls='ls -a --color'
alias src='source ~/.zshrc'
alias dotfiles="/usr/bin/git --git-dir=$HOME/.dotfiles/ --work-tree=$HOME"
alias vim="nvim"

# Color Scheme
export BLACK=0xff181819
export WHITE=0xffe2e2e3
export RED=0xfffc5d7c
export GREEN=0xff9ed072
export BLUE=0xff76cce0
export YELLOW=0xffe7c664
export ORANGE=0xfff39660
export MAGENTA=0xffb39df3
export GREY=0xff7f8490
export TRANSPARENT=0x00000000
export BG0=0xff2c2e34
export BG1=0xff363944

# -- END PERSONAL CUSTOMIZATIONS -- 

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
