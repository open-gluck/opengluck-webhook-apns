const { sendNotification } = require("opengluck-apn");
const http = require("http");

const port = Number(process.env.PORT || 6501);

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
      console.log(`Received payload at ${new Date()}`);
      const isGlucoseChanged = req.url === "/";
      const isInstant = req.url === "/instant";
      const isInstantNew = req.url === "/instant-new";
      const isLowChanged = req.url === "/low";
      const bodyJSON = Buffer.concat(chunks).toString();
      console.log("Received", bodyJSON);
      const body = JSON.parse(bodyJSON);
      const [data, last] = (function () {
        if (body.data) {
          return [body.data, body.last];
        }
        return [body, {}];
      })();
      console.log("Parsed data", data);
      console.log("Parsed last", last);
      res.end("OK");

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

      if (isLowChanged) {
        await additionalConfig.default({ url: req.url, data, last, notification });
        return;
      }
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
        const result = await additionalConfig.default({ url: req.url, data, last, notification });
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
    });
  });
  s.listen(port);
  console.log(`Listening on port ${port}`);
  console.log("Current date: ", new Date().toLocaleString());
})();
