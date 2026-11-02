# AJEX

AJEX Logistics Services is a Saudi express and e-commerce delivery company that also serves
the UAE and Bahrain. Tracked through the lookup its shipment-status page makes.

## How it works

1. `direct`: the page's two calls to `apps.aj-ex.com/customer-portal/api/v1/`. The first,
   `POST ajex/login`, sends the visitor key the site's script gives every browser and gets a
   bearer token for twenty minutes. The second, `POST shipments/trackAjexShipments` with that
   token, sends the number encrypted with AES-128-CBC under a key and IV from the same script,
   with the account `AJ47` the page names and `lang` `en`. The reply is the same cipher over
   JSON with the shipment and its scans, oldest first. No cookie, captcha or browser is needed.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- The token serves later lookups until a minute before it expires. A reused token the service
  refuses is replaced once; a fresh one it refuses is reported as a challenge.
- The decrypted reply says `status` 200 for a shipment and 500 with a message otherwise.
  `Waybill Number Does not Exist` is the page's not-found answer. `Invalid Waybill Number
  Format` is invalid input. A 500 without a message is inconclusive. The page sends a visitor
  home on `status` 429, which is reported as rate limited.
- The shipment must name the number asked.
- Recognition makes the same request.

## Notes

- `actionTime` is epoch milliseconds, which the page shows in the visitor's own zone, so each
  scan is an instant.
- Two systems answer through the same lookup. The older one, behind `AJA` numbers, numbers its
  statuses (`80`) and names the hub in the wording. The newer one, behind `A` numbers, has
  `AJ00…` event codes and a status code of 0. The code stages a scan.
- The newer system's note follows its status when it says more, as in `Trip Exception: Load to
  destination - LH-Delay`. A delivery's note is left out, since it can name who took the parcel.
  Phone numbers are taken out of every line.
- Rows without a status, such as a pickup driver being assigned, are left out, as the page
  does. The page also takes "AJEX" out of a city's name.
- The reply carries the recipient's and sender's names, phones and addresses, the goods and the
  weight. None of them are kept. The older system's weights are placeholders such as 0.001.
- The reply's `estimatedDate`, which the page does not show, is sometimes the time of the
  lookup itself, so it is not kept.

## Limitations

- No delivery estimate, service name or proof of delivery.
- The tracker refuses `AJS` numbers as a format it no longer takes, so they end as invalid
  input.
- The newer system answers an unknown `A` number without a message, which stays inconclusive.

## Numbers

The tracker accepts fifteen characters for numbers containing `AJ` and eleven otherwise.
`AJA` or `AJS` followed by twelve digits, which `ajex-1` claims, belong to no other carrier.
Newer numbers are `A` followed by ten digits; GLS Italy's depot numbers share that shape, so no
rule claims it and a number filed under AJEX reaches the adapter. The samples and their sources
are in [`numbers.json`](numbers.json).

## Links

The tracking box opens `aj-ex.com/shipment-status/{number}`, also under `/ar/`; older pages
used `aj-ex.com/tracking?tracking_number={number}`. The library reads the number from either
address. The status page looks the number up with a visitor token the site requests as it
loads; when the page is ready first, it puts the number in the home page's tracking box
instead, one click from the result.

## Testing

`npm run test:carriers:live -- carriers/ajex`, with `AJEX_TRACKING_NUMBER` and optionally
`AJEX_UNKNOWN_NUMBER` set outside the repository.
