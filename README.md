# opengluck-webhook-apns

This plugin send a notification to an iOS app of your choosing. The
notification will update a badge, showing the current blood glucose.

It is very basic but works if you don't need anything else.

## Configuration

Checkout both this repository and `opengluck-apn` in the same directory, and
configure APNs in the latter module.

Next, [install the `glucose:changed` webhook in
opengluck](https://<your-server>/webhooks/glucose:changed):

- http://host.docker.internal:6501
- enable sending last data

### Support for Instant Glucose

If you are using a CGM with support for instant glucose, also add the
`instant-glucose:new` webhook:

- http://host.docker.internal:6501/instant-new
- check "include last"

### Support for Low Changed

Also add the `low:changed` webhook:

- http://host.docker.internal:6501/low
- check "include last"

### Configuration

Copy the file `sample/config.mjs` in the root of the repository and use it as a starting point:

```bash
cp sample/config.mjs .
```

By default, the config will send notifications when low/high events occur, when you return in the normal range, and will send repeat notifications for lows.

## Snoozing non-low notifications

You can temporarily silence every non-low notification (high alerts, end-of-low, end-of-high, instant updates, still-high reminders) until a given date and time. Low alerts are never affected. Snoozed glucose-changed events still ship a silent badge update so the app icon keeps the latest value.

The snooze state is stored on the OpenGluck server under the `apn-snooze` userdata key, so it survives webhook restarts and can be set from any machine that has `OPENGLUCK_URL` and `OPENGLUCK_TOKEN` configured.

The webhook caches the snooze state for a minute and keeps using the last value it read successfully if the server becomes unreachable, so a network outage no longer un-snoozes your notifications. A cached snooze still expires on schedule, and low alerts bypass the cache entirely.

```bash
# Snooze until a specific date/time (any format new Date() accepts)
npm run snooze -- 2026-04-27T20:10+00:00

# Show the current snooze (also prints the time in your local timezone)
npm run snooze

# Clear the snooze
npm run snooze -- clear
```
