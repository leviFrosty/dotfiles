# Get dotfiles setup on another machine:

```shell
alias dotfiles='/usr/bin/git --git-dir=$HOME/.dotfiles/ --work-tree=$HOME'
git clone --bare git@github.com:leviFrosty/dotfiles.git $HOME/.dotfiles
dotfiles config --local status.showUntrackedFiles no
dotfiles checkout
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

# Add new files to dotfiles

```shell
dotfiles add ~/.config/aerospace/**
dotfiles push
```

# Syncing from other machine

```shell
dotfiles pull
```
