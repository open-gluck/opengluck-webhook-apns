const { sendNotification } = require("opengluck-apn");
const http = require("http");

const port = Number(process.env.PORT || 6501);

// This process is a notification daemon with no in-memory state worth
// protecting: everything durable lives under /tmp. Dying on an unexpected
// throw means no more alerts at all — including lows — until someone
// notices and restarts it, so we log and keep running instead.
process.on("unhandledRejection", (e) => {
  console.error("Unhandled rejection, staying alive", e);
});
process.on("uncaughtException", (e) => {
  console.error("Uncaught exception, staying alive", e);
});

(async () => {
  const additionalConfig = await (async () => {
    try {
      return await import("./config.mjs");
    } catch (e) {
      console.error(e);
      return { default: async () => {} };
    }
  })();

  // create an HTTP server on port 6501
  const s = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      // acknowledge before doing any work, so a malformed payload or a
      // notification failure never leaves the sender hanging
      res.end("OK");
      try {
        await handlePayload(req.url, Buffer.concat(chunks).toString());
      } catch (e) {
        console.error(`Error while handling payload for ${req.url}`, e);
      }
    });

    async function handlePayload(url, bodyJSON) {
      console.log(`Received payload at ${new Date()}`);
      const isGlucoseChanged = url === "/";
      const isInstant = url === "/instant";
      const isInstantNew = url === "/instant-new";
      const isLowChanged = url === "/low";
      console.log("Received", bodyJSON);
      const body = JSON.parse(bodyJSON);
      const [data, last] = (function () {
        if (body.data) {
          // `last` is only present when the webhook is configured with
          // "include last"; downstream code always expects an object
          return [body.data, body.last || {}];
        }
        return [body, {}];
      })();
      console.log("Parsed data", data);
      console.log("Parsed last", last);

      if (isLowChanged) {
        await additionalConfig.default({ url, data, last });
        return;
      }

      const newGlucose = data.mgDl ?? data.new.mgDl;
      const newTimestamp = data.timestamp ?? data.new.timestamp;
      const newDate = new Date(newTimestamp);
      const cgmProperties = data["cgm-properties"] || {};
      const glucoseRecords = last["glucose-records"] || [];
      const isNewScanOrHistoric = glucoseRecords.some(
        (record) => new Date(record.timestamp).getTime() === newDate.getTime(),
      );
      const currentCgmHasRealTime = !!cgmProperties["has-real-time"];

      console.log(
        `isGlucoseChanged=${isGlucoseChanged} isInstant=${isInstant} isInstantNew=${isInstantNew}, cgmProperties=${cgmProperties}, currentDeviceHasCgmRealtimeData=${currentCgmHasRealTime}, newTimestamp=${newTimestamp}, isNewScanOrHistoric=${isNewScanOrHistoric}`,
      );

      if (isInstant) {
        // deprecated, we now use isInstantNew
        return;
      }

      // sending notification
      let notification = {};

      notification.contentAvailable = !isInstant;
      notification.priority = isInstant ? 5 : 10;
      notification.sound = "default";
      notification.badge = newGlucose;
      notification.payload = {
        mgDl: newGlucose,
        timestamp: newTimestamp,
        hasRealTime: currentCgmHasRealTime,
        isNewScanOrHistoric,
      };
      if (!isInstant) {
        const result = await additionalConfig.default({ url, data, last, notification });
        if (result && result.skip) {
          return;
        }
      }
      const snoozedUntil = additionalConfig.shouldSnooze
        ? await additionalConfig.shouldSnooze(notification)
        : null;
      if (snoozedUntil) {
        console.log(
          `snoozing this type of notification until ${snoozedUntil}, sending silent badge update`,
        );
        delete notification.alert;
        delete notification.sound;
        notification.contentAvailable = true;
        notification.priority = 5;
      }
      console.log("Will send notification:", notification);
      await sendNotification(notification);
    }
  });
  s.listen(port);
  console.log(`Listening on port ${port}`);
  console.log("Current date: ", new Date().toLocaleString());
})();
