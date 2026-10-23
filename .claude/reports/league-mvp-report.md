# Implementation Report — PRIME FC Mini 4-a-side League MVP

**Plan**: none (built directly from the league rules given in the request)   **Branch**: feature/league-mvp   **Status**: COMPLETE

## Summary
A zero-dependency Node web app for the 3-team PRIME FC Mini 4-a-side League. The public page shows the live league table, fixtures and results, the current leader/champion and the rules. An admin (PIN-protected) can enter or clear scores, change match dates and rename teams. Results persist to a JSON file.

## Tasks completed
- Pot list + pot-based squad draw (admin, crypto randomness, guarded redraw) → `src/league.js`, `server.js`, `public/*` (UPDATE)
- League logic (fixtures, points, tie-breakers, champion) → `src/league.js` (CREATE)
- HTTP server + JSON API with PIN auth and atomic file persistence → `server.js` (CREATE)
- Web UI → `public/index.html`, `public/app.js`, `public/styles.css` (CREATE)
- Project setup → `package.json`, `.gitignore`, `README.md` (CREATE)

## Tests added
- `test/league.test.js` (10): fixture order and home/away, 4 matches per team, 2 per matchday, points 3/1/0, unplayed matches ignored, GD tie-break, head-to-head tie-break, shared position when fully level, 3-way mini-league, champion only when complete, score/date validation.
- `test/league.test.js` (+5): pot list shape, one player per pot per team over 50 seeded draws, randomness, invalid pot size, migration of old saves.
- `test/server.test.js` (+1): draw is admin-only, persisted, 409 on redraw without confirmation, reset.
- `test/server.test.js` (9): state seeding, static whitelist (no path traversal / data file exposure), PIN login, 401 without PIN, persistence to disk, clear/invalid scores, date and team-name validation, malformed JSON.

## Validation results
- `npm run check`: pass
- `npm test`: 25/25 pass
- Manual browser check at localhost: table, fixtures and admin edit mode render correctly; no console errors. Mobile width was not visually verified (the window resize didn't apply).

## Deviations from the plan
- **Match dates.** The rules say every Saturday from 31 Oct to 19 Dec, but also 6 matches total with each team playing 2 per Saturday. That is only 2 matchdays. Default dates: Leg 1 = Sat 31 Oct (Commencement), Leg 2 = Sat 19 Dec (Final Matchday). The admin can change any match date in the app.
- **Head-to-head detail.** The rules say "head-to-head record" without defining it. Implemented as h2h points → h2h goal difference → h2h goals scored across the two meetings. Teams still level share a position, and no champion is declared (no criterion is invented).
- **Squads.** Players are not tied to match results (no scorers yet). The draw is random in the app; it does not support entering a draw done offline. Pot tags are shown next to each player in the squads.
- **Persistence.** A JSON file (not a database), which is enough for 6 matches.

## Issues encountered
- `node --test test/` fails on Windows/Node 22 (directory not resolved). Fixed by using the glob `"test/*.test.js"`.
