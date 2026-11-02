# UPS fixtures

`out-for-delivery.json`: a `GetStatus` reply for a parcel out for delivery, with scan codes, UTC and local/offset scan times, a scheduled day, a ship-to country, and the recipient, address, signature and photo fields the privacy test asserts are dropped. The tests derive the other cases from it. Every value is made up; `1Z999AA10123456784` is synthetic and the `PRIVATE …` strings are placeholders.

`api-out-for-delivery.json`: the official Track API's reply for the same parcel and scans, with its status types, `YYYYMMDD`/`HHMMSS` local pairs, capital towns, delivery dates and the recipient, address, reference and payment fields the privacy test asserts are dropped. Every value is made up.
