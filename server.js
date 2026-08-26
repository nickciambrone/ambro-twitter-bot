import 'dotenv/config';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import { doc, getDoc, getFirestore, runTransaction, serverTimestamp } from 'firebase/firestore';
import OpenAI from 'openai';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(__dirname, 'public');
const port = Number(process.env.PORT || 3000);
const client = process.env.OPENAI_API_KEY ? new OpenAI() : null;
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
const localRotationPath = join(__dirname, '.data', 'rotation.json');

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const tweetFormats = [
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
      'Write a longer post or short thread explaining something fascinating: historical context, apparent contradictions, symbolism, translations, or a whole passage. Use 2-4 tight numbered tweets only if the idea needs a thread.',
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
tweet or thread text.`;

const qualityCheckPrompt = `You are the final editor for Ambro social posts.
Rewrite only when needed. The final output must:
- sound like a thoughtful human wrote it, not a content template
- be original, clean, concrete, and natural
- avoid generic inspirational filler
- avoid clout-chasing, engagement bait, hashtags, and emoji
- avoid theological overclaiming or careless Bible context
- contain no private format labels, category names, headings, or prefaces
- return only the final public-facing tweet or thread text`;

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

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function normalizeRotationIndex(value) {
  return Number.isInteger(value) && value >= 0 ? value % tweetFormats.length : 0;
}

function serializeFormat(format) {
  return {
    id: format.id,
    name: format.name,
    guidance: format.guidance,
  };
}

async function getCurrentFormat() {
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

async function advanceFormat(expectedIndex, generatedTweet) {
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

  await mkdir(join(__dirname, '.data'), { recursive: true });
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

Return the final cleaned post only.`,
  });

  const checked = response.output_text?.trim();

  if (!checked) {
    throw new Error('OpenAI returned an empty checked tweet.');
  }

  return stripFormatLeakage(checked);
}

async function generateTweet({ context = '', currentTweet = '', editInstruction = '', format = null }) {
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

  const text = stripFormatLeakage(response.output_text?.trim() || '');

  if (!text) {
    throw new Error('OpenAI returned an empty tweet.');
  }

  return qualityCheckTweet({ tweet: text, format, editInstruction });
}

async function handleApi(request, response) {
  try {
    if (request.method === 'GET' && request.url === '/api/rotation') {
      const { format, source } = await getCurrentFormat();
      sendJson(response, 200, {
        nextFormat: serializeFormat(format),
        formats: tweetFormats.map(serializeFormat),
        source,
      });
      return;
    }

    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'Method not allowed.' });
      return;
    }

    const body = await readJson(request);

    if (request.url === '/api/create-tweet') {
      const { index, format } = await getCurrentFormat();
      const tweet = await generateTweet({ context: String(body.context || ''), format });
      const rotation = await advanceFormat(index, tweet);

      sendJson(response, 200, {
        tweet,
        format: serializeFormat(format),
        nextFormat: serializeFormat(rotation.nextFormat),
        rotationSource: rotation.source,
        rotationShifted: rotation.rotationShifted,
      });
      return;
    }

    if (request.url === '/api/edit-tweet') {
      const currentTweet = String(body.tweet || '').trim();
      const editInstruction = String(body.instruction || '').trim();

      if (!currentTweet || !editInstruction) {
        sendJson(response, 400, { error: 'Send a tweet and edit instruction.' });
        return;
      }

      const tweet = await generateTweet({ currentTweet, editInstruction });
      sendJson(response, 200, { tweet });
      return;
    }

    if (request.url === '/api/post-tweet') {
      const tweet = String(body.tweet || '').trim();

      if (!tweet) {
        sendJson(response, 400, { error: 'Nothing to post yet.' });
        return;
      }

      sendJson(response, 200, {
        id: `mock-${Date.now()}`,
        status: 'mocked',
        tweet,
        postedAt: new Date().toISOString(),
      });
      return;
    }

    sendJson(response, 404, { error: 'API route not found.' });
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : 'Something went wrong.',
    });
  }
}

async function serveStatic(request, response) {
  const requestedPath = request.url === '/' ? '/index.html' : request.url || '/index.html';
  const pathname = decodeURIComponent(requestedPath.split('?')[0]);
  const filePath = normalize(join(publicDir, pathname));

  if (!filePath.startsWith(publicDir)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  try {
    const file = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream',
    });
    response.end(file);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
}

createServer((request, response) => {
  if (request.url?.startsWith('/api/')) {
    void handleApi(request, response);
    return;
  }

  void serveStatic(request, response);
}).listen(port, () => {
  console.log(`Ambro X Bot listening on http://localhost:${port}`);
});
