import { readFileSync, writeFileSync } from "fs";
import { sendNotification } from "opengluck-apn";
import { request } from "https";

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
          const timestamp = JSON.parse(data || "null")?.[0].timestamp;
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
    req.setHeader("Authorization", `Bearer ${process.env.OPENGLUCK_TOKEN}`);
    req.end();
  });
}

let timezoneShift = getTimezoneShift();
setInterval(function () {
  timezoneShift = getTimezoneShift();
}, 300e3);

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

async function getIsNight() {
  const shift = await timezoneShift;
  const currentHour = new Date(Date.now() + shift).getHours();
  const isNight = (currentHour >= 0 && currentHour < 9) || currentHour >= 22;
  return isNight;
}

setInterval(async () => {
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
  console.log("Will send notification:", notification);
  await sendNotification(notification);
}, 60e3);

setInterval(async () => {
  // check if we are still low and have not received a new reading in over 90s
  const lastMgDl = readTmpData("lastMgDl");
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
  const instantIsRecent = instantAge !== null && instantAge < 90e3;
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

  console.log("Will send stalled low notification:", notification);
  await sendNotification(notification);
}, 60e3);

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
  if (last && last["low-records"]) {
    writeTmpData("lowRecords", last["low-records"]);
  }

  if (url === "/instant-new") {
    console.log(`instant-new: mgDl=${data.mgDl}, timestamp=${data.timestamp}`);
    writeTmpData("lastInstantMgDl", data.mgDl);
    writeTmpData("lastInstantAt", Date.now());
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
    if (!isLow(previousMgDl)) {
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
      const sinceMinutes = convertMillisecondsToHoursAndMinutesString(
        new Date(newTimestamp).getTime() - getTimestampOfEvent("low").getTime(),
      );
      notification.alert = {
        title: `\u{1F6A8} Still Low, Since ${sinceMinutes}`,
        body: `${newMgDl} mg/dL`,
      };
      notification.category = "LOW";
    }
    return;
  } else {
    setTimestampOfEvent("low-notice", new Date(0).toISOString());
  }
  if (isHigh(newMgDl)) {
    if (isHigh(previousMgDl)) {
      const highNoticeSince = getTimestampOfEvent("high-notice");
      const highSince = lastHighTimestamp;
      const elapsedNotice = new Date(newTimestamp) - highNoticeSince;
      const elapsed = new Date(newTimestamp) - highSince;
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
    const sinceMinutes = convertMillisecondsToHoursAndMinutesString(
      new Date(newTimestamp).getTime() - getTimestampOfEvent("low").getTime(),
    );
    notification.alert = {
      title: "\u2705 End of Low",
      body: `${newMgDl} mg/dL. Episode lasted ${sinceMinutes}`,
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
    const sinceMinutes = convertMillisecondsToHoursAndMinutesString(
      new Date(newTimestamp).getTime() - lastHighTimestamp.getTime(),
    );
    notification.alert = {
      title: "\u2705 End of High",
      body: `${newMgDl} mg/dL. Episode lasted ${sinceMinutes}`,
    };
    return;
  }
}
