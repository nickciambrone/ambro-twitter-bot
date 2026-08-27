import 'dotenv/config';
import { createHash, randomInt } from 'node:crypto';
import { initializeApp } from 'firebase/app';
import {
  arrayUnion,
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import OpenAI from 'openai';
import { TwitterApi } from 'twitter-api-v2';

const client = process.env.OPENAI_API_KEY ? new OpenAI() : null;
const maxTweetLength = 279;
const postsPerDay = Number(process.env.POSTS_PER_DAY || 5);
const schedulerTimeZone = process.env.SCHEDULER_TIME_ZONE || 'America/New_York';
const schedulerStartMinute = Number(process.env.SCHEDULER_START_MINUTE || 7 * 60);
const schedulerEndMinute = Number(process.env.SCHEDULER_END_MINUTE || 23 * 60);
const schedulerWindowMinutes = Number(process.env.SCHEDULER_WINDOW_MINUTES || 15);
const schedulerSlotOffsetMinute = Number(process.env.SCHEDULER_SLOT_OFFSET_MINUTE || 7);
const openaiTextModel = process.env.OPENAI_MODEL || 'gpt-5';
const openaiImageModel = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const openaiImageSize = process.env.OPENAI_IMAGE_SIZE || '1024x1536';
const openaiImageQuality = process.env.OPENAI_IMAGE_QUALITY || 'low';
const openaiImageFormat = process.env.OPENAI_IMAGE_FORMAT || 'jpeg';
const openaiImageCompression = Number(process.env.OPENAI_IMAGE_COMPRESSION || 82);

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
const schedulerRef = doc(db, 'botState', 'postScheduler');
const tweetLogCollection = collection(db, 'tweetLog');

const devotionalSystemPrompt = `You create posts for Ambro, a Catholic prayer and Bible app.
The public post must match this social format every time:
- short devotional quote, prayer, or saint-style reflection
- paired with a sacred artwork image
- reverent, human, direct, and emotionally clear
- no hashtags, no emoji, no engagement bait, no labels, no format names
- fewer than 280 characters

Do not invent fake saint quotes or fake citations. If attribution is uncertain, make it an original
prayer/reflection with no attribution. Return JSON only.`;

const devotionalCheckerPrompt = `You are the final editor for Ambro devotional image posts.
Check the package for:
- text is fewer than 280 characters
- text sounds human, clean, reverent, and not templated
- no private labels, headings, hashtags, emoji, or "format" language
- no fake saint attribution or suspicious quote attribution
- visibly different from the recent posts in theme, wording, saint/source, and image idea
- image prompt has no text, captions, watermark, UI, logos, or modern app screenshots

Return corrected JSON only.`;

const bannedPostLanguage = [
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
  'format',
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

function cleanTweetText(text) {
  let cleaned = String(text || '').trim();

  for (const phrase of bannedPostLanguage) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cleaned = cleaned.replace(new RegExp(`^\\s*(?:\\*\\*)?${escaped}(?:\\*\\*)?\\s*[:\\-–—]?\\s*`, 'i'), '');
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

function extractJson(text) {
  const raw = String(text || '').trim();

  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error('OpenAI did not return a JSON post package.');
    }
    return JSON.parse(match[0]);
  }
}

function normalizePostPackage(packageDraft) {
  const text = cleanTweetText(packageDraft?.text || packageDraft?.tweet || '');
  const imagePrompt = String(packageDraft?.imagePrompt || packageDraft?.image_prompt || '').trim();
  const imageAlt = String(packageDraft?.imageAlt || packageDraft?.image_alt || '').trim();
  const sourceType = String(packageDraft?.sourceType || packageDraft?.source_type || 'original devotional').trim();
  const theme = String(packageDraft?.theme || '').trim();

  if (!text) {
    throw new Error('OpenAI returned an empty tweet.');
  }

  if (!imagePrompt) {
    throw new Error('OpenAI returned an empty image prompt.');
  }

  assertTweetLength(text);

  return {
    text,
    imagePrompt,
    imageAlt: imageAlt || 'Sacred devotional artwork for the Ambro post.',
    sourceType,
    theme,
  };
}

async function shortenTweet(tweet) {
  const response = await client.responses.create({
    model: openaiTextModel,
    instructions: `Rewrite this devotional post so it is fewer than 280 characters.
Keep it human, reverent, and clean. Remove filler. Return only the public text.`,
    input: `Current length: ${tweet.length}

Post:
${tweet}`,
  });

  const shortened = cleanTweetText(response.output_text?.trim() || '');
  assertTweetLength(shortened);
  return shortened;
}

async function enforceTweetLength(tweet) {
  let finalTweet = cleanTweetText(tweet);

  for (let attempt = 0; attempt < 2 && finalTweet.length > maxTweetLength; attempt += 1) {
    finalTweet = await shortenTweet(finalTweet);
  }

  assertTweetLength(finalTweet);
  return finalTweet;
}

export async function getRecentTweetLogs(count = 10) {
  const snapshot = await getDocs(query(tweetLogCollection, orderBy('createdAt', 'desc'), limit(count)));

  return snapshot.docs.map((entry) => {
    const data = entry.data();
    return {
      id: entry.id,
      tweet: data.tweet || data.text || '',
      imagePrompt: data.imagePrompt || '',
      imageAlt: data.imageAlt || '',
      sourceType: data.sourceType || '',
      theme: data.theme || '',
      postedTweetId: data.postedTweetId || entry.id,
      source: data.source || '',
    };
  });
}

function buildRecentPostContext(recentPosts) {
  if (!recentPosts.length) {
    return 'No previous posted Ambro devotional image posts are logged yet.';
  }

  return recentPosts
    .map(
      (post, index) => `${index + 1}. Text: ${post.tweet}
Image idea: ${post.imagePrompt}
Theme/source: ${[post.theme, post.sourceType].filter(Boolean).join(' / ') || 'unknown'}`,
    )
    .join('\n\n');
}

async function generateDevotionalPackageDraft({ context, recentPosts }) {
  const response = await client.responses.create({
    model: openaiTextModel,
    instructions: devotionalSystemPrompt,
    input: `Create one new Ambro devotional image post.

Style references from high-performing examples:
- short quote or prayer with lots of white space
- saint/devotional Catholic tone
- sacred oil-painting style image
- emotionally direct: mercy, temptation, perseverance, Mary, the cross, family, prayer

Optional direction from user:
${context || 'No direction provided.'}

Last 10 posted Ambro posts. The new one must be meaningfully different:
${buildRecentPostContext(recentPosts)}

Return JSON with exactly these keys:
{
  "text": "public tweet text under 280 characters",
  "imagePrompt": "portrait-oriented sacred devotional oil painting prompt, no text in image",
  "imageAlt": "short accessibility description",
  "sourceType": "original prayer, original reflection, or verified saint quote",
  "theme": "short theme label"
}`,
  });

  return normalizePostPackage(extractJson(response.output_text));
}

async function qualityCheckDevotionalPackage({ postPackage, context, recentPosts }) {
  const response = await client.responses.create({
    model: openaiTextModel,
    instructions: devotionalCheckerPrompt,
    input: `Optional user direction:
${context || 'No direction provided.'}

Recent posts that must not be repeated:
${buildRecentPostContext(recentPosts)}

Draft package:
${JSON.stringify(postPackage, null, 2)}

Return corrected JSON with the same keys only.`,
  });

  const checked = normalizePostPackage(extractJson(response.output_text));
  checked.text = await enforceTweetLength(checked.text);
  return checked;
}

async function generateImage(imagePrompt) {
  const imageParams = {
    model: openaiImageModel,
    prompt: `${imagePrompt}

Important: no words, letters, captions, logos, watermarks, phone UI, social media UI, or app interface.
Make it feel like old Catholic devotional artwork: painterly, reverent, textured, emotionally clear.`,
    size: openaiImageSize,
    quality: openaiImageQuality,
    output_format: openaiImageFormat,
    n: 1,
  };

  if (openaiImageFormat === 'jpeg' || openaiImageFormat === 'webp') {
    imageParams.output_compression = openaiImageCompression;
  }

  const response = await client.images.generate(imageParams);

  const base64 = response.data?.[0]?.b64_json;

  if (!base64) {
    throw new Error('OpenAI did not return image data.');
  }

  const buffer = Buffer.from(base64, 'base64');
  const mimeType = `image/${openaiImageFormat === 'jpg' ? 'jpeg' : openaiImageFormat}`;

  return {
    base64,
    buffer,
    mimeType,
    sizeBytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    model: openaiImageModel,
    size: openaiImageSize,
    quality: openaiImageQuality,
  };
}

export async function createDevotionalPostPackage(context = '') {
  if (!client) {
    throw new Error('Missing OPENAI_API_KEY. Add it to .env before creating AI posts.');
  }

  const recentPosts = await getRecentTweetLogs(10);
  const draft = await generateDevotionalPackageDraft({ context, recentPosts });
  const checked = await qualityCheckDevotionalPackage({ postPackage: draft, context, recentPosts });
  const image = await generateImage(checked.imagePrompt);

  return {
    ...checked,
    tweet: checked.text,
    image,
    recentPostCount: recentPosts.length,
  };
}

export async function generateTweet({ currentTweet = '', editInstruction = '' }) {
  if (!client) {
    throw new Error('Missing OPENAI_API_KEY. Add it to .env before editing AI posts.');
  }

  const response = await client.responses.create({
    model: openaiTextModel,
    instructions: `Edit this Ambro devotional post. Keep it fewer than 280 characters.
It must sound human, reverent, clean, and must not include hashtags, emoji, labels, headings, or format names.
Return only the final public text.`,
    input: `Current post:
${currentTweet}

Edit request:
${editInstruction}`,
  });

  return enforceTweetLength(response.output_text?.trim() || '');
}

function bufferFromMaybeBase64({ imageBuffer, imageBase64 }) {
  if (Buffer.isBuffer(imageBuffer)) {
    return imageBuffer;
  }

  if (imageBase64) {
    return Buffer.from(imageBase64, 'base64');
  }

  return null;
}

export async function postToTwitter({
  text,
  imageBuffer = null,
  imageBase64 = '',
  imageMimeType = 'image/jpeg',
  imageAlt = '',
}) {
  const tweet = cleanTweetText(text);

  if (!tweet) {
    throw new Error('Nothing to post yet.');
  }

  assertTweetLength(tweet);

  if (!twitterClient) {
    throw new Error(
      'Missing Twitter credentials. Add TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, and TWITTER_ACCESS_SECRET to .env.',
    );
  }

  const payload = { text: tweet };
  const mediaBuffer = bufferFromMaybeBase64({ imageBuffer, imageBase64 });
  let mediaId = null;

  if (!mediaBuffer) {
    throw Object.assign(new Error('Create an image before posting.'), { code: 400 });
  }

  mediaId = await twitterClient.v2.uploadMedia(mediaBuffer, {
    media_type: imageMimeType,
    media_category: 'tweet_image',
  });

  if (imageAlt) {
    await twitterClient.v2.createMediaMetadata(mediaId, {
      alt_text: { text: imageAlt.slice(0, 1000) },
    });
  }

  payload.media = { media_ids: [mediaId] };

  const response = await twitterClient.v2.tweet(payload);
  const posted = response.data;

  return [
    {
      id: posted.id,
      text: posted.text,
      mediaId,
    },
  ];
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

export async function createAndPostTweet(context = '') {
  const postPackage = await createDevotionalPostPackage(context);
  const postedTweets = await postToTwitter({
    text: postPackage.text,
    imageBuffer: postPackage.image.buffer,
    imageMimeType: postPackage.image.mimeType,
    imageAlt: postPackage.imageAlt,
  });

  await recordPostedTweet({
    postPackage,
    postedTweets,
    source: 'automation',
  });

  return {
    ...postPackage,
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
  const earliestMinute = Math.max(schedulerStartMinute, minimumMinute);
  const offset = schedulerSlotOffsetMinute % schedulerWindowMinutes;
  const remainder = earliestMinute % schedulerWindowMinutes;
  const minutesToNextSlot = (offset - remainder + schedulerWindowMinutes) % schedulerWindowMinutes;
  const firstSlotMinute = earliestMinute + minutesToNextSlot;

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

export async function resetTodaySchedule(now = new Date()) {
  const { dateKey, minuteOfDay } = getLocalDayParts(now);
  const slots = createDailySlots(dateKey, minuteOfDay + schedulerWindowMinutes);

  await setDoc(
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

export async function recordPostedTweet({ postPackage, postedTweets, source }) {
  const imageBuffer =
    postPackage.image?.buffer ||
    (postPackage.image?.base64 ? Buffer.from(postPackage.image.base64, 'base64') : null);
  const imageSha256 =
    postPackage.image?.sha256 || (imageBuffer ? createHash('sha256').update(imageBuffer).digest('hex') : null);

  await setDoc(
    doc(db, 'tweetLog', postedTweets[0].id),
    {
      tweet: postPackage.text || postPackage.tweet,
      imagePrompt: postPackage.imagePrompt || '',
      imageAlt: postPackage.imageAlt || '',
      imageMimeType: postPackage.image?.mimeType || postPackage.imageMimeType || null,
      imageSha256,
      imageModel: postPackage.image?.model || openaiImageModel,
      imageSize: postPackage.image?.size || openaiImageSize,
      sourceType: postPackage.sourceType || null,
      theme: postPackage.theme || null,
      postedTweetId: postedTweets[0].id,
      postedTweets,
      source,
      createdAt: serverTimestamp(),
    },
    { merge: true },
  );
}
