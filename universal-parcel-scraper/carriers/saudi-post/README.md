# Saudi Post

Saudi Post (SPL) is Saudi Arabia's national postal operator. It delivers domestic parcels,
many of them online orders, and mail from abroad, and sends letters, parcels and EMS items
out of the country. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one
   `GET https://splonline.com.sa/umbraco/api/tools/trackshipment?language=en&shipmentCode={number}`,
   as the tracking page's script sends it for the number in its address. It needs no cookie,
   token, key or browser. The JSON reply is a list with the shipment and its scans, oldest
   first, in English.
2. `retry`: one more try when the request fails to reach the site or hangs. The first try gets
   half of the budget.

- An unknown number, and one whose history SPL no longer keeps, is HTTP 200 with one shipment
  whose fields are all null, which the page reports as "No data matches entered tracking
  number". A 404 or a redirect is a moved route.
- The site's firewall answers a request it refuses with its own "Request Rejected" page and
  HTTP 200, which the adapter reports as a challenge.
- The shipment must echo the number asked.
- Recognition makes the same request.

## Notes

- Each scan's `EventDateTime` is a wall clock to the second, with no zone. A parcel from abroad
  starts with its origin post's dispatch, and an EMS item sent abroad ends with the scans of the
  partner that flies it, both in their own place's clock, so the clocks stay `local_time`.
- A scan's `Status` is the step of the page's progress bar and its `provider_code`. The steps
  follow the order of the step labels in the page's script, which every reply agrees with. Steps
  2 and 4 also carry missed deliveries, a parcel ready for pickup or held, and a partner's
  arrival abroad, so their wording stages those scans. Each courier call before a delivery is
  logged as a delivery attempt.
- The location is the office the page shows under a scan. On SPL's "Your shipment is on its way
  to" that office is the next one, so it completes the line and is not the parcel's place. An
  office the reply names only by a code, as `<country> - <code>`, is no place: its country can be
  wrong. The office of the sender's announcement is the sender, and is dropped.
- The reply's origin and destination are not kept. The destination is often the delivery town,
  and an EMS item delivered abroad showed Saudi Arabia. The customer messages and links under a
  scan and the office coordinates are not kept either.
- The delivery estimate is a calendar day, dropped once the parcel is delivered or returned.
- The page accepts several numbers joined with `~` and sends them in one lookup. The adapter
  asks for one.

## Limitations

- No weight, sender or recipient, and no delivery time as an instant.
- Digit-only numbers are refused. The tracker also takes Naqel's waybills, which are digit runs
  and belong to Naqel, and no SPL number seen is digits only.

## Numbers

International items carry UPU S10 numbers, and items SPL sends abroad end in `SA`; generic postal
detection keeps them, and a code ending `SA` only suggests Saudi Post, which recognition asks
first. The tracker also answers items from abroad under their origin post's
numbers, so mail a provider reports as bound for Saudi Arabia is looked up here by its S10 number.
Archived lookups on SPL's tracker also show `CRDSAL` and ten digits, which `saudi-post-1` claims;
no other carrier uses the prefix. Other six-letter prefixes appear with the same ten digits, one
sample each, and stay unclaimed. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracker opens `splonline.com.sa/en/shipmentdetailsstatic/?tid={number}`; several numbers
are joined with `~`. The Arabic page under `/ar/` takes the same parameter.

## Testing

`npm run test:carriers:live -- carriers/saudi-post`, with `SAUDI_POST_TRACKING_NUMBER` and
optionally `SAUDI_POST_UNKNOWN_NUMBER` set outside the repository.
