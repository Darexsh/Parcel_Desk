# Sengi Express

Sengi Express parcels use enabled universal providers. There is no dedicated adapter.

Sengi Express (Seng Yi (Shenzhen) Global Supply Chain Management) is a Chinese cross-border
forwarder controlled by Poste Italiane. It carries parcels from China to Italy and other European
countries, where Poste Italiane or the destination's post delivers them. Its site is
sengiexpress.com.

## Numbers

Parcels for Malta carry five letters, nine digits and `MT`. ParcelsApp names
[MaltaPost](../maltapost/README.md) beside Sengi for one and relays MaltaPost's scans, so the
rule is low confidence and shared with MaltaPost, the carrier recognition asks about it. Parcels
for Italy are tracked under Poste Italiane's numbers, which its own rules cover.

## Why there is no adapter

Its tracker at portal.sengiexpress.com posts the numbers to `api-v2/tracking/web` without a
session, but answers an empty object for any number it does not hold. No public number has been
found to check its reply with.

## Links

The tracker reads numbers from a form and opens no per-number page, so the catalog sends people
to it.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
