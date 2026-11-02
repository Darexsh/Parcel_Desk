# One by Allegro CZ

One by Allegro CZ parcels use enabled universal providers. There is no dedicated adapter yet.

WE|DO CZ is the Czech courier formed in 2020 from IN TIME spedice and Uloženka. Allegro bought it
with Mall Group and has run it as One by Allegro, with One Box lockers, One Point and One Kurýr,
since 2024. Its site is onedelivery.cz. It is a separate network from Poland's
[Allegro One](../allegro-one/README.md), with its own numbers.

## Numbers

A parcel number is a three-character customer prefix and eight digits. Three lookups archived
from the carrier's own tracker are still answered by it, so `wedo-1` has high confidence. It
takes prefixes of a digit with a letter in the second or third place. All-digit prefixes, which
the carrier's documentation also shows, share eleven digits with many carriers and get no rule,
and DTDC's 7D and 7X numbers are left out. A package barcode adds a letter and a suffix after an
asterisk; no rule reads it.

## Tracker

The tracking page asks Allegro's tracking interface on edge.onedelivery.cz, the one Allegro One
uses, without a cookie, key or CAPTCHA. A dedicated adapter can share Allegro One's client.

## Links

The tracking page opens a parcel from its `numer` parameter. Older links on trace.wedo.cz and
trace.intime.cz carry it as `orderNumber` and now redirect there.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
