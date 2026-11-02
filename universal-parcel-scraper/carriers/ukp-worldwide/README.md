# UKP Worldwide

Tracks parcels of UKP Worldwide (UK Postings Limited, formerly Mail Right International), a customs
agent and consolidator near Aylesbury, sending e-commerce mail and parcels from the United
Kingdom to the United States and other countries, where a postal partner delivers them. Its site
is ukpworldwide.com.

## How it works

1. `direct`: one GET to the tracking page `www.ukpworldwide.com/tracking/?x=<number>`, which the
   server renders with the parcel's scans or with "Nothing found", both with HTTP 200.
2. `retry`: the same read once more after a request fails to reach the page or hangs.

No account, key, cookie, CAPTCHA or browser is needed.

## Notes

- The page does not repeat the number. The tracker looks up only the whole number, in any case,
  so the answer belongs to the request.
- Scans come oldest first with a wall clock to the minute and no zone, from UKP's depot, US
  customs and the delivering post, so they stay `local_time`. USPS's rows without a clock, such
  as "in transit to next facility", come at 0:00 and keep their day alone.
- USPS's places give the town twice around its postcode; each part is kept once and postcodes
  are dropped.
- A row's code is kept. One code groups several wordings, such as US customs' notices, so the
  status map reads the wording. Rows relayed from USPS fall to the shared rules.

## Limitations

The page has no summary status, service or delivery number: the parcel's stage is its newest
staged scan.

## Numbers

An archived lookup on its own tracker shows WHISU and nine digits, which looks like one client's
series. It is one sample, so the rule is low, covers that prefix only, and recognition asks the
tracker. The adapter asks about any number of letters and digits.

## Links

The tracking page opens the number from its `x` parameter.

## Testing

`npm run test:carriers:live -- carriers/ukp-worldwide`, with `UKP_WORLDWIDE_TRACKING_NUMBER` and
optionally `UKP_WORLDWIDE_UNKNOWN_NUMBER` set outside the repository.
