# Aramex Australia

Tracks parcels of Aramex Australia, the courier network formerly called Fastway, through the
service its tracking page asks. The `aramex` carrier reads aramex.com, which serves the Middle
East network and does not know these labels.

## How it works

The adapter sends one GET to `www.aramex.com.au/umbraco/api/TrackingApi/GetTrackingData` with the
label as `LabelNo`, the request the tracking page's own script makes. It needs no account, key,
cookie, CAPTCHA or browser. A request that fails to reach Aramex is sent once more within the
budget.

A known parcel answers with the depots that collect and deliver it, its label and its scans
oldest first. The reply counts only when its label is the number asked for. A number the tracker
has no scans for, unknown or only labelled, gets an error naming it, and only that error is a
missing parcel. An error naming another number, any other error, HTTP 404 and a parcel without
visible scans stay inconclusive. Block pages are challenges, and rate limits and other HTTP
errors keep their own failure kinds. Recognition uses the same lookup.

## Numbers

A label is two letters and ten digits; a few start with a digit and a letter, or with a letter
and a digit. The tracker also finds a parcel by the sender's SSCC printed on it, and then names
Aramex's own label, kept as `canonical_tracking_number`. The adapter takes those forms and refuses
anything else without a request. `aramex-au-1` offers the labels with two letters, or a digit and
a letter, at low confidence beside the other carriers whose rules take twelve characters, so
recognition asks Aramex Australia about them. A label with a letter and a digit shares its shape
with other networks, and an SSCC names the sender, so detection offers neither. `MX` labels are
Aramex New Zealand's, so the rule leaves them out.

## Notes

- Scans carry the depot's wall clock without a zone, and the depots span several zones, so they
  are kept as local times. The service's own clock for a depot does not follow daylight saving
  time, so it gives no offset either. Scans stay in the reply's order, newest first as the page
  shows them.
- The page hides the label's own record (`PP0`) and an internal scan (`IOC`) and shows no place
  for scans before pickup; the adapter does the same, and gives the regional linehaul partner's
  depot the page's name for it.
- A scan's heading decides its stage in [status.ts](status.ts). For a heading the map does not
  know, the page script's groups of codes decide, then the shared wording rules. The script's
  problem group mixes failures with customs clearance, so those codes are left to their wording.
  A label notice after pickup is no step back.
- The estimate is the day the page shows: only between pickup and the delivering courier's round,
  and while that day has not passed at the pickup depot. The service is "Priority Delivery" or
  "Economy Delivery", as on the page.
- The scans' explanations, the couriers' ids, the signatory, the signature and delivery photo, the
  delivery instructions, the sender's reference and the collection point's details are never
  read.

## Limitations

A parcel Aramex hands on to another carrier carries an on-forwarding flag and the partner's
label, which the adapter does not read. Scans have no instant, so recognition gives no last
activity time. Aramex New Zealand runs the same tracker on its own host and database,
aramex.co.nz, with labels of the same shape: `aramex-nz` tracks them with this parser and
tracker, and neither host knows the other's labels.

## Links

The link opens the tracking page with the label, `aramex.com.au/tools/track?l=<label>`. Pasted
links on aramex.com.au and on fastway.com.au, Fastway's old host, which redirects there, are read
too. A partner link to Aramex Australia's home page names the carrier.

## Live test

Set `ARAMEX_AU_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/aramex-au/adapter.live.test.ts`.
Optionally set `ARAMEX_AU_UNKNOWN_NUMBER` to check a label Aramex Australia does not know.
