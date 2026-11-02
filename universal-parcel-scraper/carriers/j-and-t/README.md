# J&T Express

Tracks J&T Express Indonesia waybills through the tracking router of its consumer app.
The other J&T networks (Philippines, Malaysia, Thailand, Vietnam, Singapore) have no
direct lookup here; [J&T Cargo](../j-and-t-cargo/README.md) is a separate Indonesian
network with its own site and carrier id.

## How it works

1. `direct`: one `POST https://customerapp.jntexpress.id/jandt-app-ifd-web/router.do`
   per waybill, as the
   [Android app](https://play.google.com/store/apps/details?id=com.msd.JTClient)
   `com.msd.JTClient` sends it. The form body is `method=order.massOrderTrack`, `v=1.0`,
   `format=json`, an empty `sessionid`, and `data={"parameter":"{\"billCodes\":\"…\",\"lang\":\"en\"}"}`.
   The `time` header carries the epoch milliseconds and `sign` the MD5 of
   `interface:order.massOrderTrack,time:{time},billCodes:{waybill},secretKey:{secret}`.
   `platform`, `version` and `lang` repeat the app's values; the host's User-Agent is sent.

No account, session, device id, phone digits or CAPTCHA are involved. The signing secret is
compiled into the app, the same in every install, and is included with the maintainer's
approval.

## Notes

- The reply's `data` is a JSON document inside a string. It must hold exactly one bill
  whose `billCode`, and every scan's `billCode`, is the requested waybill.
- The router answers an empty `bills` list for any string it does not hold. That is not
  found only for the prefixes J&T Indonesia issues: `JD`, `JO`, `JX` and `JY` waybills read
  back from the router, and the help centre names `JP`. Other `J` prefixes, `JT` with
  thirteen digits (mostly Philippine) and twelve digits (shared with other networks and
  with J&T Cargo) are inconclusive. That answer carries the reason `portal_not_found`, so a
  consumer can tell the router's answer from an outage.
- Router code `617` (signature refused), an HTML page, and HTTP 401 or 403 are challenges.
  Code `490` (the app version is turned away) and HTTP 404 or 410 are transport failures.
  Any other code, such as `500`, is inconclusive.
- Scan codes map through `status.ts`, which declares its `statusMap`; unknown codes are left
  to the shared classifier.
- The customer sentence is kept only in the forms the router is known to write. The courier
  or recipient name at the end of a pick-up, out-for-delivery or delivered sentence is
  dropped. An arrival, departure or pick-up sentence is kept only when it names the scan's
  own town and a facility type, which is how the router writes it; any other wording gives
  way to the scan's English label. A hold reason is repeated only when it is one read live,
  since the router picks them from a fixed list; any other is dropped from its sentence.
- A scan's location is its town and province. A departure's town fields name the next stop,
  so departures keep only their sentence. Scans from the router's own system network
  (`SISTEM` codes, `_AUTO` names) carry its registered town, not the parcel's, so they keep
  no place.
- The name, phone, remark, coordinate and picture fields are never read.
- Times: `scanTime` is a wall clock without a zone, and Indonesia has three. The scans read
  live were all made at facilities on Western Indonesian Time, which does not show whether
  facilities elsewhere keep their own clock. The clock stays in `local_time`; no offset or
  `timezone` is set. Scans keep the router's newest-first order.

## Limitations

- J&T drops older histories: an old Indonesian waybill answers like an unknown one.
- A history longer than 100 scans keeps the newest 100.
- Recognition asks the router only about the prefixes J&T Indonesia issues, since an empty
  answer settles nothing else. Other `J` prefixes and twelve-digit numbers are answered as
  unknown without a request, so preflight leaves them to the other carriers and the
  universal providers.
- The Philippine router answers code `500` and the Malaysian one `490`; Thailand and
  Vietnam need an account, and the websites ask for CAPTCHA or phone digits.
- Singapore's tracker, `vipgw.jtexpress.sg/jtsvip/api/trackingList.do`, asks for a Tencent
  CAPTCHA while its `captchaSwitch` is on. Its support chat looks a waybill up without one,
  but posts every lookup into the chat log, so it is not used either.
- The website's portal link stays on the Philippine tracking page.

J&T Indonesia's help centre says its waybills usually start with two letters, such as `JO`
or `JP`; the prefixes with enough public reports select J&T, and the others only suggest it.

## Testing

`npm run test:carriers:live -- carriers/j-and-t` sends a well-formed unknown Indonesian
waybill. Set `J_AND_T_TRACKING_NUMBER` to a real one to read its history.
