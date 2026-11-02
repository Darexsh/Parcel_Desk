# LBC Express

Tracks Philippine LBC shipments through the Android app's guest SOAP API. Domestic waybills have twelve digits, and only those suggest LBC; the tracker also answers for ten-, eleven- and fourteen-digit numbers, which many carriers share, so LBC tracks them when the caller names it. The shared subscription key is included, so no account or browser setup is needed for this tier.

A configured local Chromium browser recovers from a refused key, transport failure or inconclusive mobile response. It opens the public tracking page through the page's own `tracking-number` link, whose script posts a `track_package` request to WordPress's `admin-ajax.php` with a nonce from the page, and reads that request's reply. Only the page's request for the whole number is read. The reply is the app service's result copied into JSON, so both tiers read the same scans the same way. The request also answers over plain HTTP with the nonce and cookies of a fetched tracking page. Rate limits and malformed or mismatched replies end the lookup.

The mobile gateway's explicit [Cloudflare origin error](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1000/) is a transport failure, including when it arrives with HTTP 403. It does not establish key rejection.

A fresh browser context keeps the lookup isolated. The browser completes the website's automatic JavaScript protection; interactive challenges remain failures. The result must name the requested number before any history is projected. A remittance number's answer and empty history are inconclusive in both tiers: neither establishes that a parcel is missing.

Both tiers supply local scan clocks without offsets; they stay in `local_time`. Neither tier invents an update or delivery instant. History is current first, exact duplicate rows are removed, and the names in delivered-to and released-to rows are discarded. A scan takes its branch's town and province as its location; a forwarding scan carries its destination's, so it gets none. Status code 0 covers several kinds of scan, so its stage comes from LBC's wording. Scans stored without a town, or with a representative's name, keep their identity when they gain the town or lose the name.

## Mobile app

The [Android app](https://play.google.com/store/apps/details?id=com.lbcexpress.lbcapp)
`com.lbcexpress.lbcapp` tracks guests without a browser. It posts a
SOAP 1.1 `LBCTrackAndTrace` envelope (namespace `http://tempuri.org/`, one
`TrackingNo` element) to `https://lbcapigateway.lbcapps.com/lbctrackingapi2/v2`.
Use `Content-Type: text/xml; charset=utf-8`, SOAP action
`http://tempuri.org/LBCTrackAndTrace`, and the subscription key in `lbcOAKey`.

The app obtains `lbcTrackAndTraceOAKey` from Firebase Remote Config. Its packaged
Firebase configuration identifies the project and app; the standard
[Firebase installation](https://github.com/firebase/firebase-android-sdk/blob/main/firebase-installations/src/main/java/com/google/firebase/installations/remote/FirebaseInstallationServiceClient.java)
and [Remote Config fetch](https://github.com/firebase/firebase-android-sdk/blob/main/firebase-config/src/main/java/com/google/firebase/remoteconfig/internal/ConfigFetchHttpClient.java)
requests retrieve that parameter for a guest installation. No LBC account or
browser session is required. Issued installation tokens stay outside the repository;
the shared tracking key is included with the maintainer's approval.

The HTTPS gateway accepts the retrieved key without a browser. Its XML result supplies
`TrackingDetails/TrackingNo` and individual `TrackingHistory` scans, including
separate local date and time fields without a UTC offset. Recipient and sender
details must be discarded. The service also recognizes remittance identifiers;
that response is not evidence that a parcel is missing. The adapter uses the
included key rather than registering an installation for each lookup. A revoked
key needs a new release; browser retrieval remains available.

## Requirements

`TRACKING_CHROMIUM_PATH` enables browser recovery. Automatic key refresh, browser-service retrieval, estimates and pickup points are not implemented. Provide `LBC_TRACKING_NUMBER` outside Git for a positive live lookup.

`npm run test:carriers:live -- carriers/lbc-express`
