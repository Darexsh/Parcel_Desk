# CNE Express

Direct tracking for CNE cross-border shipments. Detection selects CNE for its `3A5V` numbers; for any other, select CNE explicitly or use its official tracking link.

## Retrieval

One anonymous request to the public website API. Its WebAssembly signing reduces to MD5 with a public client prefix and the website's timestamp inputs, so retrieval does not need browser execution. The parser requires a matching source tracking number and nonempty movement history. The echoed `Number_t` is either that number or, once CNE names the last-mile supplier, the transfer number the supplier tracks.

## Interpretation

CNE's own wordings map exactly, in any capitalisation, since CNE capitalises the same labels differently. Its "Arrived at destination" is the arrival in the destination country, before that network's sorting and customs, not at the delivery office. Partner rows are read by their label, the text before a full-width semicolon, because the explanation after it can announce a later step. A row no rule reads takes its CNE status code, as CNE's tracking page labels the codes; a partner's acceptance that CNE codes as shipping stays transit. A summary code other than shipping (delivered, returned, customs inspection, invalid address, lost, exception or destroyed) outranks the latest row, which can stop at the hand-off.

A named last-mile supplier declares the hand-off: its transfer number becomes the delivery tracking number, and DHL, Royal Mail and USPS are named as the delivery carrier. A supplier is named only with its transfer number, since it does not track CNE's. CNE's `US SPX` is not mapped: no reply has shown which company it is, so only its transfer number's own shape can name one. Without a named supplier, the transfer number can be a merchant's reference and is not followed; merchant references never are.

CNE writes its own labels for the destination network's arrival and hand-over, "Arrived at destination" and "Handled by local carrier", on Beijing time, so they are dated there: read so, they fall in the minute of the Swiss Post scans they repeat, and read on Zurich's clock they came after them. Like any carrier with local clocks, such a row takes over the one an app stored for its wall clock under another offset, with the same place and wording.

## Limitations

Only the `3A5V` family, which CNE's own tracking answers, selects CNE automatically. Scan clocks name no zone and a journey crosses zones, so any other valid clock without an offset stays a wall clock in `local_time`, in CNE's order. When the newest scan has one, it gives `last_update_local` instead of `last_update`, and no delivery time. Scan locations alone do not prove which zone a clock uses, and CNE's other rows abroad are not on Beijing time throughout: read on it, an import airport's arrival in the United States would come before the flight left the transit airport, Zurich Airport's would fall in its night flight ban, and a USPS delivery would fall at night. A clock that is not a valid date and time stays provider text. The summary's delivery date has no zone either, so it gives no delivery time. Rejections and empty replies do not establish parcel absence.

## Testing

`CNE_TRACKING_NUMBER=... npm run test:carriers:live -- carriers/cne`
