# SwiftX

Tracks SwiftX Express parcels in the United States through the GraphQL query behind SwiftX's own
tracking page. Shippers and forwarders hand parcels to SwiftX for the last mile.

## How it works

1. `trawl`: the browser service opens `swiftx-express.com/track?trackingNumber={number}`. Cloudflare
   puts a managed challenge in front of the page and of every `/api/` route, and the tracker asks
   for the page's own verification before it looks a number up. When Turnstile cannot
   complete, the page offers an image puzzle. The service matches slider cutouts,
   image-joining seams, circular rotations or ordered icons offline and uses the page's
   pointer controls. The page verifies the answer and submits tracking. At most two
   puzzles are attempted, with a refresh through the official control when a puzzle
   cannot be read. Ambiguous puzzles keep provider fallback.
   After verification, the page can ask for recipient phone digits. The helper chooses its
   public Skip control for the same number, without supplying a phone or an unlock token.
   A BASIC summary without scans remains recipient verification required, so providers
   can supply history; it is not another CAPTCHA failure or a missing parcel. BASIC replies
   with scans stay partial. Unlock credentials in the reply remain inside the browser.
   Icon matching preserves proportions when stretching silhouettes to a square makes them ambiguous;
   both comparisons must support the match, with a distinct proportional match required.
   The page then posts one
   `getOfficialWebsiteTrackingInfoBatch` query to `/api/graphql`, a batch holding the number and its
   verification tokens, and gets a compressed JSON reply. The service's capture helper keeps that reply
   only for a batch of exactly the whole number from the page's address; no request is replayed
   outside the browser.

Without the browser service the adapter fails as challenged before any request: plain HTTP and
headless Chrome get Cloudflare's checkbox on the page and its API, even from the unchallenged home
page. Production needs a TRAWL image built with the SwiftX helper.

The reply holds one result per number. A known number's result has `success: true` and its scans.
An unknown one's has `success: false` with the notice "Order not found." and the number echoed,
which is the only missing parcel. A batch refused with `HUMAN_VERIFICATION_REQUIRED`, or a result
with the notice "Verification required.", is a challenge; a batch refused for another reason is
indeterminate, and any other set of results is a schema failure. When the browser service answers HTTP 500 because its browser
stopped at a challenge wall, or because the page never sent its query, the lookup fails as
challenged too, also when the deadline ran out while the next tier was still trying. Any other refusal, a reply naming another number, a GraphQL error, a challenge
page in place of the reply, rate limits and incomplete captures keep their own failure kinds.

## Notes

- Each scan gives its site's wall clock and its offset at that time, `GMT-07:00` or `GMT-7:00`,
  so clocks are instants. The offsets follow each site's daylight saving time. Labels SwiftX's
  system creates carry `GMT-07:00` in every season, which orders correctly with the scans after
  them. The tracker lists scans once they happen; one dated after the reply was read would be
  left out.
- The provider code is the tracker's event code, mapped in [status.ts](status.ts). Other codes go
  to the shared wording rules. A failed pickup at the shipper moves nothing. `DELIVERY_FAILED` also
  marks an exception; with the wording "Package missing" it is one.
- SwiftX's receipt at its origin hub or sorting center is in transit, not an acceptance: the line
  that hands the parcel over has already carried it to the United States, and DHLink relays the
  same scan in transit.
- A failed delivery's wording carries the driver's note on a second line, then SwiftX's help line
  with its phone number and email. The note is kept and the help line is not.
- Scans at SwiftX's hubs, stations and warehouses carry the town and state the reply gives for the
  site. Delivery and failed-delivery rows give the recipient's town, state and postcode as their
  place; they are not read, nor are pickup and return rows' places, any postcode or the
  proof-of-delivery images the page offers.

## Limitations

- Every lookup needs a browser that passes Cloudflare's check and the page's own verification, so
  recognition never asks SwiftX. When the browser service cannot pass them, the lookup fails as
  challenged and the universal providers answer.
- SwiftX's shipper API at `prod.open.swiftx-express.com` needs a partner's key and a signature on
  each request, and its Android app is for staff and contractors.
- The reply names no sender, service, weight or delivery estimate.
- Full history can require recipient phone verification. The adapter accepts no phone input.

## Numbers

SwiftX numbers are SWX followed by eighteen digits, the prefix the tracker's own example uses.
The `swiftx-1` rule claims them.

## Testing

Set `FLARESOLVERR_URL`, plus `SWIFTX_TRACKING_NUMBER` and optionally `SWIFTX_UNKNOWN_NUMBER`
outside the repository, and run `npm run test:carriers:live -- carriers/swiftx/adapter.live.test.ts`.
