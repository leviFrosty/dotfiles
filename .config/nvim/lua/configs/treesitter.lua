local options = {
  ensure_installed = {
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
    "sql",
    "typescript",
    "python",
    "toml",
    "vim",
    "vimdoc",
    "yaml",
    "jsdoc",
    "tsx",
  },

  highlight = {
    enable = true,
    use_languagetree = true,
  },

  indent = { enable = true },

  rainbow = {
    enable = true,
    extended_mode = false, -- only color brackets, not other delimiters
    max_file_lines = nil,
    colors = {
      "#FF0000", -- Red for ()
      "#00FF00", -- Green for []
      "#0000FF", -- Blue for {}
    },
    -- Limit to 1 or 2 nested pairs to mimic VSCode's subtle style
    -- If the plugin supports max_depth or similar, set here (some versions do)
  },
}

require("nvim-treesitter.configs").setup(options)
