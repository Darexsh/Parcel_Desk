# Fixtures

`delivered.json` is an unwrapped `queryTrack` payload for a delivered parcel: two `+08:00` origin scans, two `+02:00` destination scans, and recipient and signature fields the adapter must ignore. Shaped after the [ha-sunyou](https://github.com/ha-parcel-integrations/ha-sunyou/blob/main/tests/payloads.py) test payloads; names, address, signature URL and times are made up.

`coded.json` follows the current reply: an `eventCode` on each scan, all in the origin leg, and the last-mile carrier's name, site and reference beside the destination country. The numbers, times and signature URL are made up.
