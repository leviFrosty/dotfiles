# Dotfiles

## Get dotfiles setup on another machine:

[Homebrew](https://brew.sh/) must be installed already.

```shell
alias dotfiles='/usr/bin/git --git-dir=$HOME/.dotfiles/ --work-tree=$HOME'
git clone --bare git@github.com:leviFrosty/dotfiles.git $HOME/.dotfiles
dotfiles config --local status.showUntrackedFiles no
dotfiles checkout
brew bundle --file=~/Brewfile
source ~/.zshrc
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

## Install Sketchybar from FelixKratz

[Source](https://github.com/FelixKratz/dotfiles/tree/master)

```shell
curl -L https://raw.githubusercontent.com/FelixKratz/dotfiles/master/install_sketchybar.sh | sh
```
