# Yamato Transport

Tracks domestic Japanese shipments through the public Japanese tracking form.
One HTTP form submission returns the shipment summary and scan list. The detail
heading must identify the requested number; an input echo is insufficient.
After return dispatch, subsequent scans belong to the return to the sender.
Detection offers a 12-digit number only when the first eleven digits, divided by
seven, leave the last digit.

## Limitations

The portal usually omits the year from scan dates and delivery estimates. Those
scan dates remain in `provider_time_text`, with no invented timestamp or freshness
watermark. Dates that include a year use Japan's timezone. The summary still
reports the carrier's current state, and its product name (宅急便, ネコポス) becomes
`service_name`. International TA-Q-BIN uses a separate portal.

## Live test

Set `YAMATO_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/yamato/adapter.live.test.ts`.
