const { getUserdata, setUserdata } = require("opengluck-node-client");

function formatDuration(ms) {
  const sign = ms < 0 ? "-" : "";
  const abs = Math.abs(ms);
  const days = Math.floor(abs / 86400000);
  const hours = Math.floor((abs % 86400000) / 3600000);
  const minutes = Math.floor((abs % 3600000) / 60000);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || !parts.length) parts.push(`${minutes}m`);
  return sign + parts.join(" ");
}

function formatLocal(date) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const local = date.toLocaleString("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${local} ${tz}`;
}

(async () => {
  const arg = process.argv[2];

  if (!arg) {
    const current = await getUserdata("apn-snooze");
    const until = current?.until;
    if (!until) {
      console.log("No active snooze");
      return;
    }
    const untilDate = new Date(until);
    const untilMs = untilDate.getTime();
    const now = Date.now();
    if (untilMs > now) {
      console.log(
        `Currently snoozing non-low notifications until ${until} (${formatLocal(untilDate)}, ${formatDuration(untilMs - now)} remaining)`,
      );
    } else {
      console.log(
        `No active snooze (last snooze expired ${until}, ${formatLocal(untilDate)})`,
      );
    }
    return;
  }

  if (arg === "clear" || arg === "off" || arg === "--clear") {
    await setUserdata("apn-snooze", null);
    console.log("Snooze cleared");
    return;
  }

  const date = new Date(arg);
  if (isNaN(date.getTime())) {
    console.error(`Invalid date: ${arg}`);
    process.exit(1);
  }
  const iso = date.toISOString();
  await setUserdata("apn-snooze", { until: iso });
  console.log(
    `Snoozing non-low notifications until ${iso} (${formatLocal(date)}, ${formatDuration(date.getTime() - Date.now())} from now)`,
  );
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
