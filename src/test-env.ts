// Imported first by every test file: imports are hoisted, so env must be set
// in a module of its own before config.ts reads it.
import path from "path";

process.env.DB_PATH = ":memory:";
process.env.CLAUDE_BIN = path.join(__dirname, "claude", "__fixtures__", "fake-claude.sh");
delete process.env.ANTHROPIC_API_KEY;
