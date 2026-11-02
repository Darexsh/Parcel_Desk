# Parcelforce Worldwide

Royal Mail Group's express parcel service. Royal Mail's tracker answers for
Parcelforce numbers, so tracking runs through
[`royal-mail`](../royal-mail/README.md) and needs `TRACKING_CHROMIUM_PATH`.

- Detection names Parcelforce for EMS-series S10 numbers (`E` and any letter,
  ending `GB`), `CP` and `GI` numbers ending `GB`, and 14-character parcel
  numbers: `PB`, the nine-character consignment number and the parcel's
  three-digit place in it.
- A consignment number alone (two letters, seven digits) can no longer be
  tracked: the tracker asks for each parcel's number. Detection does not
  offer it.
- Some domestic services, such as express48, use S10 ranges that read as
  Royal Mail. They track through the same tracker.
- Royal Mail's tracking page is also Parcelforce's, so a `royalmail.com` link
  with a number only Parcelforce issues names Parcelforce. A `parcelforce.com`
  link names Parcelforce whatever its number.
- Parcelforce lists 9, 11, 13, 14, 16 and 21-character numbers. The 16 and
  21-character ones are Royal Mail's domestic references; no 11-character
  number has been seen.
