# SMSA Express

SMSA Express is a Saudi courier that delivers across the kingdom and carries parcels between the
Gulf states, overland and by air. Tracked through the tracking service of its Android app, with
its tracking page as a fallback.

## How it works

1. `app`: one `POST http://strack.cloudapp.net/trackSMSA.svc`, the SOAP `AllTrackDetails`
   operation the SMSA app calls for a twelve-digit airway bill, with the number, `en` and the
   guest login every install of the app sends. The adapter carries that login. The service
   answers plain HTTP only. Its reply has the shipment's details and its scans, newest first,
   each with a code, an instant and the office.
2. `retry`: the same request once more after a failed connection or a timeout.
3. `direct`: `GET https://www.smsaexpress.com/sa/trackingdetails?tracknumbers={number}`, the
   English page the tracking form opens. It needs no cookie, token or browser. It runs after the
   app's service fails, blocks, refuses the login or gives no answer, and never after SMSA's
   answer, a rate limit, maintenance or a reply that no longer parses.

- For an airway bill SMSA does not know, the app's service sends a reply naming only the number,
  and the page a notice naming it: `#{number} This tracking number is not found, …`. Both are
  not found. A reply or notice naming another number is inconclusive, and so is a shipment with
  details but no scans.
- The service's `Username or password is not correct!` is a transport failure, so the page
  answers. A block page, HTTP 200 included, is a challenge; 404, 410 or a redirect is a moved
  route.
- The reply must name the whole airway bill asked.
- Recognition makes the same lookup.

## Notes

- The app's service dates each scan with an offset, `+00:00`, which events keep in `time`. The
  page shows the same scans three hours later, as Saudi clocks, for scans in Kuwait and the UAE
  as well. Its events keep `local_time` with no offset, and the result `last_update_local`.
- The service's codes, such as `HOP` or `BTRO`, are the events' `provider_code`. The map reads the
  wording, which the page shares, since a code comes in variants such as `DEX93-5`.
- The delivery scan goes on with `Signed by:` and the signer, which the adapter drops. The
  recipient, shipper, reference and delivery code in the reply are not kept, nor the scans'
  comments, which can hold a phone number, nor each scan's country code, which reads `SA` for
  scans abroad too.
- The estimate is `03-Oct-2026` on the page and `10/3/2026`, month first, in the service's reply.
  Both give the weight in kilograms. The parcel count and the origin are not kept.
- Not used: `track.smsaexpress.com/secom/smsamobileapp.asmx`, the app's lookup for fifteen-digit
  numbers, refuses the passkey the app ships. `mobileapi.smsaexpress.com` hosts the app's other
  services, such as rates and pickups, none of them tracking. `track.smsaexpress.com` itself
  sends visitors to `www.smsaexpress.com`.

## Limitations

- `www.smsaexpress.com` sends its certificate without the intermediate, Network Solutions RSA OV
  SSL CA 4. Browsers fetch it; Node refuses the page with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, with
  `--use-system-ca` as well. In Node the page answers only when `NODE_EXTRA_CA_CERTS` holds that
  intermediate.
- The app's service is plain HTTP, so the number and the reply travel unencrypted.
- No service name.

## Numbers

SMSA airway bills are twelve digits. No rule claims them: twelve-digit runs are printed by many
carriers, and the prefixes are not documented. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracker takes numbers in a form posted to the home page and shows them at
`smsaexpress.com/sa/trackingdetails`, whose address carries them as `tracknumbers` or
`tracknumbers[0]`, under language or country paths as well. The page also answers a plain
address, so `www.smsaexpress.com/sa/trackingdetails?tracknumbers={number}` opens one parcel. The
earlier tracker read them from `tracknumbers` on `Track.aspx` and `arabic/TrackAr.aspx`.

## Testing

`npm run test:carriers:live -- carriers/smsa-express`, with `SMSA_EXPRESS_TRACKING_NUMBER` and
optionally `SMSA_EXPRESS_UNKNOWN_NUMBER` set outside the repository. The check that the page
holds the service's scans runs when Node trusts the page's certificate chain.
