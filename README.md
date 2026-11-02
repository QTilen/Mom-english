# Mom English

A calm, adaptive web app that helps a Slovenian speaker practise English **reading and writing** a few minutes a day. The interface and instructions are in Slovenian and the exercises are in English. It runs on a Raspberry Pi on the home LAN, and all AI work goes through the already logged-in **Claude Code CLI**, in the background, using a Claude subscription. It never uses the paid API.

## What it does

- **Placement test (first visit, up to 30 minutes, and she is told so).** 24 adaptive questions (8 each on vocabulary, grammar and reading). Each skill has its own staircase: one level up after a correct answer, one down after a wrong one. A "Ne vem" button saves her from guessing, and she can take a break and resume. The test ends with 3 short writing prompts that Claude grades in the background. The result is a separate CEFR sub-level per skill, from Pre-A1 to A2.2. Practice can later take her further, to B1.1 and B1.2. The estimate is deliberately conservative so the first days feel easy.
- **Daily session, in three screens:**
  1. *Včeraj smo se naučili:* a recap of last time, Claude's feedback on her writing, and 1–2 quick review questions.
  2. Today's exercises.
  3. A celebration screen with her 🔥 streak and what she learned.
- **Exercise types:** multiple choice, fill-in-the-blank, word ordering, matching, short reading with questions, Slovenian→English translation, and free writing. Topics are adult and everyday (shopping, family, doctor, travel, cooking, weather…).
- **Instant, gentle feedback.** Every exercise already contains its answer and a short Slovenian explanation, so she never waits for Claude. Free writing, and translations that don't match a known answer, are graded by Claude in the background. She sees that feedback at the start of her next session.
- **Adaptive levels.** A skill moves up after more than 85% over her last 3 sessions with that skill, and down after less than 50% over the last 2. Each session is weighted towards her weakest skills and recent mistakes. Between level changes, each exercise slot also gets a difficulty hint ("upper end" or "lower end" of the level) from her last 15 answers in that skill. Claude also sees her recent accuracy and her latest free writing, so new exercises stay in her sweet spot.
- **Mistake log and spaced repetition.** Mistakes are logged by category (articles, word order, past simple, specific words…). Weak points come back at 1, 2, 4, 7, 14 and 30 days.
- **Habit building (Atomic Habits).** The placement test is the only long day. Daily practice then starts at **5 minutes** so showing up is easy.
  - Length is set by the number of exercises, calibrated to her own speed; there is no visible timer.
  - It climbs a ladder of small weekly steps (5 → 7 → 9 → 12 → 15 → 18 → 22 → 26 → 30 → 34 → 38 → 42 → 45 minutes), one step after each week with 7 sessions in 8 days. With steady practice that reaches **45 minutes after about 3 months**. The cap is adjustable in admin.
  - After 3 or more days away, she goes back one step.
  - 2 streak freezes per week cover missed days.
  - Long sessions are generated in chunks of 12 exercises and include one free-writing task per started quarter hour.
- **Warm and personal, in English.** Encouragement is in simple English, as extra reading practice: the greeting ("Good morning, Franja!"), the daily thought ("It's never too late to learn something new."), praise after answers ("Well done, Franja!") and the celebration screens. Hovering over a phrase, or tapping it, shows the Slovenian translation. Instructions and grammar explanations stay in Slovenian. The name is set in admin.
- **Things to collect:**
  - 🔥 one fire per practice day
  - ⭐ 1–3 stars per session: 1 for finishing, 2 for 70% or more, 3 for 90% or more
  - badges for streak milestones (3, 7, 14, 30, 60, 100 days), words learned and stars collected
  - 🎁 a **real family reward every 14 days in a row**. You set the reward text in admin. When she unlocks it she gets a big celebration screen ("Pokaži ta zaslon družini"), and you tick it off in admin once it's been given.
- **Progress page** for her (levels, collection, reward countdown), and a **PIN-protected admin page** (`/admin.html`) for you. Admin shows:
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

- **Node.js 20 or newer** (`node -v`). The Pi already has Node 22 from NodeSource, plus `build-essential` and `sqlite3`, installed on 2026-11-02. `better-sqlite3` compiles from source there, which takes a few minutes. To set up a fresh Pi:
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh && sudo -E bash /tmp/nodesource_setup.sh
  sudo apt install -y nodejs build-essential sqlite3
  ```

### 2. Claude Code CLI, logged in with your subscription

```bash
curl -fsSL https://claude.ai/install.sh | bash     # or: npm install -g @anthropic-ai/claude-code (check current docs)
claude                                            # follow the login prompt; choose your Claude subscription, NOT an API key
claude -p "say pong" --output-format json          # should print a JSON result with "is_error": false
echo "${ANTHROPIC_API_KEY:-unset}"                 # must print "unset"
```

On a Pi without a screen, the login prints a link. Open it on your Mac and paste the code back into the terminal. Claude Code is already installed on the Pi (`~/.local/bin/claude`), but its login has expired, so only the `claude` login step is needed. The login is stored in `~/.claude/`. The service runs as the same user, so it uses that login directly. If the login ever expires, run `claude` again. The admin page shows the CLI's status and has a **Preizkusi Claude** (test Claude) button.

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
