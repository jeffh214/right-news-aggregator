# Right News Aggregator

Simple website that pulls and displays recent headlines from:

- Breitbart
- Fox News
- ZeroHedge
- Gateway Pundit
- Daily Caller
- Washington Examiner
- American Thinker

## Run locally

```bash
npm install
npm start
```

Then open:

```text
http://localhost:3000
```

Do not open `public/index.html` directly as a file. The frontend needs the backend API routes from `server.js`.

## Notes

- Some feeds may intermittently fail or rate-limit requests.
- You can filter by source and adjust headline count from the UI.
