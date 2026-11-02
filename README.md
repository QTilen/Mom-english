# Mom English

A calm, adaptive web app that helps a Slovenian speaker practise English **reading and writing** a few minutes a day. The interface and instructions are in Slovenian and the exercises are in English. It runs on a Raspberry Pi on the home LAN, and all AI work goes through the already logged-in **Claude Code CLI**, in the background, using a Claude subscription. It never uses the paid API.

## What it does

- **Placement test (first visit).** About 17–18 adaptive questions on vocabulary, grammar and reading. Each skill has its own staircase: one level up after a correct answer, one down after a wrong one. A "Ne vem" button saves her from guessing. The test ends with 2–3 short writing prompts that Claude grades in the background. The result is a separate CEFR sub-level per skill (Pre-A1, A1.1, A1.2, A1.3, A2.1, A2.2). The estimate is deliberately conservative so the first days feel easy.
- **Daily session, in three screens:**
  1. *Včeraj smo se naučili:* a recap of last time, Claude's feedback on her writing, and 1–2 quick review questions.
  2. Today's exercises.
  3. A celebration screen with her 🔥 streak and what she learned.
- **Exercise types:** multiple choice, fill-in-the-blank, word ordering, matching, short reading with questions, Slovenian→English translation, and free writing. Topics are adult and everyday (shopping, family, doctor, travel, cooking, weather…).
- **Instant, gentle feedback.** Every exercise already contains its answer and a short Slovenian explanation, so she never waits for Claude. Free writing, and translations that don't match a known answer, are graded by Claude in the background. She sees that feedback at the start of her next session.
- **Adaptive levels.** A skill moves up after more than 85% over her last 3 sessions with that skill, and down after less than 50% over the last 2. Each session is weighted towards her weakest skills and recent mistakes.
- **Mistake log and spaced repetition.** Mistakes are logged by category (articles, word order, past simple, specific words…). Weak points come back at 1, 2, 4, 7, 14 and 30 days.
- **Habit building:**
  - Sessions start at 5 minutes. Length is set by the number of exercises, calibrated to her own speed; there is no visible timer.
  - Sessions grow by 3 minutes after 7 sessions completed within 8 days, up to a cap (25 minutes by default).
  - After 3 or more days away, sessions drop back one step.
  - 2 streak freezes per week cover missed days.
- **Progress page** for her, and a **PIN-protected admin page** (`/admin.html`) for you. Admin shows:
  - levels and level history, an accuracy chart, and session history
  - the mistake log and her writing reviews
  - session length, cap, step and freezes, all editable
  - buttons to regenerate tomorrow's session, top up the exercise bank, reset the placement test, and test the Claude CLI
  - background jobs

## How it works

```
Safari (MacBook) ──LAN──▶ Pi :3001  Express + static frontend (vanilla JS, no build step)
                                    ├─ SQLite (data/english.db)
                                    └─ job worker ──▶ claude -p … --output-format json --json-schema …
```

- **Stack:** Node.js + TypeScript, Express 5, `better-sqlite3` and `zod`. The frontend is plain HTML, CSS and JS modules.
- **Session planning (`src/engine/planner.ts`)** is deterministic. It decides how many items, which skills, types, levels and topics, and which weak points to target. Claude only writes the content for those slots, so sessions keep a sensible shape even when they come from the bank.
- **Background jobs (`src/jobs`)** live in a SQLite-backed queue and run one at a time:
  - `generate_session`: runs after each completed session and prepares tomorrow's.
  - `grade_writing` and `grade_translation`.
  - `refill_bank`: tops up the exercise bank at night.
  - Rate limits and failures back off and retry. If generation fails, a session is built instantly from the bank.
- **Claude adapter (`src/claude/run.ts`):**
  - Runs the CLI with tools disabled, in an empty working directory, with `--json-schema`.
  - Validates every reply with zod plus consistency checks (answer index in range, exactly one blank, …) and retries once with the problems listed.
  - Refuses to run while `ANTHROPIC_API_KEY` is set.
- **Fallback bank.** `seed/bank.json` ships 84 hand-written exercises across all six levels, and every exercise Claude generates is added to the bank as well. `seed/placement.json` holds the hand-written placement test.

## Local development (Mac)

```bash
npm install
cp .env.example .env      # set ADMIN_PIN
npm run dev               # http://127.0.0.1:3001, admin at /admin.html
npm test
```

Claude features need a logged-in CLI (`claude`, then follow the login). Without one the app still works: sessions come from the bank, and writing feedback waits until Claude is reachable.

To grow the shipped bank with Claude, run the command below, then review `seed/bank.json` before committing:

```bash
npm run bank:generate
```

For testing streaks and the "yesterday" screen, `DEV_DAY_OFFSET=1` in `.env` makes the app pretend it's one day later. Never set it on the Pi.

## Deploying to the Raspberry Pi (systemd)

This follows the same pattern as the fitness dashboard: a systemd service, LAN-only.

### 1. Prerequisites

- **Node.js 20 or newer** (`node -v`). `better-sqlite3` 12 doesn't support Node 18. If the Pi still has Ubuntu's Node 18, install Node 22 from NodeSource:
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt install -y nodejs build-essential
  ```
  > ⚠️ Upgrading Node also affects the fitness app. Rebuild its native module afterwards:
  > `cd ~/fitness-repository/server && npm rebuild better-sqlite3 && sudo systemctl restart fitness-app`
- `build-essential`, already present from the fitness app. `better-sqlite3` compiles from source on the Pi, which takes a few minutes.

### 2. Claude Code CLI, logged in with your subscription

```bash
curl -fsSL https://claude.ai/install.sh | bash     # or: npm install -g @anthropic-ai/claude-code (check current docs)
claude                                            # follow the login prompt; choose your Claude subscription, NOT an API key
claude -p "say pong" --output-format json          # should print a JSON result with "is_error": false
echo "${ANTHROPIC_API_KEY:-unset}"                 # must print "unset"
```

On a Pi without a screen, the login prints a link. Open it on your Mac and paste the code back into the terminal. The login is stored in `~/.claude/`. The service runs as the same user, so it uses that login directly. If the login ever expires, run `claude` again. The admin page shows the CLI's status and has a **Preizkusi Claude** (test Claude) button.

### 3. Get the code and configure

```bash
cd ~
git clone git@github.com:QTilen/mom-english.git
cd mom-english
npm ci
npm run build
cp .env.example .env
nano .env        # HOST=192.168.1.111 (the Pi's LAN IP), PORT=3001, ADMIN_PIN=<your PIN>
```

### 4. LAN-only access

The app listens only on the address in `HOST`. On the Pi this must be its LAN IP, never `0.0.0.0`. Then allow the port from the LAN only:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 3001 proto tcp
sudo ufw status numbered
```

**Do not** add a port forward for 3001 on the router, and don't put it behind any public reverse proxy.

### 5. Run it as a service

```bash
sed -i "s/YOUR_USER/$USER/g" deploy/mom-english.service
sudo cp deploy/mom-english.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mom-english
systemctl status mom-english
journalctl -u mom-english -f          # logs
```

Open `http://192.168.1.111:3001` in Safari on the MacBook. Add it to the Dock (File → Add to Dock) or to Favourites so it's one click for her. The admin page is at `http://192.168.1.111:3001/admin.html`.

### 6. Updating

```bash
cd ~/mom-english
git pull
npm ci
npm run build
sudo systemctl restart mom-english
```

### 7. Backups

All her progress is in `data/english.db`. A nightly copy is cheap:

```bash
crontab -e
# 30 2 * * * sqlite3 ~/mom-english/data/english.db ".backup '$HOME/backups/english-$(date +\%a).db'"
```

(Create `~/backups` first and install the `sqlite3` package. This keeps one copy per weekday.)

## Repository layout

```
src/
  claude/      CLI adapter (run.ts) and prompts
  content/     exercise schemas, local grading, exercise store
  engine/      placement, planner, sessions, levels, habit rules, spaced repetition
  jobs/        SQLite job queue, Claude job handlers, scheduler
  routes/      learner API and admin API
public/        frontend (index.html, admin.html, js/, style.css)
seed/          placement items and fallback exercise bank
deploy/        systemd unit
```
