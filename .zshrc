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

#### -------------------------------------------------
#### 2. Aliases (from your original config)
#### -------------------------------------------------
alias ls='eza --all --icons'
alias lsl='eza --all --header --git --icons --long --no-permissions'
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

#### -------------------------------------------------
#### 3. Environment & Editor
#### -------------------------------------------------
export EDITOR="nvim"

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
# znap source marlonrichert/zsh-autocomplete
# Initializes p10k theme
[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh
