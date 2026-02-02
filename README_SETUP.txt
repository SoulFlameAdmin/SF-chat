STRANGER CHAT (Firebase) — ultra simple Omegle-style text matching

FILES:
- index.html
- styles.css
- app.js
- firebase-config.js
- database.rules.json

SETUP (10 minutes):
1) Firebase Console → Create project
2) Build → Authentication → Sign-in method → Enable "Anonymous"
3) Build → Realtime Database → Create database (test mode is ok for demo)
4) Realtime Database → Rules → paste database.rules.json (optional but recommended for demo)
5) Project settings → Your apps → Web app → copy the config and paste into firebase-config.js

RUN (important):
Because app.js uses ES modules, open it via a local server (NOT file://).

Option A (Python):
- Open cmd inside the folder and run:
  py -m http.server 5500
- Open:
  http://localhost:5500

Option B (Node):
- npm i -g serve
- serve -l 5500

HOW TO TEST:
- Open 2 browser windows (or incognito).
- Press FIND in both.
- You'll be matched and can chat.
- Press NEXT to delete the room and rematch.

NOTES:
- This is a minimal demo. For production we’ll harden rules, add rate limits, moderation, and better cleanup logic.



VERCEL (fast):
1) Put these files in the repo root (index.html must be at root).
2) Import repo into Vercel (or drag-drop folder in Vercel).
3) Deploy. No framework needed (static).

Vercel CLI:
- npm i -g vercel
- vercel
- vercel --prod
