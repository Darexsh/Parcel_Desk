# Geniki Taxydromiki

Greek Geniki Taxydromiki (General Post) vouchers, through the anonymous lookup behind the
tracking page on `taxydromiki.com`.

## How it works

1. `direct`: one `POST https://taxydromiki.com/external_scripts/track-site.php` with the
   JSON body the page sends, `{"lang":"en","voucherNo":"<number>"}`, under a form content
   type. The script relays Geniki's voucher web service: the JSON reply, keyed by the
   requested voucher, carries the service's result code and every checkpoint with its code,
   wording, service point and wall clock. No cookie, nonce, key, account or CAPTCHA is needed.

## Numbers

Every voucher seen has ten digits: in public reports, in lookups archived from the tracker and
in its replies. On every one, the last digit is the first nine modulo 7, as on ACS numbers and
DHL Express waybills. Ten digits are shared with several carriers, so `geniki-taxydromiki-1`
only suggests Geniki Taxydromiki for ten plain digits whose check holds, and recognition asks
it first for a lookup from Greece. The adapter refuses any other shape without a request; the
tracker itself answers any text with not found.

## Notes

- The reply must hold the requested voucher and nothing else. Result 9 is the service's
  "voucher not found" and the only not-found answer. Result 10 (a voucher withheld from the
  site's account), 11 (its expired session), any other result, a refusal (`success: false`),
  a voucher without checkpoints, an empty reply and a missing script are inconclusive, and a
  Cloudflare page is a challenge.
- Checkpoints are mapped by code in [status.ts](status.ts). The wordings come from live
  replies; C_SC and C_S2 are named only by the tracking page's own code, which files them as
  a customer's voucher and a delivery. The page's error codes (`C_EA_*`), cancellations and
  its other in-progress codes have no settled meaning, keep no stage and fall to the shared
  wording rules.
- C_KK, a service point registering a shipment it was handed, can follow the parcel's
  departure scan. The page shows it as the collection by Geniki, so it is accepted, not
  registered.
- The page hides a routing (C_L1), a departure (C_K8) or C_E1 together with the scan that
  cancels it, the last such pair of each kind, and so does the adapter.
- The label scan's service point is "SHIPPER", a role rather than a place, and is dropped.
- Clocks carry no offset and stay local wall times, read in the catalog zone. Fractions of a
  second are dropped.
- The reply's coordinates are the scanning device's position, at the recipient's door for a
  delivery, so they are never read. Nor are the name of whoever received the parcel, the
  return voucher, the delivery summary or the overall status line.
- Recognition asks the tracker and knows a voucher when it returns checkpoints. No detection
  rule offers Geniki Taxydromiki, so recognition is not asked until one does.

## Links

The tracking page opens a voucher at `taxydromiki.com/track/{number}`, fills its field in and
looks the number up on load. Several vouchers are joined with `-`.

## Limitations

The reply has no estimate, sender, pickup point, weight or service name. Vouchers from earlier
years come back as not found.

## Testing

```sh
GENIKI_TAXYDROMIKI_TRACKING_NUMBER=... GENIKI_TAXYDROMIKI_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/geniki-taxydromiki
```
