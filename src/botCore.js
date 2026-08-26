import 'dotenv/config';
import { randomInt } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import {
  arrayUnion,
  doc,
  getDoc,
  getFirestore,
  runTransaction,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import OpenAI from 'openai';
import { TwitterApi } from 'twitter-api-v2';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const client = process.env.OPENAI_API_KEY ? new OpenAI() : null;
const maxTweetLength = 279;
const postsPerDay = 5;
const schedulerTimeZone = process.env.SCHEDULER_TIME_ZONE || 'America/New_York';
const schedulerStartMinute = Number(process.env.SCHEDULER_START_MINUTE || 7 * 60);
const schedulerEndMinute = Number(process.env.SCHEDULER_END_MINUTE || 23 * 60);
const schedulerWindowMinutes = Number(process.env.SCHEDULER_WINDOW_MINUTES || 15);

const xCredentials = {
  appKey: process.env.TWITTER_API_KEY || process.env.X_CONSUMER_KEY,
  appSecret: process.env.TWITTER_API_SECRET || process.env.X_CONSUMER_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN || process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET || process.env.X_ACCESS_TOKEN_SECRET,
};

const twitterClient =
  xCredentials.appKey &&
  xCredentials.appSecret &&
  xCredentials.accessToken &&
  xCredentials.accessSecret
    ? new TwitterApi(xCredentials).readWrite
    : null;

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY || 'AIzaSyDn_as_wGlbCUFsVJ8R6SfnZxgyPEW2mUk',
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || 'ambro-x-bot.firebaseapp.com',
  projectId: process.env.FIREBASE_PROJECT_ID || 'ambro-x-bot',
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'ambro-x-bot.firebasestorage.app',
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '1075456923466',
  appId: process.env.FIREBASE_APP_ID || '1:1075456923466:web:a473ee4cfc5e427c53d3b3',
  measurementId: process.env.FIREBASE_MEASUREMENT_ID || 'G-Z7K38NG3DV',
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
const rotationRef = doc(db, 'botState', 'tweetRotation');
const schedulerRef = doc(db, 'botState', 'postScheduler');
const localRotationPath = join(projectRoot, '.data', 'rotation.json');

export const tweetFormats = [
  {
    id: 'sharp-take',
    name: 'The Sharp Take',
    guidance:
      'One original Bible or Christian observation that makes the reader pause and think. It should feel precise, wise, and memorable.',
    example:
      "Sometimes faith isn't believing God will give you what you want. It's trusting Him when He doesn't.",
  },
  {
    id: 'misunderstood-verse',
    name: 'The Misunderstood Verse',
    guidance:
      'Quote or reference a commonly misunderstood verse, then explain what it actually means in context.',
    example:
      "'Judge not' does not mean Christians are forbidden from judging behavior. The rest of Matthew 7 makes that pretty clear.",
  },
  {
    id: 'question',
    name: 'The Question',
    guidance:
      'Ask a genuine theological or philosophical question designed to invite thoughtful replies.',
    example: 'What teaching of Jesus is the hardest to actually live by?',
  },
  {
    id: 'bible-life-connection',
    name: 'The Bible -> Life Connection',
    guidance:
      'Take a biblical idea and connect it to anxiety, relationships, ambition, anger, discipline, forgiveness, or another real-life pressure.',
    example:
      "A lot of anxiety is experiencing tomorrow's suffering before tomorrow even exists. Matthew 6 addresses exactly this.",
  },
  {
    id: 'deep-dive',
    name: 'The Deep Dive',
    guidance:
      'Explain something fascinating in one compact post: historical context, apparent contradictions, symbolism, translations, or a whole passage.',
    example:
      'Why did Jesus curse a fig tree for not having figs? It sounds bizarre until you understand what the tree represented...',
  },
  {
    id: 'ambro-promotion',
    name: 'Ambro Promotion',
    guidance:
      'Directly or indirectly showcase Ambro and why someone should download it. Focus on a specific feature or problem rather than generic advertising.',
    example:
      "Reading the Bible isn't the hard part. Understanding what you're actually reading is. That's why I built Ambro.",
  },
];

const tweetSystemPrompt = `You write polished tweets for Ambro, a Catholic prayer and Bible app.
Every post must follow the requested format exactly. Keep the voice faithful, warm, modern,
intellectually honest, and grounded. Avoid cringe marketing, fake virality, vague inspiration,
emoji overload, and hashtag stuffing. The format is private planning metadata only.
Never mention, label, title, introduce, or explain the format. Return only the public-facing
tweet text. The final tweet must be fewer than 280 characters.`;

const qualityCheckPrompt = `You are the final editor for Ambro social posts.
Rewrite only when needed. The final output must:
- sound like a thoughtful human wrote it, not a content template
- be original, clean, concrete, and natural
- avoid generic inspirational filler
- avoid clout-chasing, engagement bait, hashtags, and emoji
- avoid theological overclaiming or careless Bible context
- contain no private format labels, category names, headings, or prefaces
- be strictly under 280 characters
- return only the final public-facing tweet text`;

const bannedFormatLabels = [
  'The Sharp Take',
  'Sharp Take',
  'The Misunderstood Verse',
  'Misunderstood Verse',
  'The Question',
  'Bible -> Life Connection',
  'Bible → Life Connection',
  'Bible Life Connection',
  'The Deep Dive',
  'Deep Dive',
  'Ambro Promotion',
];

export function getErrorStatus(error) {
  return Number.isInteger(error?.code) && error.code >= 400 && error.code < 600 ? error.code : 500;
}

export function getPublicErrorMessage(error) {
  if (error?.code === 401) {
    return 'X rejected the Twitter credentials with 401 Unauthorized. Check app permissions and regenerate the access token/secret.';
  }

  if (error?.code === 403) {
    return 'X rejected the request with 403 Forbidden. Make sure the app has Read and Write permissions.';
  }

  if (error?.code === 402) {
    return 'X returned 402 Payment Required. Your credentials are reaching X, but the developer app likely needs paid/eligible API access for posting.';
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'Something went wrong.';
}

function normalizeRotationIndex(value) {
  return Number.isInteger(value) && value >= 0 ? value % tweetFormats.length : 0;
}

export function serializeFormat(format) {
  return {
    id: format.id,
    name: format.name,
    guidance: format.guidance,
  };
}

export async function getCurrentFormat() {
  try {
    const snapshot = await getDoc(rotationRef);
    const currentIndex = normalizeRotationIndex(snapshot.data()?.nextFormatIndex);
    return {
      index: currentIndex,
      format: tweetFormats[currentIndex],
      source: 'firebase',
    };
  } catch (error) {
    const currentIndex = await getLocalRotationIndex();
    console.warn(`Firebase rotation unavailable, using local fallback: ${error.message}`);
    return {
      index: currentIndex,
      format: tweetFormats[currentIndex],
      source: 'local fallback',
    };
  }
}

export async function advanceFormat(expectedIndex, generatedTweet) {
  try {
    const result = await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(rotationRef);
      const currentIndex = normalizeRotationIndex(snapshot.data()?.nextFormatIndex);
      const nextIndex = (currentIndex + 1) % tweetFormats.length;

      transaction.set(
        rotationRef,
        {
          nextFormatIndex: nextIndex,
          lastFormatId: tweetFormats[expectedIndex].id,
          lastTweetPreview: generatedTweet,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );

      return {
        advancedFrom: currentIndex,
        nextFormat: tweetFormats[nextIndex],
        rotationShifted: currentIndex !== expectedIndex,
        source: 'firebase',
      };
    });

    return result;
  } catch (error) {
    console.warn(`Firebase rotation update unavailable, using local fallback: ${error.message}`);
    return advanceLocalRotation(expectedIndex, generatedTweet);
  }
}

async function getLocalRotationIndex() {
  try {
    const raw = await readFile(localRotationPath, 'utf8');
    return normalizeRotationIndex(JSON.parse(raw).nextFormatIndex);
  } catch {
    return 0;
  }
}

async function advanceLocalRotation(expectedIndex, generatedTweet) {
  const currentIndex = await getLocalRotationIndex();
  const nextIndex = (currentIndex + 1) % tweetFormats.length;

  await mkdir(join(projectRoot, '.data'), { recursive: true });
  await writeFile(
    localRotationPath,
    JSON.stringify(
      {
        nextFormatIndex: nextIndex,
        lastFormatId: tweetFormats[expectedIndex].id,
        lastTweetPreview: generatedTweet,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  return {
    advancedFrom: currentIndex,
    nextFormat: tweetFormats[nextIndex],
    rotationShifted: currentIndex !== expectedIndex,
    source: 'local fallback',
  };
}

function stripFormatLeakage(text) {
  let cleaned = text.trim();

  for (const label of bannedFormatLabels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cleaned = cleaned.replace(new RegExp(`^\\s*(?:\\*\\*)?${escaped}(?:\\*\\*)?\\s*[:\\-–—]?\\s*`, 'i'), '');
    cleaned = cleaned.replace(new RegExp(`\\b${escaped}\\b\\s*[:\\-–—]?\\s*`, 'gi'), '');
  }

  return cleaned
    .replace(/^tweet\s*[:\-–—]\s*/i, '')
    .replace(/^post\s*[:\-–—]\s*/i, '')
    .trim();
}

export function assertTweetLength(tweet) {
  if (tweet.length > maxTweetLength) {
    throw Object.assign(new Error(`Tweet is ${tweet.length} characters. It must be fewer than 280.`), {
      code: 400,
    });
  }
}

async function shortenTweet(tweet) {
  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-5',
    instructions: `Rewrite the post so it is fewer than 280 characters.
Preserve the main idea, make it sound human, remove filler, and return only the final tweet text.
Do not add a heading, format name, hashtags, emoji, or explanation.`,
    input: `Current length: ${tweet.length}

Post:
${tweet}`,
  });

  const shortened = stripFormatLeakage(response.output_text?.trim() || '');

  if (!shortened) {
    throw new Error('OpenAI returned an empty shortened tweet.');
  }

  return shortened;
}

async function enforceTweetLength(tweet) {
  let finalTweet = stripFormatLeakage(tweet);

  for (let attempt = 0; attempt < 2 && finalTweet.length > maxTweetLength; attempt += 1) {
    finalTweet = await shortenTweet(finalTweet);
  }

  assertTweetLength(finalTweet);
  return finalTweet;
}

async function qualityCheckTweet({ tweet, format = null, editInstruction = '' }) {
  const formatContext = format
    ? `The private target structure was: ${format.guidance}`
    : 'Preserve the apparent structure of the draft.';
  const editContext = editInstruction ? `User edit request: ${editInstruction}` : '';

  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-5',
    instructions: qualityCheckPrompt,
    input: `${formatContext}
${editContext}

Draft:
${tweet}

Return the final cleaned post only. It must be fewer than 280 characters.`,
  });

  const checked = response.output_text?.trim();

  if (!checked) {
    throw new Error('OpenAI returned an empty checked tweet.');
  }

  return enforceTweetLength(checked);
}

export async function generateTweet({ context = '', currentTweet = '', editInstruction = '', format = null }) {
  if (!client) {
    throw new Error('Missing OPENAI_API_KEY. Add it to .env before creating AI tweets.');
  }

  const input = editInstruction
    ? `Revise this Ambro post while preserving its original format and theological care.

Current post:
${currentTweet}

Edit request:
${editInstruction}`
    : `Create one Ambro post using this private structure:

Private structure rules:
${format.guidance}

Reference example for tone only:
${format.example}

Do not include a heading, category label, title, format name, intro sentence, or explanation.
Do not mention that you are following a format.

Optional direction from user:
${context || 'No direction provided.'}`;

  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-5',
    instructions: tweetSystemPrompt,
    input,
  });

  const text = await enforceTweetLength(response.output_text?.trim() || '');

  if (!text) {
    throw new Error('OpenAI returned an empty tweet.');
  }

  return qualityCheckTweet({ tweet: text, format, editInstruction });
}

function getTweetSegments(tweet) {
  const text = tweet.trim();

  if (!text) {
    return [];
  }

  return [text];
}

export async function postToTwitter(tweet) {
  const segments = getTweetSegments(tweet);

  if (!segments.length) {
    throw new Error('Nothing to post yet.');
  }

  for (const segment of segments) {
    assertTweetLength(segment);
  }

  if (!twitterClient) {
    throw new Error(
      'Missing Twitter credentials. Add TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, and TWITTER_ACCESS_SECRET to .env.',
    );
  }

  const postedTweets = [];
  let replyToTweetId = null;

  for (const segment of segments) {
    const payload = replyToTweetId
      ? { text: segment, reply: { in_reply_to_tweet_id: replyToTweetId } }
      : segment;
    const response = await twitterClient.v2.tweet(payload);
    const posted = response.data;

    postedTweets.push({
      id: posted.id,
      text: posted.text,
    });
    replyToTweetId = posted.id;
  }

  return postedTweets;
}

export async function getTwitterAccount() {
  if (!twitterClient) {
    throw new Error(
      'Missing Twitter credentials. Add TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, and TWITTER_ACCESS_SECRET to .env.',
    );
  }

  const me = await twitterClient.v2.me();
  return me.data;
}

export async function createTweetFromRotation(context = '') {
  const { index, format } = await getCurrentFormat();
  const tweet = await generateTweet({ context, format });
  const rotation = await advanceFormat(index, tweet);

  return {
    tweet,
    format,
    nextFormat: rotation.nextFormat,
    rotationSource: rotation.source,
    rotationShifted: rotation.rotationShifted,
  };
}

export async function createAndPostTweet(context = '') {
  const draft = await createTweetFromRotation(context);
  assertTweetLength(draft.tweet);
  const postedTweets = await postToTwitter(draft.tweet);

  await recordPostedTweet({
    tweet: draft.tweet,
    format: draft.format,
    postedTweets,
    source: 'automation',
  });

  return {
    ...draft,
    postedTweets,
    status: 'posted',
    postedAt: new Date().toISOString(),
  };
}

function getLocalDayParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: schedulerTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    dateKey: `${values.year}-${values.month}-${values.day}`,
    minuteOfDay: Number(values.hour) * 60 + Number(values.minute),
  };
}

function createDailySlots(dateKey, minimumMinute = schedulerStartMinute) {
  const availableSlots = [];
  const firstSlotMinute = Math.max(schedulerStartMinute, minimumMinute);

  for (
    let minute = firstSlotMinute;
    minute <= schedulerEndMinute;
    minute += schedulerWindowMinutes
  ) {
    availableSlots.push(minute);
  }

  for (let index = availableSlots.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [availableSlots[index], availableSlots[swapIndex]] = [
      availableSlots[swapIndex],
      availableSlots[index],
    ];
  }

  return availableSlots.slice(0, postsPerDay).sort((a, b) => a - b);
}

function formatSlot(minute) {
  const hour = Math.floor(minute / 60);
  const mins = String(minute % 60).padStart(2, '0');
  return `${String(hour).padStart(2, '0')}:${mins}`;
}

function formatSlotList(slots = []) {
  return slots.map((slot) => ({
    minute: slot,
    label: formatSlot(slot),
  }));
}

export async function getScheduledPostStatus(now = new Date()) {
  const { dateKey, minuteOfDay } = getLocalDayParts(now);
  const snapshot = await getDoc(schedulerRef);
  const data = snapshot.exists() ? snapshot.data() : {};
  const isToday = data.dateKey === dateKey;
  const slots =
    isToday && Array.isArray(data.slots)
      ? data.slots
      : createDailySlots(dateKey, minuteOfDay + schedulerWindowMinutes);
  const postedSlots = isToday && Array.isArray(data.postedSlots) ? data.postedSlots : [];
  const failedSlots = isToday && Array.isArray(data.failedSlots) ? data.failedSlots : [];
  const unavailableSlots = new Set([...postedSlots, ...failedSlots]);

  return {
    dateKey,
    timeZone: schedulerTimeZone,
    minuteOfDay,
    slots: formatSlotList(slots),
    postedSlots: formatSlotList(postedSlots),
    failedSlots: formatSlotList(failedSlots),
    nextSlot: formatSlotList([slots.find((slot) => slot > minuteOfDay && !unavailableSlots.has(slot))])
      .filter((slot) => Number.isInteger(slot.minute))[0] || null,
    storedInFirebase: isToday,
  };
}

export async function initializeTodaySchedule(now = new Date()) {
  const { dateKey, minuteOfDay } = getLocalDayParts(now);

  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(schedulerRef);
    const data = snapshot.exists() ? snapshot.data() : {};

    if (data.dateKey === dateKey && Array.isArray(data.slots)) {
      const postedSlots = Array.isArray(data.postedSlots) ? data.postedSlots : [];
      const failedSlots = Array.isArray(data.failedSlots) ? data.failedSlots : [];
      const unavailableSlots = new Set([...postedSlots, ...failedSlots]);

      return {
        dateKey,
        timeZone: schedulerTimeZone,
        minuteOfDay,
        slots: formatSlotList(data.slots),
        postedSlots: formatSlotList(postedSlots),
        failedSlots: formatSlotList(failedSlots),
        nextSlot:
          formatSlotList([data.slots.find((slot) => slot > minuteOfDay && !unavailableSlots.has(slot))])
            .filter((slot) => Number.isInteger(slot.minute))[0] || null,
        storedInFirebase: true,
      };
    }

    const slots = createDailySlots(dateKey, minuteOfDay + schedulerWindowMinutes);

    transaction.set(
      schedulerRef,
      {
        dateKey,
        slots,
        postedSlots: [],
        failedSlots: [],
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    return {
      dateKey,
      timeZone: schedulerTimeZone,
      minuteOfDay,
      slots: formatSlotList(slots),
      postedSlots: [],
      failedSlots: [],
      nextSlot: formatSlotList([slots.find((slot) => slot > minuteOfDay)])[0] || null,
      storedInFirebase: true,
    };
  });
}

export async function reserveDueScheduledPost(now = new Date()) {
  const { dateKey, minuteOfDay } = getLocalDayParts(now);

  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(schedulerRef);
    const data = snapshot.exists() ? snapshot.data() : {};
    const isToday = data.dateKey === dateKey;
    const slots =
      isToday && Array.isArray(data.slots)
        ? data.slots
        : createDailySlots(dateKey, minuteOfDay + schedulerWindowMinutes);
    const postedSlots = isToday && Array.isArray(data.postedSlots) ? data.postedSlots : [];
    const failedSlots = isToday && Array.isArray(data.failedSlots) ? data.failedSlots : [];
    const unavailableSlots = new Set([...postedSlots, ...failedSlots]);
    const dueSlot = slots.find((slot) => slot <= minuteOfDay && !unavailableSlots.has(slot));

    if (dueSlot === undefined) {
      transaction.set(
        schedulerRef,
        {
          dateKey,
          slots,
          postedSlots,
          failedSlots,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );

      return {
        shouldPost: false,
        dateKey,
        slots,
        postedSlots,
        nextSlot: slots.find((slot) => slot > minuteOfDay && !unavailableSlots.has(slot)),
        timeZone: schedulerTimeZone,
      };
    }

    transaction.set(
      schedulerRef,
      {
        dateKey,
        slots,
        postedSlots: arrayUnion(dueSlot),
        activeSlot: dueSlot,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    return {
      shouldPost: true,
      dateKey,
      slot: dueSlot,
      slotLabel: formatSlot(dueSlot),
      slots,
      timeZone: schedulerTimeZone,
    };
  });
}

export async function recordScheduledFailure(slot, error) {
  await setDoc(
    schedulerRef,
    {
      failedSlots: arrayUnion(slot),
      lastError: getPublicErrorMessage(error),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

export async function recordPostedTweet({ tweet, format, postedTweets, source }) {
  await setDoc(
    doc(db, 'tweetLog', postedTweets[0].id),
    {
      tweet,
      formatId: format?.id || null,
      formatName: format?.name || null,
      postedTweetId: postedTweets[0].id,
      postedTweets,
      source,
      createdAt: serverTimestamp(),
    },
    { merge: true },
  );
}
