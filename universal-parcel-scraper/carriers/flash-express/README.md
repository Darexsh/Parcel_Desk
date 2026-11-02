# Flash Express

Flash Express is a domestic parcel network in Thailand, with its own branches, hubs and Flash
Home agents that take in parcels. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://www.flashexpress.co.th/webApi/tools/tracking` with the body
   `{"search":"{number}"}` and `Accept-Language: en`, as the tracking page sends it. It needs no
   cookie, token, key or browser. Without the language header the wording is Thai. The JSON
   reply lists the numbers it does not know under `error_search` and the others under `list`,
   each with its summary and its scans, newest first.
2. `retry`: one more try when the request fails to reach the site or hangs. The first try gets
   half of the budget.

- The service answers HTTP 200 for every number. A number under `error_search` is not found. A
  404 or a redirect is a moved route.
- A `code` other than 1 is inconclusive, or a rate limit when the message says the client asks
  too often; the page ignores such replies too.
- The entry must echo the number asked in `search_no`. For some parcels the page shows another
  Flash number with the one asked in brackets; the entry still answers the number asked.
- Recognition makes the same request.

## Notes

- Each scan's `routed_at` is a wall clock with no zone. It is Bangkok time: the delivery
  photos' file names carry Unix timestamps a few seconds before the delivery scan's clock read
  at +07:00. Thailand keeps that offset all year, so the adapter returns the time at +07:00.
- The scan's `route_action` stages it. Flash's open platform documentation lists the codes with
  their English wording; the tracker also uses a few it leaves out. Calls to the recipient,
  reminders and changes to the parcel's details move nothing and have no stage.
- The summary's `state` decides a delivery, a return, a problem parcel or a closure. A closed
  parcel can be reopened and delivered, and calls and reminders can follow a delivery.
- The wording ends with the scan's district and province, each in 【】, which become the
  location. Sites are Flash's own codes and names inside the wording.
- The delivery wording names who signed, which the adapter removes, along with phone numbers
  and the old and new values of changed details. The reply's courier names and phones, the
  branch phones, the call list, the signer and the delivery photos are not kept.
- Some histories use newer wording, whose scans carry no state of their own. The codes are the
  same.

## Limitations

- No delivery estimate, weight, sender or service.
- A multi-piece parcel's other pieces are not followed.

## Numbers

Thai tracking numbers start with `TH`, then four digits and seven or eight letters and digits,
ending with a letter. A low-confidence rule suggests Flash Express for that layout, since other
Thai networks also print `TH` numbers; recognition asks the tracker. A rarer form with a
trailing digit after the final letter, which Flash uses for return waybills, stays unclaimed,
but the adapter tracks it when the parcel is filed under Flash Express. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

The tracker reads one or more numbers from the `se` parameter of `/fle/tracking` on
`flashexpress.co.th`, with or without a language prefix. The former tracker used `/tracking/`
with the same parameter.

## Testing

`npm run test:carriers:live -- carriers/flash-express`, with `FLASH_EXPRESS_TRACKING_NUMBER` and
optionally `FLASH_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
