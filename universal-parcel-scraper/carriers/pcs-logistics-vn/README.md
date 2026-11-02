# PCS Logistics

PCS Logistics, formerly PCS Courier, is a Vietnamese courier based in Hanoi with domestic
express and international services. Tracked through the lookup its tracker page makes.

## How it works

1. `direct`: one `GET https://apiv2.pcs.vn/api/shipment-customer/track-trace-public?OrderNumber[0]={number}`
   with the header `language: en-US`, as the tracker page on pcs-logistics.com sends it. It needs
   no cookie, token, key or browser. The JSON reply has one result per number the tracker knows,
   with the shipment's summary and its scans, newest first.
2. `retry`: the request once more when it fails to reach the service or hangs. The first try
   gets half of the budget, so the retry fits in the rest.

- An unknown number is HTTP 200 with an empty `Result`, which the page reports as not found. A
  waybill the tracker knows without scans has no history; older waybills come back that way.
- A reply with another `StatusCode` is inconclusive. A 404 or a redirect is a moved route.
- The result's waybill (`HAWB_NO`) must be the whole number asked. The page also finds a parcel
  by its reference (`DATA_CODE`); such a match says nothing about whose waybill the number is,
  so it is inconclusive.
- Recognition makes the same request.

## Notes

- Each scan has a day-first wall clock to the second and, under it on the page, the clock it is
  on, such as `VIETNAM Time`. A scan with that label at a place in Vietnam is read on Vietnam's
  clock, which keeps one offset all year. Any other scan, abroad or without the label, keeps its
  wall clock in `local_time`.
- The page lists scans without a status too, with their time and place. They are kept without a
  wording or a stage, and the last status is the newest scan's that has one.
- The scan's status code stages it where it is known, else its wording, from the statuses PCS's
  customer portal names. The page asks for Vietnamese and Japanese wordings on those sites; the
  adapter asks for English.
- The service is the summary's `TOS`, as the page shows it. The destination country is the
  country after the last comma of the destination, when it names one.
- The masked recipient, the reference, the weight, the pieces, the origin and the sent date are
  not kept, nor are the scans' comments, which the page does not show.

## Limitations

- No estimate, no delivery partner or partner number, and no weight: the page and the reply
  give it without a unit.
- The proof-of-delivery photo needs the customer's account code.

## Numbers

The tracker's own examples, on the PCS Courier site and its successor, are fifteen-digit
waybills. Fifteen digits are printed by many carriers, so no rule claims them. The tracker
also answers twelve-digit waybills, a shape just as common. Without a rule of its own, PCS is
not asked during recognition. The adapter sends
eight to forty letters and digits. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracking box opens `pcs-logistics.com/{language}/track-trace?code={number}`, with one
`code` for each number; the first one is read.

## Testing

`npm run test:carriers:live -- carriers/pcs-logistics-vn`, with
`PCS_LOGISTICS_VN_TRACKING_NUMBER` and optionally `PCS_LOGISTICS_VN_NO_HISTORY_NUMBER` for a
waybill the tracker knows without scans and `PCS_LOGISTICS_VN_UNKNOWN_NUMBER` set outside the
repository.
