import { readFileSync, writeFileSync } from "fs";
import { sendNotification } from "opengluck-apn";
import { request } from "https";

const REQUEST_TIMEOUT = 5e3;
const SNOOZE_CACHE_TTL = 60e3;

// Night runs from NIGHT_FROM_HOUR to NIGHT_UNTIL_HOUR in the user's own
// timezone, read from their phone logs. With AUTO_SNOOZE_AT_NIGHT on, every
// non-low notification is snoozed for that window, as if `npm run snooze` had
// been run at NIGHT_FROM_HOUR every evening. Low alerts are never affected.
const NIGHT_FROM_HOUR = 22;
const NIGHT_UNTIL_HOUR = 9;
const AUTO_SNOOZE_AT_NIGHT = true;

async function getTimezoneShift() {
  return new Promise((resolve, reject) => {
    const req = request(
      `${process.env.OPENGLUCK_URL}/opengluck/userdata/log-openglück.phone/lrange?end=1`,
      (res) => {
        let chunks = [];
        res.on("data", (chunk) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          const data = Buffer.concat(chunks).toString();
          if (res.statusCode !== 200) {
            return reject(
              new Error(
                `Unexpected status code ${res.statusCode}: ${data.substring(0, 200)}`,
              ),
            );
          }
          let timestamp;
          try {
            // note the second `?.`: `[]?.[0].timestamp` throws, as optional
            // chaining only short-circuits on a nullish left-hand side
            timestamp = JSON.parse(data || "null")?.[0]?.timestamp;
          } catch (e) {
            return reject(e);
          }
          if (!timestamp) {
            return resolve(0);
          }
          const userTimezoneOffset =
            -parseInt(timestamp.match(/([+-]\d{2}):(\d{2})/)?.[1] || 0) * 60 -
            parseInt(timestamp.match(/([+-]\d{2}):(\d{2})/)?.[2] || 0) *
              Math.sign(
                parseInt(timestamp.match(/([+-]\d{2}):(\d{2})/)?.[1] || 0),
              );
          const thisTimezoneOffset = new Date().getTimezoneOffset();
          const timezoneShift =
            -(userTimezoneOffset - thisTimezoneOffset) * 60e3;
          console.log(
            `Applying a timezone shift of ${timezoneShift / 60e3}m: userTimezoneOffset=${userTimezoneOffset} thisTimezoneOffset=${thisTimezoneOffset}`,
          );
          resolve(timezoneShift);
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(REQUEST_TIMEOUT, () =>
      req.destroy(new Error("Request timed out")),
    );
    req.setHeader("Authorization", `Bearer ${process.env.OPENGLUCK_TOKEN}`);
    req.end();
  });
}

// `timezoneShift` is awaited from every notification path, so it must never
// hold a rejected promise: that would both trip an unhandled rejection at
// startup and throw on every read until the next refresh.
let lastKnownTimezoneShift = 0;
let timezoneShift = Promise.resolve(0);
function refreshTimezoneShift() {
  timezoneShift = getTimezoneShift()
    .then((shift) => {
      lastKnownTimezoneShift = shift;
      return shift;
    })
    .catch((e) => {
      console.error(
        `Could not read timezone shift, keeping ${lastKnownTimezoneShift / 60e3}m`,
        e,
      );
      return lastKnownTimezoneShift;
    });
}
refreshTimezoneShift();
setInterval(refreshTimezoneShift, 300e3);

function fetchSnoozeUntil() {
  return new Promise((resolve, reject) => {
    const req = request(
      `${process.env.OPENGLUCK_URL}/opengluck/userdata/apn-snooze`,
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const data = Buffer.concat(chunks).toString();
          if (res.statusCode !== 200) {
            return reject(
              new Error(
                `Unexpected status code ${res.statusCode}: ${data.substring(0, 200)}`,
              ),
            );
          }
          try {
            resolve(JSON.parse(data || "null")?.until ?? null);
          } catch (e) {
            reject(e);
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(REQUEST_TIMEOUT, () =>
      req.destroy(new Error("Request timed out")),
    );
    req.setHeader("Authorization", `Bearer ${process.env.OPENGLUCK_TOKEN}`);
    req.end();
  });
}

// Only updated on a successful read, so a failing server falls back to the
// last value we actually saw rather than to "not snoozed". Expiry is always
// recomputed against the wall clock, so a cached snooze still lapses on time.
let snoozeCache = { until: null, fetchedAt: 0 };

function snoozeStillActive(until) {
  if (!until) return null;
  return new Date(until).getTime() > Date.now() ? until : null;
}

async function getSnoozedUntil() {
  if (Date.now() - snoozeCache.fetchedAt < SNOOZE_CACHE_TTL) {
    return snoozeStillActive(snoozeCache.until);
  }
  try {
    let until;
    try {
      until = await fetchSnoozeUntil();
    } catch (e) {
      // node keeps connections alive by default, so the first attempt can
      // land on a socket the server has already dropped; retry once before
      // treating this as a real failure
      if (e.code !== "ECONNRESET" && e.code !== "EPIPE") throw e;
      console.log(`Retrying snooze read after ${e.code}`);
      until = await fetchSnoozeUntil();
    }
    snoozeCache = { until, fetchedAt: Date.now() };
    return snoozeStillActive(until);
  } catch (e) {
    console.error(
      `Could not read snooze state, falling back to last known value (${snoozeCache.until})`,
      e,
    );
    return snoozeStillActive(snoozeCache.until);
  }
}

export async function shouldSnooze(notification) {
  if (notification?.category === "LOW") return null;
  if (AUTO_SNOOZE_AT_NIGHT) {
    const nightUntil = await getNightSnoozeUntil();
    // no need to read the manual snooze: we are snoozed either way, and a
    // manual snooze outlasting the night takes over at NIGHT_UNTIL_HOUR
    if (nightUntil) return nightUntil;
  }
  return await getSnoozedUntil();
}

function convertMillisecondsToHoursAndMinutesString(milliseconds) {
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor((milliseconds % 3600000) / 60000);
  if (hours === 0) {
    if (!milliseconds) {
      return "0m";
    } else if (minutes < 1) {
      return "<1m";
    } else {
      return `${minutes}m`;
    }
  }
  if (minutes === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${minutes}m`;
}

function readTmpData(name) {
  try {
    const data = readFileSync(`/tmp/openlibre-webhook-apns-${name}.data`, {
      encoding: "utf8",
    });
    if (!data) {
      return null;
    }
    return JSON.parse(data);
  } catch (e) {
    return null;
  }
}

function writeTmpData(name, data) {
  writeFileSync(
    `/tmp/openlibre-webhook-apns-${name}.data`,
    JSON.stringify(data),
  );
}

function getTimestampOfEvent(event) {
  try {
    const timestamp = readFileSync(
      `/tmp/openlibre-webhook-apns-${event}.timestamp`,
      { encoding: "utf8" },
    );
    if (!timestamp) {
      console.log("getTimestampOfEvent", event, null);
      return null;
    }
    if (timestamp) {
      const result = new Date(timestamp.replace(/\n$/, ""));
      console.log("getTimestampOfEvent", event, result);
      return result;
    }
  } catch (e) {
    console.log("getTimestampOfEvent got error", event, e);
    return null;
  }
}

// /tmp is wiped on reboot, so an event timestamp can be missing even when the
// previous reading says we were in that state. Callers get null and drop the
// "Since ..." part of the message rather than throwing on .getTime().
function getElapsedSinceEvent(event, until) {
  const since = getTimestampOfEvent(event);
  if (!since) {
    console.log(`No stored ${event} timestamp, cannot compute elapsed time`);
    return null;
  }
  return new Date(until).getTime() - since.getTime();
}

function setTimestampOfEvent(event, timestamp) {
  console.log("setTimestampOfEvent", event, timestamp);
  writeFileSync(
    `/tmp/openlibre-webhook-apns-${event}.timestamp`,
    timestamp || "",
  );
}

function isLow(mgDl) {
  return mgDl < 70;
}
function isHigh(mgDl) {
  return mgDl >= 170;
}

// the shift is built so that reading this date with the local getters yields
// the hour the user is actually seeing on their phone
async function getUserLocalNow() {
  return new Date(Date.now() + (await timezoneShift));
}

function isNightHour(hour) {
  if (NIGHT_FROM_HOUR > NIGHT_UNTIL_HOUR) {
    // the window wraps around midnight
    return hour >= NIGHT_FROM_HOUR || hour < NIGHT_UNTIL_HOUR;
  }
  return hour >= NIGHT_FROM_HOUR && hour < NIGHT_UNTIL_HOUR;
}

async function getIsNight() {
  return isNightHour((await getUserLocalNow()).getHours());
}

// null outside of the night, otherwise when the night snooze lapses
async function getNightSnoozeUntil() {
  const shift = await timezoneShift;
  const localNow = new Date(Date.now() + shift);
  if (!isNightHour(localNow.getHours())) {
    return null;
  }
  const localUntil = new Date(localNow);
  localUntil.setHours(NIGHT_UNTIL_HOUR, 0, 0, 0);
  if (localUntil <= localNow) {
    // we are before midnight, so the night ends tomorrow
    localUntil.setDate(localUntil.getDate() + 1);
  }
  return new Date(localUntil.getTime() - shift).toISOString();
}

// setInterval never sees a rejected promise, so every periodic check has to
// swallow its own failures or it takes the whole process down with it
function runPeriodically(name, check, everyMs) {
  setInterval(() => {
    check().catch((e) => console.error(`${name} check failed`, e));
  }, everyMs);
}

async function checkStillHigh() {
  // check if we are still high, and not using real-time data, as this may well
  // be the time to send a reminder
  const highSince = getTimestampOfEvent("high");
  if (!highSince) {
    return;
  }
  const hasRealTime = readTmpData("hasRealTime");
  if (hasRealTime === true) {
    return;
  }
  const isNight = await getIsNight();
  if (isNight) {
    console.log("Skip sending high notice during the night");
    return;
  }
  const highNoticeSince = getTimestampOfEvent("high-notice");
  const highNoticeSinceDuration = highNoticeSince
    ? Date.now() - highNoticeSince
    : null;
  console.log(
    `highNoticeSince=${highNoticeSince}, highSinceNoticeDuration=${highNoticeSinceDuration}`,
  );
  if (highNoticeSinceDuration && highNoticeSinceDuration < 3600e3) {
    console.log(
      `Skip sending still high notice, last notice was sent ${Math.round(
        highNoticeSinceDuration / 60e3,
      )} minutes ago`,
    );
    return;
  }

  // never sent a high notice, or more than 1 hour ago

  const now = new Date().toISOString();
  const elapsed = new Date(now) - highSince;
  let notification = {};
  notification.priority = 10;
  setTimestampOfEvent("high-notice", now);
  notification.sound = "default";
  notification.alert = {
    title: `\u{26A0}\u{fe0f} Still High, Since ${convertMillisecondsToHoursAndMinutesString(
      elapsed,
    )}`,
    body: "Check your blood glucose.",
  };
  const snoozedUntil = await shouldSnooze(notification);
  if (snoozedUntil) {
    console.log(`snoozing this type of notification until ${snoozedUntil}`);
    return;
  }
  console.log("Will send notification:", notification);
  await sendNotification(notification);
}
runPeriodically("still-high", checkStillHigh, 60e3);

async function checkStalledLow() {
  // check if we are still low and have not received a new reading in over 90s
  const lastMgDl = readTmpData("lastMgDl");
  // an explicit number check: readTmpData returns null when the file is
  // missing or truncated, and isLow(null) is true because null coerces to 0
  if (!Number.isFinite(lastMgDl)) {
    return;
  }
  if (!isLow(lastMgDl)) {
    return;
  }
  const lowSince = getTimestampOfEvent("low");
  if (!lowSince) {
    return;
  }
  const lastReceivedAt = readTmpData("lastReceivedAt");
  if (!lastReceivedAt) {
    return;
  }
  const stalledFor = Date.now() - lastReceivedAt;
  if (stalledFor < 90e3) {
    return;
  }

  // skip if a recent low event exists (user already knows)
  if (hasRecentLowRecord()) {
    console.log("Skip sending stall notification, recent low event exists");
    return;
  }

  const lastInstantMgDl = readTmpData("lastInstantMgDl");
  const lastInstantAt = readTmpData("lastInstantAt");
  const instantAge = lastInstantAt ? Date.now() - lastInstantAt : null;
  // the reading and its date are stored in two separate files, so a recent
  // date is no guarantee the value next to it is usable; without a number we
  // have no instant reading at all, whatever its date says
  const instantIsRecent =
    instantAge !== null && instantAge < 90e3 && Number.isFinite(lastInstantMgDl);
  console.log(`Stall check: lastMgDl=${lastMgDl}, stalledFor=${stalledFor}ms, instantMgDl=${lastInstantMgDl}, instantAge=${instantAge}ms, instantIsRecent=${instantIsRecent}`);

  // if recent instant glucose is >= 70, we're out of hypo, skip
  if (instantIsRecent && lastInstantMgDl >= 70) {
    console.log("Skip sending stall notification, recent instant glucose is >= 70 mg/dL");
    return;
  }

  const sinceMinutes = convertMillisecondsToHoursAndMinutesString(
    Date.now() - lowSince.getTime()
  );
  const stalledForStr = convertMillisecondsToHoursAndMinutesString(stalledFor);
  let notification = {};
  notification.priority = 10;
  notification.sound = "default";
  notification.badge = lastMgDl;
  notification.category = "LOW";

  if (instantIsRecent) {
    // we have recent instant glucose, so we haven't truly stalled
    notification.alert = {
      title: `\u{1F6A8} Still Low, Since ${sinceMinutes}`,
      body: `${lastInstantMgDl} mg/dL`,
    };
  } else {
    notification.alert = {
      title: `\u{1F6A8} Still Low, Since ${sinceMinutes}`,
      body: `Stalled for ${stalledForStr} at ${lastMgDl} mg/dL`,
    };
  }

  const snoozedUntil = await shouldSnooze(notification);
  if (snoozedUntil) {
    console.log(`snoozing this type of notification until ${snoozedUntil}`);
    return;
  }
  console.log("Will send stalled low notification:", notification);
  await sendNotification(notification);
}
runPeriodically("stalled-low", checkStalledLow, 60e3);

function hasRecentLow(last) {
  const lowRecords = last["low-records"] || [];
  return lowRecords.some((record) => {
    const elapsed = new Date() - new Date(record.timestamp);
    return elapsed < 30 * 60e3;
  });
}

function hasRecentLowRecord() {
  const lowRecords = readTmpData("lowRecords") || [];
  return lowRecords.some((record) => {
    const elapsed = Date.now() - new Date(record.timestamp).getTime();
    const threshold = record.sugar_in_grams ? 30 * 60e3 : 10 * 60e3;
    return elapsed < threshold;
  });
}

export default async function showAlert({ url, data, last, notification }) {
  // store low-records from every webhook for stall interval use
  if (last?.["low-records"]) {
    writeTmpData("lowRecords", last["low-records"]);
  }

  if (url === "/low") {
    console.log(`low: low-records=${JSON.stringify(last?.["low-records"])}`);
    return;
  }

  if (url === "/instant-new") {
    console.log(`instant-new: mgDl=${data.mgDl}, timestamp=${data.timestamp}`);
    const previousInstantTimestamp = readTmpData("lastInstantTimestamp");
    const newInstantTimestamp = new Date(data.timestamp).getTime();
    if (!previousInstantTimestamp || newInstantTimestamp >= previousInstantTimestamp) {
      writeTmpData("lastInstantMgDl", data.mgDl);
      writeTmpData("lastInstantAt", Date.now());
      writeTmpData("lastInstantTimestamp", newInstantTimestamp);
    } else {
      console.log(`instant-new: skipping old record (${data.timestamp} < ${new Date(previousInstantTimestamp).toISOString()})`);
      return { skip: true };
    }
    notification.contentAvailable = false;
    notification.priority = 5;
    delete notification.sound;
    delete notification.alert;
    return;
  }

  const newMgDl = data.new.mgDl;
  const newTimestamp = data.new.timestamp;
  const previousMgDl = data.previous.mgDl;
  const isNight = await getIsNight();
  const hasRealTime = (data["cgm-properties"] ?? {})["has-real-time"] ?? false;
  const isLowKnown = hasRecentLow(last);
  console.log(
    `isNight=${isNight}, hasRealTime=${hasRealTime}, isLowKnown=${isLowKnown}`,
  );
  writeTmpData("hasRealTime", hasRealTime);
  writeTmpData("lastReceivedAt", Date.now());
  writeTmpData("lastMgDl", newMgDl);
  var lastHighTimestamp = getTimestampOfEvent("high");
  if (!isHigh(newMgDl)) {
    setTimestampOfEvent("high-notice", "");
    setTimestampOfEvent("high", "");
  }
  if (isLow(newMgDl)) {
    //const lowNoticeSince = getTimestampOfEvent("low-notice");
    //const elapsedNotice = new Date(newTimestamp) - lowNoticeSince;
    if (!isLow(previousMgDl) || !getTimestampOfEvent("low")) {
      setTimestampOfEvent("low", newTimestamp);
    }
    if (isLowKnown) {
      console.log(
        "Skip sending low notice, as we already have a recent low record",
      );
      return;
    }
    /*
    if (!isNight) {
      // are we during the day?
      if (elapsedNotice < 10 * 60e3) {
        // do not stack alerts if we were already low and last notice since less than 10m
        return;
      }
    }
    */
    notification.sound = "default";
    // reset low notice timestamp, and send a new alert
    setTimestampOfEvent("low-notice", newTimestamp);
    if (!isLow(previousMgDl)) {
      notification.alert = {
        title: "\u{1F6A8} Low",
        body: `${newMgDl} mg/dL`,
      };
      notification.category = "LOW";
    } else {
      const elapsedLow = getElapsedSinceEvent("low", newTimestamp);
      notification.alert = {
        title:
          elapsedLow === null
            ? "\u{1F6A8} Still Low"
            : `\u{1F6A8} Still Low, Since ${convertMillisecondsToHoursAndMinutesString(
                elapsedLow,
              )}`,
        body: `${newMgDl} mg/dL`,
      };
      notification.category = "LOW";
    }
    return;
  } else {
    setTimestampOfEvent("low-notice", new Date(0).toISOString());
  }
  if (isHigh(newMgDl)) {
    // without a stored "high" timestamp we cannot say how long this episode
    // has run, so treat it as a fresh high rather than reporting a bogus
    // duration measured from the epoch
    if (isHigh(previousMgDl) && lastHighTimestamp) {
      const highNoticeSince = getTimestampOfEvent("high-notice");
      const elapsed = new Date(newTimestamp) - lastHighTimestamp;
      const elapsedNotice = highNoticeSince
        ? new Date(newTimestamp) - highNoticeSince
        : Infinity;
      if (elapsedNotice < 60 * 60e3) {
        // do not stack alerts if we were already high and last notice since less than 1 hour
        return;
      } else {
        // reset high notice timestamp, and send a new alert
        setTimestampOfEvent("high-notice", newTimestamp);
        if (isNight) {
          delete notification.sound;
        } else {
          notification.sound = "default";
        }
        notification.alert = {
          title: `\u{26A0}\u{fe0f} Still High, Since ${convertMillisecondsToHoursAndMinutesString(
            elapsed,
          )}`,
          body: `${newMgDl} mg/dL`,
        };
        return;
      }
    } else {
      setTimestampOfEvent("high", newTimestamp);
      setTimestampOfEvent("high-notice", newTimestamp);
      notification.sound = "default";
      notification.alert = {
        title: "\u{26A0}\u{fe0f} High",
        body: `${newMgDl} mg/dL`,
      };
      return;
    }
  } else {
    setTimestampOfEvent("high-notice", new Date(0).toISOString());
  }
  if (isLow(previousMgDl)) {
    if (!hasRealTime) {
      // do not send a notification alert if we are not using real-time data,
      // we already know this as we manually scanned
      return;
    }
    if (isNight) {
      delete notification.sound;
    } else {
      notification.sound = "default";
    }
    const elapsedLow = getElapsedSinceEvent("low", newTimestamp);
    notification.alert = {
      title: "\u2705 End of Low",
      body:
        elapsedLow === null
          ? `${newMgDl} mg/dL`
          : `${newMgDl} mg/dL. Episode lasted ${convertMillisecondsToHoursAndMinutesString(
              elapsedLow,
            )}`,
    };
    return;
  }
  if (isHigh(previousMgDl)) {
    if (!hasRealTime) {
      // do not send a notification alert if we are not using real-time data,
      // we already know this as we manually scanned
      return;
    }
    if (isNight) {
      delete notification.sound;
    } else {
      notification.sound = "default";
    }
    const elapsedHigh = lastHighTimestamp
      ? new Date(newTimestamp).getTime() - lastHighTimestamp.getTime()
      : null;
    notification.alert = {
      title: "\u2705 End of High",
      body:
        elapsedHigh === null
          ? `${newMgDl} mg/dL`
          : `${newMgDl} mg/dL. Episode lasted ${convertMillisecondsToHoursAndMinutesString(
              elapsedHigh,
            )}`,
    };
    return;
  }
}
