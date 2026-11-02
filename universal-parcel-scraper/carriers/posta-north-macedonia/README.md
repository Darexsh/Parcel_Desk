# Pošta na Severna Makedonija

Tracks Pošta na Severna Makedonija items, its own and the S10 items other posts send to North
Macedonia, through the lookup its tracking page on posta.com.mk makes.

## How it works

1. `direct`: one `GET https://www.posta.com.mk/api/api.php/shipment?code={number}`, as the page
   makes it for the code in its field or its `tn` parameter. It needs no account, cookie, token,
   key or browser.
2. `retry`: a lookup that fails to reach the service, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- The reply is a JSON array of the item's rows in no set order. Every row names its item, which
  must be the whole requested code. The service matches the code exactly and in capitals, so it
  gets the normalized code.
- An empty array is the page's "no data found", which is not found. The service gives it for a
  code it does not know and for one whose records expired.
- An empty reply, which the site gives for a route it does not serve, or any other changed reply
  is a schema error. A 403 or a firewall page, even with HTTP 200, is a challenge, a 429 a rate
  limit and a 503 maintenance. A 404, a 410 or a redirect is a moved route. Recognition makes the
  same request.

## Notes

- The history mixes two systems. Rows from the post's own offices name the office beside its
  postcode; the adapter keeps the office and drops the postcode. Rows from the UPU's exchange of
  events, the sending post's scans and the offices of exchange, give only an office code led by
  its country, so their location is that country.
- Each row has a day and a clock to the minute, without a zone. Foreign rows may carry the
  sending post's clock, and no offset could be verified for the post's own, so every scan keeps
  its wall clock as `local_time`. Recognition therefore gives no last-activity instant.
- The service writes its notes in Latin letters with some replaced by symbols, `~` for č and `}`
  for ќ; the adapter keeps them as written. The page shows a delivered item's note in Cyrillic.
- An arrival at an inward office of exchange gives the destination country.
- For some items the service gives a delivery record instead of scans, which reads as known
  without history. The record's recipient name and address, and the postman's name on newer
  delivery rows, are never read. Next offices and dispatch numbers are dropped too.

## Limitations

- The service gives no ETA, weight, service or proof of delivery.
- Older items lose their domestic rows first, then drop out and read as not found.
- The adapter takes only S10 codes with a valid check digit. The page also looks up the post's
  eleven-digit internet order numbers, which the adapter does not take.
- After a burst of lookups the site may stop accepting connections from that address for a
  while, which reads as a network failure. Some networks, including the daily link check's,
  often get no connection at all, and the lookup itself can stall.

## Numbers

Pošta na Severna Makedonija prints UPU S10 numbers ending in `MK`. Archived lookups show items
starting `RB` and parcels starting `CA`. The issuer of an S10 code does not establish who delivers
it, so detection keeps such codes with the generic postal carrier. `posta-north-macedonia-s10`, at
low confidence, makes preflight ask Pošta na Severna Makedonija about them. Mail from abroad keeps
the suffix of the post that issued it, and reaches Pošta na Severna Makedonija when a caller names
it, a provider names it, or a result gives North Macedonia as the destination of an S10 item. The
samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking page, `/Tracking/index.html`, reads the number from `tn` and loads the history from
the service above. The former service answered `/tnt/api/query?id={number}` in XML.

## Testing

`npm run test:carriers:live -- carriers/posta-north-macedonia`, with
`POSTA_NORTH_MACEDONIA_TRACKING_NUMBER` set outside the repository to an item the tracker knows.
Optionally set `POSTA_NORTH_MACEDONIA_INBOUND_NUMBER` to check mail from abroad and
`POSTA_NORTH_MACEDONIA_UNKNOWN_NUMBER` to check a code the tracker does not know. Keep runs
short: the site refuses addresses that send many lookups.
