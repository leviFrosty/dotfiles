local configured = require("configs.lspconfig").servers or {}
local extra = { "tailwindcss" }

local seen, all = {}, {}
for _, list in ipairs({ configured, extra }) do
  for _, s in ipairs(list) do
    if not seen[s] then
      seen[s] = true
      table.insert(all, s)
    end
  end
end

require("mason-lspconfig").setup({
  ensure_installed = all,
  automatic_installation = false,
})
