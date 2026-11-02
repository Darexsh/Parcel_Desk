# Fastbox

Fastbox (패스트박스, fastbox.co.kr) is a Korean fulfilment and cross-border shipping service. It
issues its own FB invoice for a parcel and hands it to a postal or courier partner abroad, often
Korea Post's EMS. Tracked through its own tracking page.

## How it works

1. `direct`: one `GET https://fastbox.co.kr/DHUB/tracking.php?fb_invoice_no={number}`. It needs no
   cookie, key, CAPTCHA or browser, and the server renders the answer.
2. `retry`: one more request after a network failure or a timeout. The first gets half of the
   budget.

- A known invoice gets a shipment table and a history table. The shipment table gives the
  destination, the partner's domestic invoice and its name, and the origin, then the recipient's
  name and address, which the adapter never reads. The page's search form must echo the whole
  invoice.
- An invoice the tracker does not know, or no longer keeps, gets the form alone and an alert that
  the invoice is not valid. Only that answer is not found.
- A redirect or a 404 is a moved route, and a 403 or a browser check a refusal. Any other page
  without the two tables, or with columns the adapter does not know, is a schema failure.

## Notes

- The rows run oldest first: Fastbox's own steps, then the partner's scans, relayed with a
  tracking platform's status tag ("InTransit", "InfoReceived"). Fastbox's steps are staged by
  their tag, a partner's scan by its wording and by its tag where the shared rules do not stage
  the wording. A receipt or the destination post's advance data after the parcel moved on keeps
  it in transit. The tag is the scan's provider code.
- The rows keep each place's clock: Fastbox's and Korea Post's are read on Korea's, the
  destination post's keep their wall clock, wherever they were scanned. So the newest scan is the
  last row rather than the latest clock. A row the page lists twice is kept once.
- When the partner's name and its domestic invoice name the same carrier, as Korea Post's EMS
  and an EMS item ending in `KR` do, that carrier is the delivery partner under that number.

## Limitations

- No delivery estimate, weight or service.

## Numbers

An FB invoice is `FB` and sixteen digits, the format Fastbox's tracker asks for. In every public
invoice the six digits after `FB` are a date (year, month, day), so `fastbox-1` requires one there.
No other carrier's rule or sample takes the layout, so the rule has high confidence.

## Links

The tracker page takes the invoice in `?fb_invoice_no=`.

## Testing

`npm run test:carriers:live -- carriers/fastbox`, with `FASTBOX_TRACKING_NUMBER` and optionally
`FASTBOX_UNKNOWN_NUMBER` set outside the repository.
