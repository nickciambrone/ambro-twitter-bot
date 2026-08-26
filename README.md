# Ambro X Bot

A small plain HTML/CSS/JS interface for creating Ambro tweets with OpenAI.

## Run locally

```sh
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:3000`.

## Notes

- The OpenAI key stays on the Node server. Do not put it in `public/app.js`.
- Tweet format rotation is stored in Firestore at `botState/tweetRotation`.
- If Firestore is disabled or unavailable, local dev falls back to `.data/rotation.json`.
- Posting uses the X API through `twitter-api-v2`.
