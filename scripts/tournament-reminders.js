
const admin = require("firebase-admin");

const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.DATABASE_URL,
});

const db = admin.database();

const INTERVAL = 15 * 60 * 1000;
const TWO_HOURS = 2 * 60 * 60 * 1000;
const INDIA_OFFSET = 330 * 60 * 1000;
const BATCH_SIZE = 500;

function indiaDate(timestamp) {
  const d = new Date(timestamp + INDIA_OFFSET);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    day: d.getUTCDate(),
  };
}

function calendarTimeToMs(time, date) {
  const m = String(time || "")
    .trim()
    .match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);

  if (!m) return null;

  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const ampm = m[3].toUpperCase();

  if (hour < 1 || hour > 12 || minute > 59) return null;

  if (hour === 12) hour = 0;
  if (ampm === "PM") hour += 12;

  return Date.UTC(
    date.year,
    date.month,
    date.day,
    hour,
    minute
  ) - INDIA_OFFSET;
}

function getStartMs(t, schedule, now) {
  const hasCalendar =
    t.calendarIndex !== undefined &&
    t.calendarIndex !== null &&
    t.calendarIndex !== "" &&
    !t.isCustom;

  if (hasCalendar) {
    const index = Number.parseInt(t.calendarIndex, 10);
    const slot = schedule[index];

    if (index >= 0 && index < 8 && slot && slot.time) {
      const start = calendarTimeToMs(
        slot.time,
        indiaDate(now)
      );

      if (start !== null) return start;
    }
  }

  const saved = Number(t.startAt);
  if (Number.isFinite(saved) && saved > 0) return saved;

  const raw = t.matchTime || t.time;
  const parsed = Date.parse(raw || "");

  return Number.isFinite(parsed) ? parsed : null;
}

async function getTokens() {
  const snap = await db.ref("users").once("value");
  const map = new Map();

  snap.forEach((user) => {
    const tokens = user.child("fcmTokens");

    tokens.forEach((item) => {
      const value = item.val() || {};

      const token =
        typeof value === "string"
          ? value
          : value.token;

      if (typeof token === "string" && token.trim()) {
        const cleanToken = token.trim();

        if (!map.has(cleanToken)) {
          map.set(
            cleanToken,
            `users/${user.key}/fcmTokens/${item.key}`
          );
        }
      }
    });
  });

  return {
    tokens: [...map.keys()],
    paths: [...map.values()],
  };
}

async function sendToAll(title, body, tag, data) {
  const { tokens, paths } = await getTokens();

  let success = 0;
  let failure = 0;
  let removed = 0;

  for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
    const batch = tokens.slice(i, i + BATCH_SIZE);
    const batchPaths = paths.slice(i, i + BATCH_SIZE);

    const response = await admin.messaging()
      .sendEachForMulticast({
        tokens: batch,
        data: {
          title: String(title).slice(0, 120),
          body: String(body).slice(0, 1000),
          url: "./",
          tag: String(tag),
          ...data,
        },
        webpush: {
          headers: {
            Urgency: "high",
          },
          fcmOptions: {
            link: "./",
          },
        },
      });

    success += response.successCount;
    failure += response.failureCount;

    const updates = {};

    response.responses.forEach((result, index) => {
      if (!result.success) {
        const code = result.error && result.error.code;

        if (
          code === "messaging/registration-token-not-registered" ||
          code === "messaging/invalid-registration-token"
        ) {
          updates[batchPaths[index]] = null;
        }
      }
    });

    if (Object.keys(updates).length) {
      await db.ref().update(updates);
      removed += Object.keys(updates).length;
    }
  }

  return {
    tokenCount: tokens.length,
    success,
    failure,
    removed,
  };
}

async function main() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("Missing FIREBASE_SERVICE_ACCOUNT secret");
  }

  if (!process.env.DATABASE_URL) {
    throw new Error("Missing DATABASE_URL secret");
  }

  const now = Date.now();

  const [tournamentsSnap, scheduleSnap] = await Promise.all([
    db.ref("tournaments").once("value"),
    db.ref("calendarSchedule").once("value"),
  ]);

  const tournaments = tournamentsSnap.val() || {};
  let schedule = scheduleSnap.val() || [];

  if (!Array.isArray(schedule)) {
    schedule = Object.keys(schedule)
      .sort((a, b) => Number(a) - Number(b))
      .map((key) => schedule[key]);
  }

  for (const [id, t] of Object.entries(tournaments)) {
    if (!t || typeof t !== "object") continue;

    const status = String(t.status || "").toLowerCase();

    if (
      status &&
      !["active", "upcoming", "open"].includes(status)
    ) {
      continue;
    }

    const start = getStartMs(t, schedule, now);

    if (!Number.isFinite(start)) continue;

    const firstReminder = start - TWO_HOURS;

    if (now < firstReminder || now >= start) continue;

    const slotIndex = Math.floor(
      (now - firstReminder) / INTERVAL
    );

    if (slotIndex < 0 || slotIndex >= 8) continue;

    const slotAt = firstReminder + slotIndex * INTERVAL;

    const logRef = db.ref(
      `tournamentReminderLogs/${id}/${slotAt}`
    );

    const claim = await logRef.transaction((old) => {
      if (old && old.status === "sent") return;

      if (
        old &&
        old.status === "sending" &&
        now - Number(old.claimedAt || 0) < 10 * 60 * 1000
      ) {
        return;
      }

      return {
        status: "sending",
        claimedAt: now,
        slotAt,
        startAt: start,
      };
    });

    if (!claim.committed) continue;

    const minutes = Math.max(
      1,
      Math.round((start - now) / 60000)
    );

    try {
      const result = await sendToAll(
        "FF LEAGUE MATCH REMINDER",
        `${t.title || "Your tournament"} starts in about ${minutes} minutes. Open FF LEAGUE to join.`,
        `ff-tournament-${id}-${slotAt}`,
        {
          type: "tournament_reminder",
          tournamentId: String(id),
          startAt: String(start),
          reminderSlot: String(slotIndex + 1),
        }
      );

      await logRef.update({
        status: "sent",
        sentAt: Date.now(),
        tokenCount: result.tokenCount,
        successCount: result.success,
        failureCount: result.failure,
        removedInvalidTokens: result.removed,
      });

      console.log(
        "Reminder sent:",
        id,
        slotIndex + 1,
        result
      );
    } catch (error) {
      await logRef.update({
        status: "failed",
        failedAt: Date.now(),
        error: String(error.message || error).slice(0, 500),
      });

      console.error("Reminder failed:", id, error);
    }
  }

  console.log("All tournament reminders checked.");
}

main()
  .then(async () => {
    await admin.app().delete();
    console.log("Firebase connection closed. Done.");
  })
  .catch(async (error) => {
    console.error("Reminder checker error:", error);

    try {
      await admin.app().delete();
    } catch (closeError) {
      console.error("Firebase close error:", closeError.message);
    }

    process.exitCode = 1;
  });
