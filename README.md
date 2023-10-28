# opengluck-webhook-apns

This plugin send a notification to an iOS app of your choosing. The
notification will update a badge, showing the current blood glucose.

It is very basic but works if you don't need anything else.

## Configuration

Checkout both this repository and `opengluck-apn` in the same directory, and
configure APNs in the latter module.

Next, [install the `glucose:changed` webhook in
opengluck](https://opengluck.christopher.dev.api.makesuccess.io/webhooks/glucose:changed):

- http://host.docker.internal:6501
- enable sending last data

### Configuration

Copy the file `sample/config.mjs` in the root of the repository and use it as a starting point:

```bash
cp sample/config.mjs .
```

By default, the config will send notifications when low/high events occur, when you return in the normal range, and will send repeat notifications for lows.
