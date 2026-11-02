# Hitch

Hitch, formerly Zip PH, is the brand of Z International Parcel Services, a Philippine business-to-business
courier delivering for online shops and other businesses across Luzon, the Visayas and Mindanao, with
warehousing and fulfilment. Its site is hitch.com.ph; zip-ph.com now only points there.

## How it works

1. `direct`: one `GET https://hitch.com.ph/tracking?no={number}`, the page its tracking form opens. It
   needs no cookie, token, CAPTCHA or browser.
2. `retry`: the request once more when it fails to reach the tracker or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- A number the tracker holds no booking under gets HTTP 200 and `Oooops! we couldn't find any
  bookings/results matching` with the number quoted, read as not found. A redirect or a 404 is a
  moved route, a Cloudflare check is a challenge and a 429 is a rate limit.
- The tracker finds a booking by its tracking number or by its reference, and the booking's
  tracking number or reference must be the whole number asked. Asked by its reference, the result
  names the tracking number as its canonical number.
- Recognition makes the same request.

After an identified browser challenge, `trawl` opens the same tracking address in the
configured browser service. The carrier parser checks the whole shipment identity.
Definite answers, rate limits and malformed replies do not launch a browser.
Recognition stays HTTP-only.

## Notes

- The timeline lists each step oldest first, with its name, a day such as `April 12, 2022` and a
  minute such as `4:48:PM`, without a zone. Hitch delivers only in the Philippines, and archived
  lookups hold steps that, read as UTC, would come after the capture. The clocks stay `local_time`,
  and consumers read them on the catalog's Manila clock.
- The current status gives the result's stage when the map or the shared wording rules stage it;
  otherwise the newest staged step does. A step the map does not list falls to the shared wording
  rules.
- `In transit` is mapped as out for delivery: it comes at the same minute as `Assigned for
  delivery`, with the delivery later that day, while the haul between branches has its own step.
- Some steps carry a remark, `New Package Added` under the first. It is free text and is not kept,
  nor is the booking date, which repeats the first step's clock.
- The site loads reCAPTCHA for its sign-up forms on every page, so only Cloudflare's own pages count
  as a challenge.

## Limitations

- No places, instants, expected delivery, weight or proof of delivery.
- Some of the archived examples now read as not found, so the tracker does not keep every older
  booking.

## Numbers

Its tracking numbers are `ZIP` and twelve letters and digits, which `hitch-1` suggests at low confidence: every
example is an archived lookup on Zip PH's tracker, and none is known from after the rename. Its tracker also
finds a booking by its reference number, `B` and seven digits, a shape other carriers' rules share, so no rule
takes it. The adapter sends only these two shapes.

## Links

The tracking page opens numbers from its `no` parameter. Links to zip-ph.com, its former site, now reach only
a notice pointing to hitch.com.ph, so no rule reads them.

## Testing

`npm run test:carriers:live -- carriers/hitch`, with `HITCH_TRACKING_NUMBER` and optionally
`HITCH_UNKNOWN_NUMBER` set outside the repository.
