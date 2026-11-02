# Upaya

Upaya (Upaya City Cargo) is a Nepali courier for online sellers. Its riders collect parcels
from merchants and its hubs deliver them across Nepal. Tracked through the lookup its tracking
page on `upaya.com.np` makes.

## How it works

1. `direct`: one `GET https://upaya.com.np/wp-json/upaya-tracking/v1/track?code={code}`, the
   request the tracking page's script makes for the code typed in. It needs no cookie, nonce,
   key or browser. The JSON reply has `ok`, the code and the result as the page's HTML.
2. `retry`: the same read once more when Upaya cannot be reached.

- The lookup finds a code only with its hyphen, and the page sends it in capitals. The adapter
  accepts it typed either way and sends it in capitals with the hyphen before the last seven
  digits.
- An unknown code gets HTTP 404 with `uot_not_found`, the page's "No order found for this
  tracking code", which is not found. Another 404 is a moved route. HTTP 400 with
  `invalid_code` is a code Upaya does not read as one; another 400 is a changed request. A 403
  or a browser check is a block.
- The result must show the code asked.
- Recognition makes the same request.

## Notes

- Each scan's `<time>` carries its instant in UTC, which the page shows on Nepal's clock. The
  adapter gives it at Nepal's offset, +05:45.
- A scan's description is its heading, then its line, such as `Pickup Process: Failed pickup`;
  a line that opens with its heading stands alone. The page joins the line and the hub that
  made the scan with a middle dot, and the hub is the scan's location. A cancellation's line
  names only the hub.
- The sender keeps the parcel until a rider collects it, so the order, a pickup being assigned
  and a failed pickup are registrations; the shared rules would read the last as a failed
  delivery. A cancellation is an exception whatever its line says. A pickup wording the map
  does not know gets no stage the shared rules give a recipient's pickup or delivery.
- The summary's current status decides the stage when the map knows it; otherwise the newest
  scan with a stage does.
- The service, such as `Door to Door Delivery`, is the service name. The page's sender, receiver,
  order and hub contact details are not kept.

## Limitations

- No estimate, weight or provider code. Wordings after the pickup fall to the shared rules.

## Numbers

Upaya's tracker asks for the tracking code from the SMS. Its example has six letters, five
digits, a hyphen and seven digits, and a merchant's open-source integration shows a code of the
same layout with four digits before the hyphen. `upaya-1` claims the layout when it is typed
with its hyphen; without it the code fits Colis Privé's broad shape. The adapter looks up only
that layout. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

Upaya's tracking form sends the code as `tracking` to `upaya.com.np/track/`, so
`upaya.com.np/track/?tracking={number}` opens one parcel. It finds a code only in capitals with
its hyphen, which the library restores in the links it builds.

## Testing

`npm run test:carriers:live -- carriers/upaya`, with `UPAYA_TRACKING_NUMBER` and optionally
`UPAYA_UNKNOWN_NUMBER` set outside the repository.
