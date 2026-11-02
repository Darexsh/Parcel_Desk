# UPU Global Track & Trace

Last-resort postal fallback. UPU is the data source, not an operator. It is eligible
only for checksum-valid S10 numbers, which proves neither coverage nor the carrier. It
always runs last, and a success never gives it affinity or a place in shadow comparisons
([docs/ROUTING.md](https://github.com/plhery/delivery-tracker/blob/main/docs/ROUTING.md)). Persisted provider name: `UPU`.

## How it works

One step, `direct`: an anonymous GET with an 8 s total budget, a 2 MB body cap and at
most 1,000 input events. No browser, cookie, retry or CAPTCHA.

```text
https://globaltracktrace.ptc.post/gtt.api/service.svc/rest/ItemTTWithTrans/{itemID}/EN
```

- The [GTT API documentation](https://upu.api.post/gtt/), linked from the
  [UPU API directory](https://www.upu.int/en/postal-solutions/technical-solutions/products/upu-api-documentation),
  lists this as an anonymous method. Responses set cookies, which are not kept.
- `ItemTTWithTrans` returns English labels. `ItemTT` returns null event and country names.
- `FR` and `ES` return translated labels, while other languages fall back to English.
  The adapter uses `EN`.
- Untested: anonymous `POST /ListTT` and the token-based `*Ext` methods.

Reproduce with a reference kept outside the repository:

```sh
curl --fail-with-body --max-time 15 \
  "https://globaltracktrace.ptc.post/gtt.api/service.svc/rest/ItemTTWithTrans/${UPU_LIVE_NUMBER:?Set a reference number locally}/EN"
```

## Parsing

- The returned `ID` must equal the requested item. An array alone proves nothing.
- An item can come as several records, one per origin and destination pair it was
  reported under: export customs scans can sit in a second record whose destination is the
  origin country. Every record must name the item; their scans are merged, at most 10
  records and 1,000 scans in all.
- An unknown or expired item returns HTTP 200 with an empty body. The adapter raises
  `NotFoundError`, as it does for an empty array or a reply with only forecasts.
- `Events` includes forecasts. `EventCd: "DLV"` means "Estimated delivery", and it is
  dropped along with any row named as an estimated, expected or predicted delivery.
  They never feed history, status, ETA or freshness. An actual delivery looks like
  `EMI` "Final delivery".
- The wire format differs from the documented examples: dates are WCF
  `/Date(ms+offset)/` strings and `State` is numeric. Stages come from known event codes.
  `State` never proves delivery.
- The WCF offset is not the event's zone: for one Finnish delivery it was an hour off
  Posti's own timestamp. ISO-shaped replies are treated the same way. The wall time is
  the office's clock: a Sydney office's was Australia Post's own instant on Sydney time.
  Each scan keeps it as `local_time`. A scan whose location is the UPU code of an office
  in the record's origin or destination country (`GBLALA`) also gets its instant in
  `time` when that country keeps one civil time. Countries with several zones, and Spain
  and Portugal, whose islands keep other clocks, get none. The newest scan's instant is
  `last_update`.
- Origin, destination country and mail class are present but not projected. No
  documented schema has an onward tracking number or destination operator.
- Signature and recipient details are not projected.

Because most UPU scans have no instant, the host archives its scans (up to 1,000 per lookup
number). It adds newly seen milestones to the timeline at observation time, and never
lets UPU advance the UTC watermark or replace richer saved progress. The rules are in
[docs/ROUTING.md](https://github.com/plhery/delivery-tracker/blob/main/docs/ROUTING.md).

## Limitations

- Histories are sparse and can lag. Often only final delivery is present, and other
  feeds can have a newer milestone. For an EMS item, the
  [EMS Cooperative route](../../carriers/ems/README.md) had a scan UPU lacked.
- Retention, rate limits and production-network behaviour are unknown.
- Terms: the [PTC schedule of charges](https://www.upu.int/UPU/media/PTC/Documents/PUBLIC/SOC/PTC_Schedule_of_charges_EN.pdf)
  lists GTT as free for designated postal operators. No public quota, SLA or third-party
  usage grant was found. See also the
  [API copyright notice](https://www.upu.int/UPU/media/PTC/Documents/PUBLIC/API/CopyrightNotice-API.pdf).

## Rejected approaches

- The website form (`gtt.web/Search.aspx`): a four-character text CAPTCHA, sent as an
  inline JPEG with the ASP.NET fields `txtCaptchaCode` and `txtCaptchaEncCode`. The API
  makes solving it unnecessary.
- Prior art: `apoldev/trackchecker` calls the same `ItemTTWithTrans` route but assumes
  ISO dates. `AlienZaki/PostAPI` solves the form through the paid AZCaptcha service.
  `shikarkhane/postal-scanner` automates the form with no CAPTCHA solution. No code was
  copied.
- Handing off to the destination operator from the destination country: the country is
  no proof of a handoff and comes with no onward number.

## Testing

No live test. Unit tests cover identity, forecasts, date handling, HTTP failures,
cancellation, size limits, ordering and history preservation. Use the `curl` command
above for a manual check.
