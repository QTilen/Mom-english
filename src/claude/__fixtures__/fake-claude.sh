#!/bin/sh
# Stand-in for the Claude CLI in tests. FAKE_CLAUDE_REPLY holds the JSON the
# model "returns"; FAKE_CLAUDE_MODE=auth simulates an expired login.
cat > /dev/null
if [ "$1" = "--version" ]; then echo "9.9.9 (fake)"; exit 0; fi
if [ "$FAKE_CLAUDE_MODE" = "auth" ]; then
  echo '{"type":"result","is_error":true,"result":"Failed to authenticate: OAuth session expired"}'
  exit 1
fi
printf '{"type":"result","is_error":false,"result":%s}' "$FAKE_CLAUDE_REPLY"
