local parsers = {
  "bash",
  "go",
  "gomod",
  "gosum",
  "gotmpl",
  "gowork",
  "lua",
  "luadoc",
  "markdown",
  "terraform",
  "html",
  "css",
  "printf",
  "javascript",
  "jsdoc",
  "tsx",
  "typescript",
  "sql",
  "python",
  "toml",
  "vim",
  "vimdoc",
  "yaml",
}

require("nvim-treesitter").install(parsers)

-- The `tsx` parser handles `.tsx` files, which Neovim detects as filetype
-- `typescriptreact`. Register the mapping so vim.treesitter.start() finds it.
vim.treesitter.language.register("tsx", { "typescriptreact" })

vim.api.nvim_create_autocmd("FileType", {
  callback = function(args)
    if pcall(vim.treesitter.start, args.buf) then
      vim.bo[args.buf].indentexpr = "v:lua.require'nvim-treesitter'.indentexpr()"
    end
  end,
})
