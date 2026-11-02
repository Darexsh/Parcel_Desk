# Safexpress

The adapter reads Indian Safexpress waybill history through the guest JSON flow
used by the [official tracker](https://www.safexpress.com/). It obtains a fresh
anonymous token from `dgapi.safexpress.com/sfxweb/waybillinvoicetracking/v1/getpropeliauth2token`,
then posts to `trackingbytype` with that token in the `token` header and
`{"docNo":["<waybill>"],"docType":"WB"}`. No account, CAPTCHA or browser is needed.
Invoice and e-waybill searches are outside this adapter's scope.

The returned waybill and every detail row must match the whole requested number.
An empty status and detail list is inconclusive. A network failure restarts the
guest flow once within the shared lookup budget; HTTP refusals and invalid replies
are not repeated. Tokens and raw request or response diagnostics stay private.

Detail scans retain their local wall clocks. Booking midnight and delivery's
end-of-day marker represent calendar days; the delivery wording gives the same
day without a clock. The separate booking instant agrees with India's local
day and does not establish an offset for the other scans. Only fixed operational
labels and locations from facility templates are returned; recipient details,
free-form messages, internal identifiers and proof-of-delivery data are omitted.
Milestones without dated details remain a partial answer so enabled providers
can supply fuller history. A delivery of fewer than all packages stays open.

Number evidence is in [numbers.json](numbers.json). Overlapping numeric formats
do not identify Safexpress, so tracking requires an explicit carrier selection
or other routing evidence. The home page's encrypted links are not generated.

Run an opt-in live check with `SAFEXPRESS_TRACKING_NUMBER` and optionally
`SAFEXPRESS_UNKNOWN_NUMBER`:

```sh
npm run test:carriers:live -- carriers/safexpress/adapter.live.test.ts
```
