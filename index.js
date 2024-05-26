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
      const isInstant = req.url === "/instant";
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

      const newGlucose = data.new.mgDl;
      const newTimestamp = data.new.timestamp;
      const cgmProperties = data["cgm-properties"] || {};
      const currentCgmHasRealTime = !!cgmProperties["has-real-time"];

      console.log(
        `isInstant=${isInstant}, cgmProperties=${cgmProperties}, currentDeviceHasCgmRealtimeData=${currentCgmHasRealTime}`,
      );

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
      };
      await additionalConfig.default({ data, last, notification });
      console.log("Will send notification:", notification);
      await sendNotification(notification);
    });
  });
  s.listen(port);
  console.log(`Listening on port ${port}`);
  console.log("Current date: ", new Date().toLocaleString());
})();
