local nvchad_lsp = require("nvchad.configs.lspconfig")
local map = vim.keymap.set

local on_attach = function(_, bufnr)
  local function opts(desc)
    return { buffer = bufnr, desc = "TEST " .. desc }
  end

  map("n", "gD", vim.lsp.buf.declaration, opts("Go to declaration"))
  map("n", "gd", vim.lsp.buf.definition, opts("Go to definition"))
  map("n", "gr", vim.lsp.buf.references, opts("Go to references"))
  map("n", "gh", vim.lsp.buf.hover, opts("Hover"))
  map("n", "<leader>D", vim.lsp.buf.type_definition, opts("Go to type definition"))
  map("n", "<leader>rn", require("nvchad.lsp.renamer"), opts("NvRenamer"))
  map("n", "<leader>ca", vim.lsp.buf.code_action, opts("Code action"))
end

dofile(vim.g.base46_cache .. "lsp")
require("nvchad.lsp").diagnostic_config()

vim.api.nvim_create_autocmd("LspAttach", {
  callback = function(args)
    on_attach(nil, args.buf)
  end,
})

vim.lsp.config("*", {
  on_init = nvchad_lsp.on_init,
  capabilities = nvchad_lsp.capabilities,
})

vim.lsp.config("lua_ls", {
  settings = {
    Lua = {
      diagnostics = { enable = false },
      workspace = {
        library = {
          vim.fn.expand("$VIMRUNTIME/lua"),
          vim.fn.expand("$VIMRUNTIME/lua/vim/lsp"),
          vim.fn.stdpath("data") .. "/lazy/ui/nvchad_types",
          vim.fn.stdpath("data") .. "/lazy/lazy.nvim/lua/lazy",
          "${3rd}/love2d/library",
        },
        maxPreload = 100000,
        preloadFileSize = 10000,
      },
    },
  },
})

vim.lsp.config("gopls", {
  on_attach = function(client, _)
    client.server_capabilities.documentFormattingProvider = false
    client.server_capabilities.documentRangeFormattingProvider = false
  end,
  settings = {
    gopls = {
      analyses = { unusedparams = true },
      completeUnimported = true,
      usePlaceholders = true,
      staticcheck = true,
    },
  },
})

local servers = { "lua_ls", "gopls", "pyright", "ts_ls" }
vim.lsp.enable(servers)

return { servers = servers }
