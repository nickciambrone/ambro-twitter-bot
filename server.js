import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertTweetLength,
  createTweetFromRotation,
  generateTweet,
  getCurrentFormat,
  getErrorStatus,
  getPublicErrorMessage,
  getScheduledPostStatus,
  getTwitterAccount,
  postToTwitter,
  recordPostedTweet,
  serializeFormat,
  tweetFormats,
} from './src/botCore.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(__dirname, 'public');
const port = Number(process.env.PORT || 3000);

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

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

    if (request.method === 'GET' && request.url === '/api/twitter-status') {
      const account = await getTwitterAccount();
      sendJson(response, 200, {
        connected: true,
        account: {
          id: account.id,
          username: account.username,
          name: account.name,
        },
      });
      return;
    }

    if (request.method === 'GET' && request.url === '/api/schedule-status') {
      sendJson(response, 200, await getScheduledPostStatus());
      return;
    }

    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'Method not allowed.' });
      return;
    }

    const body = await readJson(request);

    if (request.url === '/api/create-tweet') {
      const result = await createTweetFromRotation(String(body.context || ''));
      sendJson(response, 200, {
        tweet: result.tweet,
        format: serializeFormat(result.format),
        nextFormat: serializeFormat(result.nextFormat),
        rotationSource: result.rotationSource,
        rotationShifted: result.rotationShifted,
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

      assertTweetLength(tweet);
      const postedTweets = await postToTwitter(tweet);

      await recordPostedTweet({
        tweet,
        format: body.format || null,
        postedTweets,
        source: 'manual-ui',
      });

      sendJson(response, 200, {
        id: postedTweets[0].id,
        status: 'posted',
        tweet,
        postedTweets,
        postedAt: new Date().toISOString(),
      });
      return;
    }

    sendJson(response, 404, { error: 'API route not found.' });
  } catch (error) {
    sendJson(response, getErrorStatus(error), {
      error: getPublicErrorMessage(error),
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
