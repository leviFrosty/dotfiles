// Prompt guidance and tool description for the context agent tool.

export const toolDescription =
  "Get detailed context usage information for the current session — token breakdown, context window, compaction state, injected files, guideline sources, and more.";

export const promptSnippet =
  "context — context usage report (token breakdown, context window)";

export const promptGuidelines = [
  "Use context to check context window usage when approaching limits or after large tool results.",
  "Use context before large operations to gauge remaining context window capacity.",
  "Prefer context over asking the user to run /context — it gives you the same data directly.",
];
