# Ambro X Bot

A small plain HTML/CSS/JS interface for creating Ambro devotional X posts with OpenAI.

## Run locally

```sh
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:3000`.

## Notes

- The OpenAI key stays on the Node server. Do not put it in `public/app.js`.
- Every post is now a devotional text + sacred image package.
- Before each post is generated, the app reads the last 10 posted items from Firestore `tweetLog` and tells OpenAI to make the next one meaningfully different.
- Posted tweets are logged in Firestore at `tweetLog/{tweetId}` with the text, image prompt, alt text, image hash, source type, and theme.
- GitHub Actions automation stores its five random daily posting slots in Firestore at `botState/postScheduler`.
- Posting uses the X API through `twitter-api-v2`, uploads the generated image, attaches alt text, then posts the tweet.

## GitHub Automation

GitHub workflows are manual-only while local scheduling is in use.

## Local Automation

Run this on the machine that should act as the alarm clock:

```sh
npm run local:scheduler
```

The local scheduler checks Firebase every 5 minutes by default. On the first run
of each day, Firebase stores five random posting slots between 7:00 AM and
11:00 PM America/New_York. The local process posts only when a slot is due.

By default, startup skips already-missed slots so restarting the process does not
dump old posts immediately. Set `LOCAL_SCHEDULER_CATCH_UP=1` if you explicitly
want catch-up behavior.

Set `POSTS_PER_DAY` if you ever want to change the count.

Add these GitHub repository secrets before enabling the workflow:

```text
OPENAI_API_KEY
OPENAI_MODEL
OPENAI_IMAGE_MODEL
OPENAI_IMAGE_SIZE
OPENAI_IMAGE_QUALITY
OPENAI_IMAGE_FORMAT
OPENAI_IMAGE_COMPRESSION
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
