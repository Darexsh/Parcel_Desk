# FMX

FMX (FMX (M) Sdn Bhd), which brands its site eFMX, is the Freight Mark group's express courier in Malaysia. It
delivers domestic parcels next day to the main towns and in two to three days to rural areas, and clears
cross-border e-commerce imports at its KLIA gateway. Its site is fmx.asia.

## How it works

1. `direct`: one `GET https://www.fmx.asia/result_detail.php?p=1&conno={number}`, the result page its search
   box opens and its links name. It needs no cookie, session, CAPTCHA or browser. The page takes up to 50
   numbers; the adapter asks for one.
2. `retry`: the request once more when it fails to reach the tracker or hangs. The first try gets half of the
   budget, so the retry fits in the rest.

- A number the tracker has no data for gets HTTP 200 with one heading, `* Consignment Data Generated,
  Awaiting for Handover`, and no consignment card. It reads like a status, but made-up numbers get it too, so
  it is read as not found: only that whole heading, without a card or a timeline, and with the page's
  language links carrying the number asked. Any other page without a card is a schema error. A redirect or a
  404 is a moved route, a firewall page is a challenge and a 429 is a rate limit.
- The card's tracking number must be the whole number asked.
- Recognition makes the same request.

## Notes

- Each scan is a wall clock to the second with no zone, its wording and its station's code and name, newest
  first. The rows name no zone, and an import can pass through stations abroad, so times stay `local_time`:
  consumers date each scan by its place, else by the catalog's Malaysian clock.
- The map stages the wordings seen, where `…` stands for the station a wording names. Other wordings go
  through the shared wording rules, and one they do not read has no stage.
- The stage bar above the card is not read: no capture shows a step marked on it.
- The destination town, the shipper's references, the pickup and delivery dates and the signatory are not
  read. The second reference can show a template expression the page leaks.

## Limitations

- No instants, codes or expected delivery.
- The placeholder is all the tracker shows for a number it has no data for, so a consignment in the state
  its wording names reads as not found.
- The tracker also finds a consignment by the shipper's own reference; the adapter asks only for FMX
  numbers.

## Numbers

Its consignment numbers are `MYX` and ten digits, as its tracking page for a real import and the demo data in
its app guide show. `fmx-1` suggests them at low confidence, since one real example is known, and the adapter
takes the same layout. The tracker's input hint shows `MYC` and nine digits, but no real number has that
shape, so no rule takes it.

## Links

The tracking page opens numbers from its `conno` parameter, also under `/cn/`.

## Testing

`npm run test:carriers:live -- carriers/fmx`, with `FMX_TRACKING_NUMBER` and optionally `FMX_UNKNOWN_NUMBER`
set outside the repository.
