import {
  createAndPostTweet,
  getPublicErrorMessage,
  recordScheduledFailure,
  reserveDueScheduledPost,
} from '../src/botCore.js';

let reservedSlot = null;

try {
  const reservation = await reserveDueScheduledPost();

  if (!reservation.shouldPost) {
    console.log(
      JSON.stringify(
        {
          status: 'skipped',
          reason: 'No scheduled post due.',
          dateKey: reservation.dateKey,
          slots: reservation.slots,
          postedSlots: reservation.postedSlots,
          nextSlot: reservation.nextSlot,
          timeZone: reservation.timeZone,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  console.log(
    JSON.stringify(
      {
        status: 'reserved',
        dateKey: reservation.dateKey,
        slot: reservation.slot,
        slotLabel: reservation.slotLabel,
        timeZone: reservation.timeZone,
      },
      null,
      2,
    ),
  );

  reservedSlot = reservation.slot;
  const result = await createAndPostTweet('Scheduled Ambro post. Keep it timely but evergreen.');

  console.log(
    JSON.stringify(
      {
        status: 'posted',
        slot: reservation.slot,
        theme: result.theme,
        sourceType: result.sourceType,
        tweetId: result.postedTweets[0].id,
        length: result.tweet.length,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(getPublicErrorMessage(error));

  if (typeof reservedSlot === 'number') {
    await recordScheduledFailure(reservedSlot, error);
  }

  process.exit(1);
}
