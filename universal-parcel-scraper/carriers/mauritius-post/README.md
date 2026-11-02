# Mauritius Post

Tracks Mauritius Post items, registered, parcel and EMS, its own and those other posts send to
Mauritius, through its tracking page's own lookup.

## How it works

1. `direct`: one `GET https://www.mauritiuspost.mu/track-trace/?tracking_code={number}`, as the
   page's form sends it. The site looks the number up on the server and renders the item's header
   and scans into the page. No cookie, token, key or browser is needed: the form sends no CAPTCHA
   token and the server asks for none.
2. `retry`: the same request once more after a network failure or a hang. The first gets half of
   the budget.

- The form's field must echo the whole requested number, and the results header must name it.
- The notice "No tracking information available for this item" is the only missing item. A
  firewall or bot check's page, even with HTTP 200, is a challenge; Wordfence's rate limit is a
  rate limit. A 404, a 410 or a redirect is a moved route, and a page without the results section
  or with another notice a schema error.
- The page takes several seconds to look an item up, so the adapter's default budget is 30
  seconds.
- Recognition is not declared: the lookup tells a known item from an unknown one, but no
  detection rule offers Mauritius Post for a number, so recognition would never ask it, and the
  lookup is slower than recognition's budget.

## Notes

- Scans are listed oldest first, the newest marked as the current status, each with a day, a
  time to the minute, an office and a wording. The page gives no offset and the history of an item
  from abroad can mix foreign and Mauritian scans, so every scan keeps its wall clock.
- The wording carries no code. The map names each wording seen; another falls to the shared
  wording rules. The tracker has reworded scans, so earlier wordings stay in the map.
- The first scan, received from the customer, can name the `Virtual Office`; the posting office,
  the header's origin, then prints the receipt label. Both are the item's acceptance. A delivery
  notification asks the addressee to collect the item at the office, and "Delivered Through
  Counter" is its collection there.
- The header's estimated delivery was empty while a public item moved and gave the delivery day
  once it was delivered, so it is not read. Its origin and destination offices and days in transit
  are not read either. The page shows no names, addresses or proof of delivery.

## Limitations

- No ETA, weight, service, event code or clock with an offset.
- The form also asks for order numbers, whose format no public source shows. The adapter takes
  only S10 codes with a valid check digit.
- Items sent to Mauritius from abroad have not been seen on the tracker.

## Numbers

Mauritius Post tracks registered, parcel and EMS items by their UPU S10 numbers, which end in
`MU`, and items from abroad by the sending post's number. Generic postal detection handles these
numbers, so no Mauritius Post rule claims them. An item reaches Mauritius Post when a caller names
it, a provider names it or its tracking link is opened. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracking page reads a number from `tracking_code` on `www.mauritiuspost.mu/track-trace/`,
so one item opens at `www.mauritiuspost.mu/track-trace/?tracking_code={number}`.

## Testing

`npm run test:carriers:live -- carriers/mauritius-post`, with `MAURITIUS_POST_TRACKING_NUMBER`
set outside the repository. Optionally set `MAURITIUS_POST_UNKNOWN_NUMBER` to a code the tracker
holds nothing for.
