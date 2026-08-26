const createTweetButton = document.querySelector('#createTweetButton');
const editTweetButton = document.querySelector('#editTweetButton');
const postTweetButton = document.querySelector('#postTweetButton');
const clearLogButton = document.querySelector('#clearLogButton');
const tweetContext = document.querySelector('#tweetContext');
const tweetPreview = document.querySelector('#tweetPreview');
const editInstruction = document.querySelector('#editInstruction');
const characterCount = document.querySelector('#characterCount');
const tweetLog = document.querySelector('#tweetLog');
const toast = document.querySelector('#toast');
const connectionStatus = document.querySelector('#connectionStatus');
const nextFormat = document.querySelector('#nextFormat');

const logStorageKey = 'ambro-x-bot-log';
const maxTweetLength = 279;
let tweets = loadLog();
let currentFormat = null;
let currentTweetFormat = null;

function loadLog() {
  try {
    return JSON.parse(localStorage.getItem(logStorageKey)) || [];
  } catch {
    return [];
  }
}

function saveLog() {
  localStorage.setItem(logStorageKey, JSON.stringify(tweets));
}

function setLoading(isLoading, label = 'Working') {
  document.body.classList.toggle('is-loading', isLoading);
  createTweetButton.disabled = isLoading;
  editTweetButton.disabled = isLoading;
  postTweetButton.disabled = isLoading || tweetPreview.value.length > maxTweetLength;
  connectionStatus.textContent = isLoading ? label : 'OpenAI ready';
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('is-visible');
  window.setTimeout(() => toast.classList.remove('is-visible'), 2600);
}

function updateCharacterCount() {
  const length = tweetPreview.value.length;
  characterCount.textContent = `${length} / 279`;
  characterCount.classList.toggle('is-over', length > maxTweetLength);
  postTweetButton.disabled = length > maxTweetLength || document.body.classList.contains('is-loading');
}

function renderLog() {
  tweetLog.innerHTML = '';

  if (!tweets.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-log';
    empty.textContent = 'No tweets yet.';
    tweetLog.append(empty);
    return;
  }

  for (const item of tweets) {
    const li = document.createElement('li');
    li.className = 'log-item';

    const meta = document.createElement('div');
    meta.className = 'log-meta';
    const formatLabel = item.format?.name ? `${item.format.name} · ` : '';
    meta.textContent = `${formatLabel}${item.status} · ${new Date(item.createdAt).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })}`;

    const text = document.createElement('p');
    text.textContent = item.tweet;

    li.append(meta, text);
    tweetLog.append(li);
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || 'Request failed.');
  }

  return payload;
}

async function getJson(url) {
  const response = await fetch(url);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || 'Request failed.');
  }

  return payload;
}

function setNextFormat(format) {
  currentFormat = format;
  nextFormat.textContent = format?.name ? `Next: ${format.name}` : 'Next format unavailable';
}

async function refreshRotation() {
  try {
    const payload = await getJson('/api/rotation');
    setNextFormat(payload.nextFormat);
  } catch (error) {
    setNextFormat(null);
    showToast(error.message);
  }
}

function addLogEntry(tweet, status, format = null) {
  tweets = [
    {
      id: crypto.randomUUID(),
      tweet,
      status,
      format,
      createdAt: new Date().toISOString(),
    },
    ...tweets,
  ].slice(0, 20);

  saveLog();
  renderLog();
}

createTweetButton.addEventListener('click', async () => {
  setLoading(true, currentFormat?.name ? `Creating: ${currentFormat.name}` : 'Creating tweet');

  try {
    const { tweet, format, nextFormat: upcomingFormat } = await postJson('/api/create-tweet', {
      context: tweetContext.value.trim(),
    });

    tweetPreview.value = tweet;
    currentTweetFormat = format;
    updateCharacterCount();
    addLogEntry(tweet, 'drafted', format);
    setNextFormat(upcomingFormat);
    showToast(`${format.name} created.`);
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(false);
  }
});

editTweetButton.addEventListener('click', async () => {
  setLoading(true, 'Editing tweet');

  try {
    const { tweet } = await postJson('/api/edit-tweet', {
      tweet: tweetPreview.value.trim(),
      instruction: editInstruction.value.trim(),
    });

    tweetPreview.value = tweet;
    editInstruction.value = '';
    updateCharacterCount();
    addLogEntry(tweet, 'ai edited');
    showToast('Tweet updated.');
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(false);
  }
});

postTweetButton.addEventListener('click', async () => {
  setLoading(true, 'Posting');

  try {
    const payload = await postJson('/api/post-tweet', {
      tweet: tweetPreview.value.trim(),
      format: currentTweetFormat,
    });

    addLogEntry(payload.tweet, payload.status);
    showToast('Tweet posted.');
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(false);
  }
});

clearLogButton.addEventListener('click', () => {
  tweets = [];
  saveLog();
  renderLog();
  showToast('Log cleared.');
});

tweetPreview.addEventListener('input', updateCharacterCount);

renderLog();
updateCharacterCount();
refreshRotation();
