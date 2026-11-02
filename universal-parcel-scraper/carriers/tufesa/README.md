# TufesaPack

TufesaPack is the parcel service of the Tufesa coach line in north-western Mexico and the US
south-west, formerly sold as Tufesa Envíos. Parcels travel in the coaches' holds between Tufesa
branches. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://ventas.tufesa.com.mx/wsrestwebjson/commdatosenvio?codigo={number}&push=-`,
   as the tracker at `tufesapack.com/paqueteria/rastreo/captura` makes it for each code typed in.
   It needs no cookie, token, key or browser. The JSON reply is an array holding one shipment with
   its scans, oldest first, and a delivery block.

- A code the service does not know comes back as message 165, `El codigo que intenta buscar no es
  valido`, with dashes in every field. The page reports an empty array as not found too. Any other
  message number is a lookup that did not finish. A 404 or a redirect is a moved route.
- The reply echoes the number asked. The lookup also finds a shipment by another reference it
  holds, so a shipment number must be the shipment's own `Rastreo` as well.
- Recognition makes the same request.

## Notes

- Each scan has Tufesa's own line, such as `REGISTRO DE EMBARQUE`, a code (`mov`) and the
  wording the page shows, such as `Envío En Tránsito`. The adapter keeps the page's wording and
  the code, and stages scans by the code.
- The page shows only scans with its own wording. The line after a delivery, which names the
  receiver, has none and is dropped.
- A scan's date and time are a wall clock to the minute. The reply names no zone, and the routes
  cross Sonora, which keeps no daylight saving time, other Mexican states, Arizona and California,
  so clocks stay `local_time`.
- The destination branch's receipt is ready for pickup on a shipment the recipient collects there
  (delivery type `OCURRE`), and in transit otherwise.
- The page counts a parcel delivered once its delivery block is recorded, whatever line comes
  last; the adapter does the same.
- The sender, the recipient, the receiver, their signature, the delivery's coordinates, the
  price, the parcel's kind and count and the external reference are not kept.

## Limitations

- No service, weight, delivery estimate or delivery time as an instant. The reply's estimate
  field read `Por definir` on every shipment seen.
- Problem reports (`incidencias`) have not been seen in a reply and are not read.
- No reply read for a four-letter code had a history, so the success path for those codes rests
  on the shipment-number replies.

## Numbers

Shipments have a number of their own, a sequence of digits now eight long. Customers have also
posted codes of four letters followed by six digits under TufesaPack's tracking announcement.
C chez vous, Team Global Express and Border Express print that shape and eight digits are common,
so no rule claims either. The adapter takes both: seven or eight digits without a leading zero,
or four letters and six digits. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The site's home search opens `tufesapack.com/paqueteria/rastreo/captura` with the code in
`codigo`. The tracker there also takes codes typed into its own search field.

## Testing

`npm run test:carriers:live -- carriers/tufesa`, with `TUFESA_TRACKING_NUMBER` and optionally
`TUFESA_UNKNOWN_NUMBER` set outside the repository.
