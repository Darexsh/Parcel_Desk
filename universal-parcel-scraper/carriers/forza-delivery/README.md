# Forza Delivery Express

Forza Delivery Express is a courier in Guatemala, Honduras and El Salvador that delivers online
shops' orders, often collecting cash on delivery, through its own facilities and couriers.
Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://rastreo.forzadelivery.com/fd2/Home.aspx/API`, the page method the
   tracking page posts its lookups to, with the body
   `{"path":"Tracking/GetNewDeliveryTracking","data":"…"}`. `data` is a string of JSON with the
   method's name and its parameters: the `FD` series as `GuideSerie`, the digits as
   `GuideNumber`, and an empty reference and phone. It needs no cookie, token, key or browser.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.
3. `browser`: after a challenge, an optional private Playwright browser at
   `FORZA_DELIVERY_BROWSER_WS_ENDPOINT` opens the official page and posts the same guest
   request from that browser's network. Its bounded reply goes through the same identity and
   history parser. Configure a browser on a network Forza accepts; another browser on the
   refused network does not establish access. The original challenge remains in telemetry.

- The reply nests three strings of JSON: ASP.NET's `d`, the relay's `Data`, and its `PayLoad`,
  the method's answer. The answer's `ObjectValue.IdResult` is 202 with the order and its
  milestones, newest first, or 404 for a guía the tracker does not know, which the page reports
  as missing and is the only missing guía.
- A relay that fails to reach the tracking service answers HTTP 200 without `Data` and names
  the status it got, such as `Conflict`. That is inconclusive, and `TooManyRequests` is a rate
  limit. Results the page shows its message for, such as 400 for a reference that names several
  guías, are inconclusive. ASP.NET's own failure is HTTP 500. A redirect, a 404 or a block page
  is no answer.
- The order must be the guía asked. The tracker reads the digits as a number, so leading zeros
  name the same guía.
- HTTP recognition makes only the direct request and network retry, even when browser recovery
  is configured. An order without milestones is a known guía.

## Notes

- The page asks for a reCAPTCHA checkbox before it enables its search button, but the lookup
  does not send its token and the tracker does not check one.
- Each milestone's `date` ends in `Z`, but the page shows its digits as they are, through the
  UTC clock, and the tracker's summary method gives the same digits without a zone. They are
  wall clocks to the second. The countries share UTC−06:00, but a milestone names no office or
  country, so the clocks stay `local_time`.
- A milestone's `stageId` stages it through [status.ts](status.ts); an id the map does not know
  goes to the shared wording rules. Its description is the page's title, then its description
  when that says more. Incidents (`stageId` 45) put their classification first, as the page does,
  and are staged by that wording.
- Descriptions lose a clause naming who took the parcel and phone numbers. The customer's,
  sender's and recipient's names, the recipient's phone, the prices, the courier's user, the map
  points and the proof of delivery in the order are not kept.
- The page also calls `GetTrackingPublic` for a summary with the destination town and an
  estimate. It answers older guías with a relay failure, and the adapter does not ask it.

## Limitations

- Older guías keep their order without milestones, which is no history.
- No delivery estimate, location, weight, service name or delivery instant.
- Forza's load balancer refuses requests from some networks, such as a data centre in Germany,
  with a bare 403 page, which is a challenge. Browser recovery is opt-in; enabled universal
  providers remain available when it is absent or fails, and can complete the local-clock history.
- Only `FD` guías. The tracker reads bare digits as a reference, which can name several guías,
  so the adapter does not send them.

## Numbers

Forza guías are `FD` and digits; the tracking page's own check takes six to nine digits, and
customers quote six to eight, often with a space or a dash after `FD`. `forza-delivery-1` claims
`FD` and six to eight digits with low confidence, because GLS, Loggi and TNT Italy numbers
overlap the shape. Recognition asks the tracker. [`numbers.json`](numbers.json) has a synthetic
guía of each length the rule takes.

## Links

The tracker opens one guía at `rastreo.forzadelivery.com/` followed by the guía, an address
Forza's own site builds. The tracker drops `FD` from the address and adds it back, so the
address works with or without the prefix. It shows the guía only after the reCAPTCHA.

## Testing

`npm run test:carriers:live -- carriers/forza-delivery`, with `FORZA_DELIVERY_TRACKING_NUMBER`
and optionally `FORZA_DELIVERY_UNKNOWN_NUMBER` set outside the repository. Set
`FORZA_DELIVERY_BROWSER_WS_ENDPOINT` outside the repository to exercise private browser recovery.
