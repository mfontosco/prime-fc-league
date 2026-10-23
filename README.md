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
| `DATA_FILE` | `data/league.json`    | Where results are saved                   |

Anyone with the link can view. Click **Admin** in the footer and enter the PIN to enter scores, change match dates, rename teams and run the squad draw.

## League rules implemented

- 3 teams, double round-robin (home & away): 6 matches, 4 per team, 2 per team per matchday.
- Fixture order: A v B, C v A, B v C, then reversed for the second leg.
- Win 3 · Draw 1 · Loss 0.
- Ranking: points → goal difference → head-to-head (mini-table of matches between the tied teams: h2h points, h2h goal difference, h2h goals scored).
- Teams still level after that share a position (`1=`). The rules define no further tie-breaker, so the app doesn't invent one.
- The champion is declared only once all 6 results are in.

## Squads and the pot draw

The 18 players are split into 6 pots of 3 (`DEFAULT_POTS` in `src/league.js`). The draw gives each team one player from every pot, so each squad has 6 players. It uses `crypto.randomInt` on the server and is saved with a timestamp. Redrawing needs an explicit confirmation, so a published draw is never overwritten by accident.

To change the pot list before the draw, edit `DEFAULT_POTS`. If `data/league.json` already exists, edit its `pots` field instead.

## Develop

```bash
npm run dev     # http://localhost:4000, restarts on code changes; reads .env (copy .env.example)
npm test        # unit + API tests (node:test)
npm run check   # syntax check
```

- `src/league.js`: pure league logic (fixtures, standings, tie-breakers). Shared by the server and the browser.
- `server.js`: zero-dependency HTTP server + JSON API.
- `public/`: the web app (vanilla JS, no build step).
