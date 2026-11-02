# Integral Pack

Integral Pack Express is an Argentine parcel carrier that ships through a network of
agencies. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://www.integralpack.com.ar/api/seguimiento/buscar?codigo={guide}`,
   with the guide as the tracking page sends it: `IPE-`, then the point of sale in four digits,
   the letter and the number in eight, joined by dashes. It needs no cookie, token, key or
   browser. The JSON reply has the guide's current state, its identity and parcels, and its
   events, oldest first.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- An unknown guide is HTTP 200 with an empty list. The page shows its not-found notice only for
  a 400 or a 404, which the lookup gives for a request without a guide and for a moved route.
  The adapter reads the empty list as not found and a 404 or a redirect as a moved route.
- The reply must name the whole guide asked, by point of sale, letter and number.
- Recognition makes the same request.

## Notes

- An event's clock is a wall clock without a zone, sometimes with a fraction of a second, and
  the page shows its digits as they come. The clocks stay `local_time`, to the second.
- Events carry no code, only a name such as `Creada` or `En destino`, and the town. The
  current state's name settles the status; the page's progress step, derived from it, is not
  read.
- A parcel the recipient collects at the destination agency keeps that agency's name and
  address as its pickup point. For a parcel brought to the door, the address is the
  recipient's and is not kept.
- The weight is the reply's total for the guide's parcels, kept when it is positive.
- The sender's and recipient's names, the delivery address, the payment, the parcels'
  dimensions and the agency's coordinates and phone are not kept.

## Limitations

- No estimate, no service and no delivery time as an instant.
- The current state's reason is not read, since the page does not show it.

## Numbers

An Integral Pack guide is the agency's four-digit point of sale, a letter and a number of up
to eight digits, the layout of an Argentine invoice number. The help page writes it without
separators. The tracker pads the parts and prefixes `IPE-`, and the adapter
takes the guide with or without them, with the letters A, B, C or P the tracker's forms have
offered. The same layout numbers other Argentine companies' receipts, so no rule claims it. The
public guide in [`numbers.json`](numbers.json) is the sample result on the former tracking
page. Another guide in the former site's script is kept out because the tracker shows its
recipient's name.

## Links

The tracker reads the guide from `?codigo=` on `www.integralpack.com.ar/seguimiento` and
searches at once, so `www.integralpack.com.ar/seguimiento?codigo={number}` opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/integral-pack`, with `INTEGRAL_PACK_TRACKING_NUMBER` and
optionally `INTEGRAL_PACK_UNKNOWN_NUMBER` set outside the repository.
