# Australia Post

Australia Post articles and consignments (10–34 alphanumeric characters), tracked through the
anonymous shipments API behind the official [tracking app](https://auspost.com.au/mypost/track/).
Plain HTTP answers when the request looks like the official Android app's; the TRAWL browser
service takes over when it is refused. Recognition asks the same API over plain HTTP only, so a
refusal there leaves the number unchecked instead of starting the browser.

## How it works

1. `direct`: one `GET https://digitalapi.auspost.com.au/shipments-gateway/v1/watchlist/shipments?trackingIds={number}`
   with the Android app's `AP_APP_ID`, `AP_CHANNEL_NAME` and HTTP client name, 10 s timeout. No key,
   cookie or token is sent. 401/403 is a challenge and hands over to `trawl`; 429 is rate limited.
2. `trawl`: TRAWL opens `/mypost/track/details/{number}` (tiers 2–3, no plain HTTP) and captures
   exactly the same GET.
   - The Australia Post helper ([`australia-post-browser.mjs`](../../trawl/australia-post-browser.mjs),
     see [`trawl/README.md`](../../trawl/README.md)) reads the current public API key
     from the page's app module and makes that GET inside the browser session with
     `AP_CHANNEL_NAME: WEB_DETAIL`. The key is never pinned here, and browser state is never replayed
     over plain HTTP.
   - Each lookup gets a fresh browser context that is closed afterwards.

Budget: 45 s by default (max 60 s). `trawl` keeps a 15 s transport allowance and fails when less
remains. Either reply is capped at 1 MB. On the capture, 401/403 is a challenge and 429 is rate
limited; a missing capture or changed schema is an error for normal provider fallback.

## Mobile app

The [official Android app](https://play.google.com/store/apps/details?id=au.com.auspost.android)
has package id `au.com.auspost.android`; Australia Post publishes its signing fingerprint in
[assetlinks.json](https://auspost.com.au/.well-known/assetlinks.json). Its guest tracking reads the
same gateway route as the website through OkHttp, with `AP_APP_ID: MYPOST` and
`AP_CHANNEL_NAME: ANDROID`.

The gateway's DataDome protection decides on the HTTP client name: the app's OkHttp name gets JSON,
and any other name gets a captcha reply with HTTP 403, whatever the channel. Two defaults of
`fetch` get the same refusal, so the adapter replaces them: `Accept-Language: *`, and the cache
headers of the `no-store` and `no-cache` modes (`Pragma`, and `Cache-Control: no-cache` or
`max-age=0`), which the app never sends. So does a `baggage` header, which Sentry's Node SDK adds to
every outgoing request unless the consumer sets `tracePropagationTargets: []`. The app also sends an
`API-KEY` and carries the DataDome SDK; the gateway answers without the key or a DataDome cookie.

## Notes

- Detection selects Australia Post for an article ID: an optional two-digit prefix, a
  three-character merchant location ID, nine digits, `000` and six digits. Without the prefix,
  `MA` and nineteen digits is Matkahuolto's own layout, which recognition asks Matkahuolto
  about instead, and `JJD` and eighteen digits a DHL licence plate whose serial is zero-padded. It also selects it for
  the EMS, parcel and tracked-letter S10 items it issues: C, E or L first, AU last and a passing
  check digit, since its tracker reads them abroad too. It only suggests Australia Post for:
  - A consignment number: an optional two-digit prefix, a location ID with a letter, seven
    digits. With the prefix, Australia Post comes before Colis Privé's rule for any twelve
    characters. Without it, a location ID of two letters and a digit is left out, since other
    carriers' ten-character numbers start that way.
  - A StarTrack consignment number: three characters with a letter, then `Z` and eight digits.
    Australia Post comes before Colis Privé's rule for any twelve characters.
  - A 22-digit barcode of a prepaid satchel, envelope or label: `00` to `03`, then digits ending
    in a GS1 check digit. Other carriers' rules take any 22 digits; the passing check digit moves
    Australia Post ahead of them in recognition. TIPSA stays first for a barcode in its layout, and
    CTT Express's prefix selects CTT Express outright.
  - `R` and twenty-four digits, an ID Australia Post's tracker lists as a domestic Parcel Post
    article. Nothing published describes it and it carries no known check digit, so recognition
    asks Australia Post to confirm it.
  - Any other Australian-issued postal number, which Australia Post is asked about first. No
    public registered or letter-post item has shown that its tracker reads them.
- All-digit consignments have no rule: other carriers' rules take those lengths, and no check
  digit sets Australia Post's apart. Neither do 18-digit barcodes starting `9979`: Swiss Post's
  rule takes them, and none with scans has shown they are Australia Post's.
- The context uses `AUSTRALIA_POST_BROWSER_LOCALE` (default `de-DE`) because the pool's `en-US` and
  `en-AU` locales got HTTP 403 from the deployment network. Another network may need its own value.
  It does not affect status language or event time zones.
- The login iframe can return 403 while tracking still works; waiting for account bootstrap would
  discard usable data.
- Identity: exactly one entry must list the number in `trackingIds`, the article must match through
  `shipment.articles[].articleId`, and its single detail object must repeat the article and
  consignment IDs.
- A consignment number of one article tracks that article. One of several articles tracks as one
  parcel while they are in one state: all delivered, or every newest scan coded, worded and placed
  alike. The article that reached it last answers, with its own history. Articles in different
  states leave it inconclusive (`several_parcels`), since one delivered sibling doesn't mean the
  consignment is delivered. An exact article number selects its own history; sibling and
  shipment-wide states never classify it.
- Not-found is only the HTTP 200 entry with `status: 400`, `errorCode: 21`, `Invalid Tracking ID`,
  `Failed`. An entry with `status: 500` is the gateway failing on a reference it cannot process: it
  is inconclusive, and the browser is not asked the same question. So is a known article without
  scans (`Updating Status`), whose history is gone or never began, as for a label not yet scanned.
  It is a `NoHistoryError`, so a consumer can tell it from an outage. Empty arrays, other
  identities and other errors are schema failures.
- Each scan is classified by its own `eventCode`, then its milestone label; `statuses.json` records
  the codes. A milestone groups several scans, so codes win: an item awaiting collection abroad is
  filed under `Delivered`, a failed attempt abroad under `It's on its way`. Awaiting collection,
  attempted delivery and returns are not delivery. An article summary the map does not know takes
  the newest scan's stage. A summary label groups several scans too: when the newest scan's code
  places the parcel further along the way (customs on the way in under `In transit`), the code's
  stage stands. So does it when the summary stages the parcel as that scan's own milestone does:
  `In transit` over an acceptance abroad filed under `It's on its way` says no more than the
  acceptance, so the parcel is accepted, and a consumer does not record a transit step no scan
  dates.
- A scan keeps both as its `provider_code`: the event code, a slash and the milestone label
  (`TTP-ER81/It's on its way`), or the code alone without a label. The parcel app's review asks
  the same map (`statusMap`) by that code, so it stages a scan as the adapter does. A scan stored
  with its event code alone is staged by a listed code, or as a delivery by the wording
  `Delivered`. Adding the label changes no stored scan's identity, which the app keys on its
  time, place and wording.
- Event time comes from `localeDateTime` (explicit offset), else the epoch-ms `dateTime`. If both
  exist and disagree, the parse fails. Events are sorted by instant.
- Scans relayed from the post abroad carry that office's wall clock labelled as UTC. When the reply
  crosses one border, they are read in the zone of the country the location names, its US state or
  Canadian province, else the foreign country's single zone; otherwise the wall clock stays in
  `local_time` and sorts on the zone the reply's other scans abroad keep. The scan identity policy
  in `app.ts` (`relabelledFrom: 'UTC'`) lets such a scan take over the row stored under the label.
- A parcel awaiting collection at a post office or locker gets that place, as its awaiting-collection
  scan (`DD-ER4`, `NT-ER4`) names it, in `pickup_point`. It keeps it once collected: when only
  deliveries follow that scan and none was left in a safe place. A delivery after another round, or
  after a notice the map does not know, gets none.
- The reply gives no address for the point, so `pickup_point` is its name alone. The anonymous address
  block is empty but for the country, which gives `destination_country`, and
  `collectionInstruction.facility` carries only the point's work-centre id and type. Lead: the tracking
  page's "View location and collection hours" opens `auspost.com.au/locate/showpop/{workCentreId}`,
  which resolves the id through `digitalapi.auspost.com.au/locations-private/v3/workcentres`; that API
  refuses a request without its `AUTH-KEY`, so the address is not looked up.
- `statusModificationDateTime` and summary milestone timestamps are not scan times (they can be hours
  off the delivery scan). `last_update` and `delivered_at` come from events.
- Delivered wording is replaced with `Delivered` so signature or safe-place text can't leak a name.
- `service_name` is the article's product (`productSubType`, such as a satchel size); its family
  (`articleType`) is not read.

## Limitations

- No ETA.
- Recipient and sender blocks, addresses other than the destination country, barcodes, access
  instructions, proof links, collection credentials and facility IDs are never kept. At most 100 of 500 events are kept.

## Testing

`npm run test:carriers:live -- carriers/australia-post`. The direct not-found runs with no
configuration; add `AUSTRALIA_POST_TRACKING_NUMBER` for the positive case and `FLARESOLVERR_URL`
for the browser tier.
