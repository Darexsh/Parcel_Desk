# MHI

MHI (Mail Handling International) is a British cross-border carrier for online shops. It takes
their parcels and letters to its export facility in the United Kingdom and hands them to a
courier or post in the destination country, which delivers them under its own number. Tracked
through its tracking page.

## How it works

1. `direct`: one `GET https://www.trackmail.co.uk/?Tracking={number}&command=Track`, as the
   page's search form submits it. It needs no cookie, token, key or browser.
2. `retry`: the request once more when it fails to reach the site or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- The page echoes the number in its search field and lists one row per event, newest first. A
  page for another number leaves the answer open.
- A number the tracker does not know gets a single row saying so, dated with the time of the
  search, read as not found. The page answers every number with HTTP 200, so a redirect or a 404
  is a moved route, and a firewall page or a 403 is a challenge.
- Recognition makes the same request.

## Notes

- Each row has a day, a minute, a text, a category and a place. The text decides the stage, then
  the shared wording rules; the category decides only where it cannot hide another stage, since
  the page files a delivery attempt under Delivery and a pick-up point under Out for delivery.
- Event clocks are wall clocks to the minute with no zone, so they stay `local_time`. MHI's own
  scan is on British time and the courier's scans on the courier's.
- The courier the tracking link's address names becomes the delivery carrier, with the number
  beside the link. The link carries the recipient's postcode, so it is not kept.
- An untracked item can show the number the destination's post gives it, kept as the delivery
  tracking number when it passes its check. The suffix of that number names the post's country,
  kept as the destination country, so the hand-off asks that post even when the reader is there.
- The page names the service, tracked or untracked.

## Limitations

- No instants, scan codes, expected delivery or proof of delivery.
- An untracked item often shows MHI's export scan alone.
- A courier the catalog does not know at the link's address names no delivery carrier.

## Numbers

An MHI number is MHI, three digits naming the shipper's account, and a series number: W and
twelve digits, WBB and nine digits, P and nine digits, or twelve digits. Labels of the P series
print dashes after MHI and after the three digits, and the tracker finds those only with them,
so the adapter and links ask for the printed form. Older labels with two-digit accounts or eight
digits are not asked.

## Links

A link to the tracking page with the number in its `Tracking` parameter opens one item. The page
also finds some couriers' numbers, so the link names MHI only for a number its own rule offers.

## Testing

`npm run test:carriers:live -- carriers/mhi`, with `MHI_TRACKING_NUMBER` and optionally
`MHI_UNKNOWN_NUMBER` set outside the repository.
