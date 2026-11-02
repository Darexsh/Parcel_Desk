# Cargo Expreso

Cargo Expreso parcels use enabled universal providers. There is no dedicated adapter.

Cargo Expreso, based in Guatemala, carries parcels and documents across the country, mostly for
delivery the next working day, with cash on delivery and collect options, and sends shipments
abroad. It also carries parcels within El Salvador, Honduras and Costa Rica, each with a site
and tracker of its own. Its site is cargoexpreso.com.

## Numbers

No public page shows one of its guide numbers (guías) or states their layout, so there is no
rule.

## Why there is no adapter

Each country's tracking page reads the guide from its address and asks that country's tracking
service, with no other input. The sites do not answer connections from European or American
networks, only from some others. No public number has shown a known parcel's reply yet.

## Links

Tracking links carry the guide as `guia` on the Guatemalan tracking page and on the country pages
under `/hn/`, `/sv/` and `/cr/`, and Panama's former `/pa/`. Each page asks only its own
country's system, so a link built from a number opens the Guatemalan one.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
