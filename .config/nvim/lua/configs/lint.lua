local lint = require("lint")

lint.linters_by_ft = {
  lua = { "luacheck" },
  javascript = { "eslint_d" },
  typescript = { "eslint_d" },
  typescriptreact = { "eslint_d" },
  javascriptreact = { "eslint_d" },
  -- python = { "flake8" },
}

lint.linters.luacheck.args = {
  "--globals",
  "love",
  "vim",
  "--formatter",
  "plain",
  "--codes",
  "--ranges",
  "-",
}

lint.linters.eslint_d.args = {
  "--no-warn-ignored",
  "--format",
  "json",
  "--stdin",
  "--stdin-filename",
  function()
    return vim.api.nvim_buf_get_name(0)
  end,
}

local lint_augroup = vim.api.nvim_create_augroup("lint", { clear = true })

-- Optimized events for better performance:
-- BufWritePost: Lint after saving (natural time for linting)
-- BufEnter: Lint when entering a buffer (less aggressive than BufReadPost)
-- InsertLeave: Lint when leaving insert mode (catches issues during editing)
vim.api.nvim_create_autocmd({ "BufWritePost", "BufEnter", "InsertLeave" }, {
  group = lint_augroup,
  callback = function()
    -- Only lint if the buffer is attached to a file and not a special buffer
    local bufnr = vim.api.nvim_get_current_buf()
    local bufname = vim.api.nvim_buf_get_name(bufnr)
    local buftype = vim.bo[bufnr].buftype

    if bufname ~= "" and buftype == "" then
      lint.try_lint()
    end
  end,
})
