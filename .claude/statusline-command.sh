#!/bin/sh
# Claude Code status line — tokens | 5h subscription % | model

input=$(cat)

# Sum all token components for accurate current context size
tokens=$(echo "$input" | jq -r '
  (.context_window.current_usage |
    if . == null then empty
    else
      (.input_tokens // 0) +
      (.cache_creation_input_tokens // 0) +
      (.cache_read_input_tokens // 0)
    end
  ) // empty
')

# If no API call has been made yet, print nothing
if [ -z "$tokens" ] || [ "$tokens" = "0" ]; then
  exit 0
fi

# Format token count: < 1000 as-is, >= 1000 as Xk (one decimal only when meaningful)
if [ "$tokens" -lt 1000 ]; then
  token_str="$tokens"
else
  # Use awk for float division and smart rounding
  token_str=$(echo "$tokens" | awk '{
    k = $1 / 1000.0
    if (k == int(k)) {
      printf "%dk", k
    } else {
      # One decimal place
      rounded = int(k * 10 + 0.5) / 10.0
      if (rounded == int(rounded)) {
        printf "%dk", int(rounded)
      } else {
        printf "%.1fk", rounded
      }
    }
  }')
fi

# Use 5-hour subscription rate limit usage; fall back to context used % if unavailable
five_pct=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
model=$(echo "$input" | jq -r '.model.display_name // empty')

# Build output segments
seg1=$(printf '\033[33m%s\033[0m' "$token_str")
if [ -n "$five_pct" ]; then
  seg2=$(printf '\033[97m%s%%\033[0m' "$(printf '%.0f' "$five_pct")")
  label="5h"
  printf '%s | %s %s | %s\n' "$seg1" "$(printf '\033[90m%s\033[0m' "$label")" "$seg2" "$(printf '\033[90m%s\033[0m' "$model")"
else
  # No rate limit data yet — omit that segment entirely
  printf '%s | %s\n' "$seg1" "$(printf '\033[90m%s\033[0m' "$model")"
fi
