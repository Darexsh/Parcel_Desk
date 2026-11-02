# Ekart

Tracks Indian ecommerce parcels through Ekart's public tracking website. Bulk freight and LR shipment IDs use a separate service.

The `direct` step opens the tracking page for anonymous session cookies and its CSRF token, then posts the ecommerce tracking ID to the website's JSON feed. Each lookup owns its session, so simultaneous parcels cannot mix tokens.

Tracking IDs are three letters naming the merchant or service, then C, P or R and ten digits (`FMPP`, `MYSR`, `BSIC` and so on); R marks a return pickup. Detection names Ekart for the merchant codes its tracker has followed in public reports and archived tracking links. Other letters also appear on parcels Ekart does not carry, a Chinese forwarder's for one, so another code only suggests Ekart (`ekart-merchant`). That forwarder's `HRBC`, which Cainiao follows and Ekart's tracker did not know on two parcels from China, suggests Cainiao alone.

Recognition makes the same lookup: a history says Ekart knows the number, and its empty answer for one it does not know leaves recognition open.

History retains scan wording, city and epoch timestamps. Ekart words a scan either as prose ("Shipment Created", "Received at …") or as an operational code followed by its hub ("InscannedAtDH - …"); [status.ts](status.ts) maps both, and the code becomes the event's `provider_code`. An RTO code starts the return to the seller: it and every later scan are on the return leg, where a delivery means returned. The parcel app's review (`statusMap`) reads one scan's wording, so "Delivered" stays open there, since the stored scan does not keep the scans before it. The delivery estimate is kept only while the outward delivery is still open, as on the website, so it goes once the parcel is delivered, returning or its pickup is cancelled. An empty object or missing history is inconclusive because it does not establish parcel absence; the empty object, Ekart's answer for a number it does not know, carries the reason `portal_not_found` so a consumer can tell it from an outage. Unknown wording remains visible without an invented milestone.

Live test: `EKART_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/ekart`.
