# Fixtures

`delivered.json`, `in-transit.json` and `outbound.json` follow the reply of
`/applet/track/queryFromMainSite`, newest scan first, with a Chinese line and its English version
per scan. `delivered.json` is an import from a warehouse in Korea, by sea, through customs
inspection, then ZTO's domestic network to a parcel station and the collection; its lines name a
courier, a signer, a station, an operator's login and phones. `in-transit.json` is a line haul
from Hong Kong waiting at import customs; one scan names an operator code. `outbound.json` is an
export from the Guangzhou warehouse to ZTO's network abroad, out for delivery; its lines name
scanners, a courier's handle, bags and phones, and its oldest scan has a code the map does not
know and no English. `not-found.json` is the reply for an unknown number, and `image-code.json`
the refusal that asks for an image code.

Numbers, names, handles, phones, places and clocks are invented.
