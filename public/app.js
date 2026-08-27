const createTweetButton = document.querySelector('#createTweetButton');
const editTweetButton = document.querySelector('#editTweetButton');
const postTweetButton = document.querySelector('#postTweetButton');
const clearLogButton = document.querySelector('#clearLogButton');
const tweetContext = document.querySelector('#tweetContext');
const tweetPreview = document.querySelector('#tweetPreview');
const imagePreview = document.querySelector('#imagePreview');
const imagePlaceholder = document.querySelector('#imagePlaceholder');
const editInstruction = document.querySelector('#editInstruction');
const characterCount = document.querySelector('#characterCount');
const tweetLog = document.querySelector('#tweetLog');
const toast = document.querySelector('#toast');
const connectionStatus = document.querySelector('#connectionStatus');
const nextFormat = document.querySelector('#nextFormat');

const logStorageKey = 'ambro-x-bot-log';
const maxTweetLength = 279;
let tweets = loadLog();
let currentPackage = null;

function loadLog() {
  try {
    return JSON.parse(localStorage.getItem(logStorageKey)) || [];
  } catch {
    return [];
  }
}

function saveLog() {
  localStorage.setItem(localStorageKey(), JSON.stringify(tweets));
}

function localStorageKey() {
  return logStorageKey;
}

function hasImage() {
  return Boolean(currentPackage?.imageBase64);
}

function setLoading(isLoading, label = 'Working') {
  document.body.classList.toggle('is-loading', isLoading);
  createTweetButton.disabled = isLoading;
  editTweetButton.disabled = isLoading || !tweetPreview.value.trim();
  postTweetButton.disabled =
    isLoading || !tweetPreview.value.trim() || tweetPreview.value.length > maxTweetLength || !hasImage();
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
  postTweetButton.disabled =
    length > maxTweetLength ||
    !tweetPreview.value.trim() ||
    !hasImage() ||
    document.body.classList.contains('is-loading');
  editTweetButton.disabled = !tweetPreview.value.trim() || document.body.classList.contains('is-loading');
}

function setImagePreview(postPackage) {
  if (!postPackage?.imageBase64) {
    imagePreview.hidden = true;
    imagePreview.removeAttribute('src');
    imagePlaceholder.hidden = false;
    return;
  }

  imagePreview.src = `data:${postPackage.imageMimeType || 'image/jpeg'};base64,${postPackage.imageBase64}`;
  imagePreview.alt = postPackage.imageAlt || 'Generated sacred artwork preview.';
  imagePreview.hidden = false;
  imagePlaceholder.hidden = true;
}

function renderLog() {
  tweetLog.innerHTML = '';

  if (!tweets.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-log';
    empty.textContent = 'No posts yet.';
    tweetLog.append(empty);
    return;
  }

  for (const item of tweets) {
    const li = document.createElement('li');
    li.className = 'log-item';

    const meta = document.createElement('div');
    meta.className = 'log-meta';
    const theme = item.theme ? `${item.theme} · ` : '';
    meta.textContent = `${theme}${item.status} · ${new Date(item.createdAt).toLocaleString([], {
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

async function refreshModeStatus() {
  try {
    const payload = await getJson('/api/recent-posts');
    nextFormat.textContent = `Avoiding last ${payload.posts?.length || 0}`;
  } catch {
    nextFormat.textContent = 'Firebase log check';
  }
}

function addLogEntry(postPackage, status) {
  tweets = [
    {
      id: crypto.randomUUID(),
      tweet: postPackage.tweet || postPackage.text,
      status,
      theme: postPackage.theme || '',
      sourceType: postPackage.sourceType || '',
      createdAt: new Date().toISOString(),
    },
    ...tweets,
  ].slice(0, 20);

  saveLog();
  renderLog();
}

createTweetButton.addEventListener('click', async () => {
  setLoading(true, 'Creating post and image');

  try {
    const postPackage = await postJson('/api/create-tweet', {
      context: tweetContext.value.trim(),
    });

    currentPackage = postPackage;
    tweetPreview.value = postPackage.tweet;
    setImagePreview(postPackage);
    updateCharacterCount();
    addLogEntry(postPackage, 'drafted');
    nextFormat.textContent = `Avoided last ${postPackage.recentPostCount}`;
    showToast('Post package created.');
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(false);
  }
});

editTweetButton.addEventListener('click', async () => {
  setLoading(true, 'Editing post');

  try {
    const { tweet } = await postJson('/api/edit-tweet', {
      tweet: tweetPreview.value.trim(),
      instruction: editInstruction.value.trim(),
    });

    tweetPreview.value = tweet;
    currentPackage = currentPackage ? { ...currentPackage, tweet, text: tweet } : null;
    editInstruction.value = '';
    updateCharacterCount();
    addLogEntry({ ...(currentPackage || {}), tweet }, 'ai edited');
    showToast('Post updated.');
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
      imageBase64: currentPackage?.imageBase64 || '',
      imageMimeType: currentPackage?.imageMimeType || 'image/jpeg',
      imagePrompt: currentPackage?.imagePrompt || '',
      imageAlt: currentPackage?.imageAlt || '',
      sourceType: currentPackage?.sourceType || '',
      theme: currentPackage?.theme || '',
    });

    addLogEntry({ ...(currentPackage || {}), tweet: payload.tweet }, payload.status);
    await refreshModeStatus();
    showToast('Post sent to X.');
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
  showToast('Local log cleared.');
});

tweetPreview.addEventListener('input', () => {
  if (currentPackage) {
    currentPackage = { ...currentPackage, tweet: tweetPreview.value, text: tweetPreview.value };
  }

  updateCharacterCount();
});

renderLog();
setImagePreview(null);
updateCharacterCount();
refreshModeStatus();
