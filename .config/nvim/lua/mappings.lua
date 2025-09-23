require("nvchad.mappings")

-- remove nvchad default binds
local nomap = vim.keymap.del
nomap("n", "<leader>wK")
nomap("n", "<leader>wk")
nomap("n", "<leader>fw")
nomap("n", "<leader>th")

-- add new binds
local map = vim.keymap.set

map("n", ";", ":", { desc = "CMD enter command mode" })
map("i", "jk", "<ESC>")

map("n", "<leader>w", ":w!<enter>", { desc = "Write File" })
map("n", "<leader>q", function()
  vim.cmd("w!")
  require("nvchad.tabufline").close_buffer()
end, { desc = "Write & Quit File" })
map("n", "<leader>t", function()
  require("nvchad.tabufline").closeAllBufs(false)
end, { desc = "Close Other Buffers" })

map("n", "<leader>?a", "<cmd>WhichKey <CR>", { desc = "whichkey all keymaps" })
map("n", "<leader>?s", function()
  vim.cmd("WhichKey " .. vim.fn.input("WhichKey: "))
end, { desc = "whichkey query lookup" })

map("n", "<leader>fg", "<cmd>Telescope live_grep<CR>", { desc = "telescope live grep" })
