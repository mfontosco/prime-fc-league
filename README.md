# PRIME FC — Mini 4-a-side League 🏆⚽

Web app for the PRIME FC Mini 4-a-side League 2026: fixtures, results, a live league table and the champion.

**One League. Three Teams. One Champion!**

## Run it

Requires Node.js 22.9+. No dependencies to install.

```bash
ADMIN_PIN=your-secret-pin npm start     # http://localhost:3000
```

On Windows PowerShell:

```powershell
$env:ADMIN_PIN = "your-secret-pin"; npm start
```

| Env var     | Default               | Purpose                                   |
|-------------|-----------------------|-------------------------------------------|
| `ADMIN_PIN` | `prime2026` (warns)   | PIN needed to enter scores / edit teams   |
| `PORT`      | `3000`                | HTTP port                                 |
| `DATA_FILE` | `data/league.json`    | Where results are saved (when Redis isn't configured) |

Anyone with the link can view. Click **Admin** in the footer and enter the PIN to enter scores, change match dates, rename teams and run the squad draw.

## League rules implemented

- 3 teams, a full round every Saturday from 31 Oct to 19 Dec 2026: 8 matchdays, 24 matches, 16 per team, 2 per team per matchday.
- Fixture order each week: A v B, C v A, B v C. Home and away swap every other week.
- Strictly a league: no final. Dec 19 is the last matchday.
- Win 3 · Draw 1 · Loss 0.
- Ranking: points → goal difference → head-to-head (mini-table of matches between the tied teams: h2h points, h2h goal difference, h2h goals scored).
- Teams still level after that share a position (`1=`). The rules define no further tie-breaker, so the app doesn't invent one.
- The champion is declared only once all 24 results are in.

## Squads and the pot draw

The 18 players are split into 6 pots of 3 (`DEFAULT_POTS` in `public/lib/league.js`). The draw gives each team one player from every pot, so each squad has 6 players. It uses `crypto.randomInt` on the server and is saved with a timestamp. Redrawing needs an explicit confirmation, so a published draw is never overwritten by accident.

Squads can also be picked by hand: in admin mode, **Set squads manually** lets you choose each team's player from every pot. The same one-player-per-pot rule is checked, and replacing existing squads needs confirmation.

To change the pot list before the draw, edit `DEFAULT_POTS`. If `data/league.json` already exists, edit its `pots` field instead.

## Match day features

- **Goals, assists, cards, man of the match, best defender, report, photos.** In admin mode, open "Goals, cards & report" under any match. After the draw the team is worked out from the player; own goals count for the other side and don't appear in the top-scorer table. A warning shows if the recorded goals don't add up to the score.
- **Player stats:** top scorers, top assists, man-of-the-match and best-defender awards, and a discipline table (yellow/red cards). Assists are optional on each goal and must come from the scoring team; best defender is picked per match, like man of the match. Cards are recorded only; there are no automatic suspensions.
- **Photos:** JPEG, PNG or WebP, up to 5 MB and 6 per match. Files are checked by content and stored in `data/uploads/`.
- **Who's playing?:** anyone can mark themselves ✅ / ❔ / ❌ for each matchday, **no PIN needed**. Each team shows how many more players it needs to field 4.
- **Share on WhatsApp:** posts the table, results and top scorer to a chat.

## Deploy on Vercel

Vercel runs `server.js` directly: its default export is the request handler, and files in `public/` are served from Vercel's CDN.

Set these in the Vercel project's environment variables:

| Env var | Purpose |
|---------|---------|
| `ADMIN_PIN` | Admin PIN. Without it, admin login is disabled. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | League data (from the Upstash console → your database → REST API). `KV_REST_API_URL` / `KV_REST_API_TOKEN` also work. |
| `BLOB_READ_WRITE_TOKEN` | Match photos. Added automatically when a Vercel Blob store is connected to the project. |

Without the Redis variables the app falls back to `/tmp`, which Vercel wipes on every cold start, so nothing is kept. Saves are version-checked: if two people save at the same moment, the later request is re-run on the newer data instead of overwriting it.

## Develop

```bash
npm run dev     # http://localhost:4000, restarts on code changes; reads .env (copy .env.example)
npm test        # unit + API tests (node:test)
npm run check   # syntax check
```

- `public/lib/league.js`: pure league logic (fixtures, standings, tie-breakers). Shared by the server and the browser.
- `server.js`: zero-dependency HTTP server + JSON API.
- `src/storage.js`: where data is saved: `data/` locally, or Upstash Redis + Vercel Blob when configured.
- `public/`: the web app (vanilla JS, no build step).
