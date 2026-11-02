# Choir Express

Choir Express parcels use enabled universal providers. There is no dedicated adapter.

Choir Express, run by PT FIA Express Indonesia, is an Indonesian courier with agents across the
country. It delivers within Indonesia and sends parcels abroad through partner carriers, with
import, personal shopping and dropship services. Its site is choirexpress.co.id.

## Numbers

No public page shows one of its waybill numbers (resi), so there is no rule.

## Why there is no adapter

Its tracking page needs a session: it posts the waybill with the session's form token, then asks
a JSON service on its own site, which names the partner that carries the parcel abroad and that
partner's waybill. No public number has shown a known parcel's reply yet.

## Links

The tracking page takes numbers typed into its form; there are no tracking links.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
