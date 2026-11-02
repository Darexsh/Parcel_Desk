# Express One

Express One Hungary, a domestic parcel courier. Tracked through its public tracking page.

## How it works

1. `direct`: one `GET https://tracking.expressone.hu/?plc_number={number}` with
   `Accept-Language: en`. The page is rendered on the server; it needs no cookies, key, account
   or browser. Its own language switch stores the choice in a session and redirects, so the
   adapter asks for English through the header instead and follows no redirect.
2. `retry`: one more try when the request fails to reach Express One or hangs. The first try
   gets half of the budget.

- The page never shows the parcel ID. Its link to the other language carries the number it
  looked up; that must be the requested number, otherwise `SchemaError`, and a page without
  the link is inconclusive.
- A number the tracker does not know returns HTTP 404 with the form, the number filled in and
  its "currently unavailable" notice: `NotFoundError`. The notice also covers parcels removed
  after 180 days and parcels the sender has not registered yet. Any other notice or status is
  inconclusive.
- Recognition makes the same request; the not-found answer is the only unknown one.

## Notes

- Stages come from the scan codes, not the wording: the page words them in English or
  Hungarian and has reworded several. `DLS`, the shipment's data entering the system,
  registers the parcel when only the sender's data came before it and is hub handling after a
  scan.
- A rescheduled delivery day (`E17`, `E40`, `E82`, `E92`) moves nothing, so the parcel keeps
  the stage of the scan before it.
- A parcel sent back gets a second history under "Return history". Every scan in it is
  staged `returned`, including its final delivery to the sender.
- Times are wall clocks without an offset. Hub scans name their place, kept as the location.
- The progress rail repeats the history and is not read. Neither is the courier's arrival
  window, which shows no date, nor the signature or any notice beside the history.

## Numbers

Express One's tracker takes a parcel ID or barcode number, or a sender's reference or document
number together with the sender's five-digit company code. The adapter takes parcel IDs only:
twenty-four digits, whose last four repeat the destination postcode, so the corpus keeps none
of them, and thirteen digits, which the tracker shows on some parcels. Both are bare digit runs
that other carriers share, so no rule claims them and the user picks Express One.

## Links

`tracking.expressone.hu/?plc_number={number}` opens one parcel.

## Limitations

- No delivery estimate, weight or service.
- Reference and document-number lookups need the sender's company code and are not supported.

## Testing

`EXPRESS_ONE_TRACKING_NUMBER=... EXPRESS_ONE_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/express-one`
