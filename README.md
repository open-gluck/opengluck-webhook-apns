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

If you are using a CGM with support for instant glucose, you might also want to
enable the `/instant` route. This will update the badge more often, using a
lesser priority to preserve battery life for these updates.

To do so, [install the `instant-glucose:changed` webhook in
opengluck](https://<your-server>/webhooks/instant-glucose:changed):

- http://host.docker.internal:6501/instant
- enable sending last data

### Configuration

Copy the file `sample/config.mjs` in the root of the repository and use it as a starting point:

```bash
cp sample/config.mjs .
```

By default, the config will send notifications when low/high events occur, when you return in the normal range, and will send repeat notifications for lows.
