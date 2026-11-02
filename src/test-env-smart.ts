// Like test-env, but with a fake CLI that answers every prompt type sensibly.
import "./test-env";
import path from "path";

process.env.CLAUDE_BIN = path.join(__dirname, "claude", "__fixtures__", "fake-claude-smart.js");
