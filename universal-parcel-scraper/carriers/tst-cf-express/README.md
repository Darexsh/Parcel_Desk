# TST-CF Express

TST-CF Express is a Canadian less-than-truckload freight carrier of TFI International. Its
partner Saia delivers the freight it takes to the United States. Tracked through the lookup its
URL tracing guide describes.

## How it works

1. `direct`: one `GET https://www.tst-cfexpress.com/tracing/by-url?lang=e&PRO={PRO}`, the
   guide's address, which stores the lookup in a new PHP session. It answers
   `[{"errType":"fstatus","finalMsg":"","valStatus":true}]` before a page that refreshes to
   `/tracing/results`. A second `GET` of that page with the session's `PHPSESSID` cookie returns
   the results table. Neither needs a token, key or browser.
2. `retry`: one more try in a new session after a lookup that fails to connect or hangs. The
   first try gets half of the budget.

- A PRO it does not have shows `Not Available` as its PRO and "Invalid Tracking Number". Any
  other notice is inconclusive, and so is a results page that sends the browser back to the
  tracing form, which it does for a session without a lookup. A 404 or a redirect elsewhere is
  a moved route.
- The first column echoes the reference asked and the second names the PRO found; both must be
  the requested PRO. A completed pickup whose freight bill is not entered yet has no PRO in its
  column, and its status names the PRO it was given instead, which must match.

## Notes

- Visitors get a summary, not a history: the shipment history needs an account. The result is
  marked `summary_only` and holds the status line and the milestones the page dates: the
  delivery from the status, the customs release and the pickup's shipped day.
- No clock names its zone, so they stay wall clocks in `local_time`, and the delivery has no
  instant and no `delivered_at`. The shipped day is a date.
- The estimate is the appointment's day once one is made, else the estimated delivery day. The
  page can show a note to call for the estimate instead, which gives none.
- Freight for the United States names its Saia shipment ID, the PRO under which Saia delivers
  it; TST-CF's partner search finds the same shipment by it. When the consignee's state is in
  the United States, the result names Saia and that PRO. Freight Saia brings to Canada names the
  ID too, but TST-CF delivers it, so there is no hand-off.
- The weight in pounds becomes kilograms; the service level is the service name.
- The page also shows the skid or piece count, the charges, the bill of lading and purchase order
  references, and the shipper's, consignee's and third party's towns. Only the consignee's
  province or state is read, for the destination country.

## Limitations

- No history, sender, recipient, signature or delivery receipt; documents need an account.
- A PRO reaches the adapter when it is filed under TST-CF Express or opened from a TST-CF link:
  many carriers use ten digits, so no rule claims them and preflight does not ask it.
- Old PROs, such as the XML tracing guide's example, come back like unknown ones.
- The tracer also takes bills of lading, purchase orders and customer references; the adapter
  asks by PRO only.

## Numbers

TST-CF Express PRO numbers are ten digits, as its tracing guides and an archived lookup on its
tracker show. The XML tracing guide types the PRO as a ten-digit integer, so the adapter takes
ten digits that do not start with 0. Many carriers print ten digits, so no rule claims them.
Freight shipped from the United States carries a PRO number of TST-CF's partner Saia instead.
The samples and their sources are in [`numbers.json`](numbers.json).

## Links

TST-CF's URL tracing guide sends the PRO number as `PRO` to
`tst-cfexpress.com/tracing/by-url`, which redirects to the result for that shipment.

## Testing

`npm run test:carriers:live -- carriers/tst-cf-express`, with `TST_CF_EXPRESS_TRACKING_NUMBER` and
optionally `TST_CF_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
