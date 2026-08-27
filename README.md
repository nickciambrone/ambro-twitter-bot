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
- GitHub Actions automation stores its five random daily posting slots in Firestore at `botState/postScheduler`.
- If Firestore is disabled or unavailable, local dev falls back to `.data/rotation.json`.
- Posting uses the X API through `twitter-api-v2`.

## GitHub Automation

The workflow in `.github/workflows/random-posts.yml` runs every 15 minutes on
offset minutes `:07`, `:22`, `:37`, and `:52`. On the
first run of each day, it creates five random posting slots between 7:00 AM and
11:00 PM America/New_York, stores them in Firebase, and posts only when a slot is
due.

Add these GitHub repository secrets before enabling the workflow:

```text
OPENAI_API_KEY
OPENAI_MODEL
TWITTER_API_KEY
TWITTER_API_SECRET
TWITTER_ACCESS_TOKEN
TWITTER_ACCESS_SECRET
FIREBASE_API_KEY
FIREBASE_AUTH_DOMAIN
FIREBASE_PROJECT_ID
FIREBASE_STORAGE_BUCKET
FIREBASE_MESSAGING_SENDER_ID
FIREBASE_APP_ID
FIREBASE_MEASUREMENT_ID
```
