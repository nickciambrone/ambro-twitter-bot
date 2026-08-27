import {
  createAndPostTweet,
  getPublicErrorMessage,
  getScheduledPostStatus,
  recordScheduledFailure,
  reserveDueScheduledPost,
  skipPastDueScheduledPosts,
} from '../src/botCore.js';

const checkIntervalMinutes = Number(process.env.LOCAL_SCHEDULER_INTERVAL_MINUTES || 5);
const checkIntervalMs = Math.max(1, checkIntervalMinutes) * 60 * 1000;
const catchUpMissedSlots = process.env.LOCAL_SCHEDULER_CATCH_UP === '1';

let isRunning = false;
let stopped = false;

function log(payload) {
  console.log(
    JSON.stringify(
      {
        at: new Date().toISOString(),
        ...payload,
      },
      null,
      2,
    ),
  );
}

async function runOnce() {
  if (isRunning) {
    log({ status: 'skipped', reason: 'Previous local scheduler check is still running.' });
    return;
  }

  isRunning = true;
  let reservedSlot = null;

  try {
    const reservation = await reserveDueScheduledPost();

    if (!reservation.shouldPost) {
      log({
        status: 'idle',
        reason: 'No scheduled post due.',
        dateKey: reservation.dateKey,
        slots: reservation.slots,
        postedSlots: reservation.postedSlots,
        nextSlot: reservation.nextSlot,
        timeZone: reservation.timeZone,
      });
      return;
    }

    reservedSlot = reservation.slot;
    log({
      status: 'reserved',
      dateKey: reservation.dateKey,
      slot: reservation.slot,
      slotLabel: reservation.slotLabel,
      timeZone: reservation.timeZone,
    });

    const result = await createAndPostTweet('Scheduled Ambro post. Keep it timely but evergreen.');

    log({
      status: 'posted',
      slot: reservation.slot,
      theme: result.theme,
      sourceType: result.sourceType,
      tweetId: result.postedTweets[0].id,
      length: result.tweet.length,
    });
  } catch (error) {
    log({
      status: 'failed',
      error: getPublicErrorMessage(error),
    });

    if (typeof reservedSlot === 'number') {
      await recordScheduledFailure(reservedSlot, error);
    }
  } finally {
    isRunning = false;
  }
}

async function start() {
  log({
    status: 'starting',
    intervalMinutes: checkIntervalMinutes,
    catchUpMissedSlots,
  });

  if (!catchUpMissedSlots) {
    const skipped = await skipPastDueScheduledPosts();
    log({
      status: 'future-only',
      ...skipped,
    });
  }

  log({
    status: 'schedule',
    schedule: await getScheduledPostStatus(),
  });

  await runOnce();

  const timer = setInterval(() => {
    if (!stopped) {
      void runOnce();
    }
  }, checkIntervalMs);

  const stop = () => {
    stopped = true;
    clearInterval(timer);
    log({ status: 'stopped' });
    process.exit(0);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

await start();
