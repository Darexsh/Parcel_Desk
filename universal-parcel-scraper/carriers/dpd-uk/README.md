# DPD UK

DPD's United Kingdom public parcel history, using fourteen-digit parcel numbers.
Switzerland, Germany and France have separate carrier ids.

## How it works

The official page calls `apis.track.dpd.co.uk/v1/reference` with an empty
postcode to obtain a parcel handle, then reads `/parcels/{handle}` and
`/parcels/{handle}/parcelevents`. These public reads need no account, cookie or
CAPTCHA token. The adapter validates the parcel number in both lookup replies
before reading history under the returned handle.

## Notes

- A number typed with the label's check character is looked up by its
  fourteen digits, as in [dpd](../dpd/README.md). The replies print that
  character too, a digit or a letter.
- Each scan row names the DPD network, a partner network abroad or the
  sender that recorded it, never a place, so events carry no location.
- The sender is the account that booked the parcel, under the name the page
  shows. A parcel its sender hands in at a Pickup shop, which its order record
  or its drop-off shows, names none: the account did not send it, and on a
  return or donation label it is the recipient. The result then holds
  `sender_name: null`, so a name an earlier check gave is dropped.
- A cancellation by the sender is an exception, and a missed round, which names
  the day of the next, a failed attempt.
- Scans leave out the driver's name a sentence gives. The round's notice gives
  the hour of the delivery, then drops it once the round is over. A depot scan
  is reworded as the parcel moves on: it has arrived at the depot, then is there
  ready for delivery, then is at the depot. The parcel app's identity policy
  keeps one row for each such scan, and for a scan stored with the driver's name.
- Fourteen digits is also the shape of other DPD networks and carriers.
  Detection suggests DPD UK first for numbers starting with 1550, the range
  its tracking pages show most, or 1597, the start a British retailer's courier
  help gives for DPD numbers.
- Recognition makes the same lookup. DPD's group tracker and other DPD networks
  also know a British parcel, sometimes only as an order, so recognition asks
  DPD UK first for those ranges or a British country hint, and files the parcel
  under it when they all know it.
- Scan times carry no offset. Scans recorded by `DPD` are on UK time: DPD's
  group tracking service gives the same scans, at the same wall clocks, with
  London's offset. The sender's data record, under the account's display name
  or `Sender`, comes from the same UK system. Both are dated on
  `Europe/London`; a time the clocks skip in spring keeps its wall clock, and
  a repeated autumn time reads as its first occurrence.
- Scans of partner networks abroad and of Pickup shops keep their wall clocks
  in `local_time`, since no source gives their offset. The last update is the
  newest scan's instant when it has one, else its wall clock.
- History stays in the page's newest-first order. Exact repeated scans are
  collapsed, and only a nonempty history produces a successful result.
- Parcel handles and recipient details remain outside the result and errors.

## Limitations

Order and collection references that require a postcode are outside this
adapter's scope. DPD gives a parcel number to a new parcel within months, and
the lookup then reads the newer parcel. Delivery options and proof of delivery behind the postcode
form are not queried. A generic HTTP 404 does not establish parcel absence;
only the reference service's explicit unknown-reference response does.

The [UK Android app](https://play.google.com/store/apps/details?id=com.dpd.yourdpd)
uses a separate consumer API at `https://apis.consumers.dpdgroup.co.uk`.
Its client supplies a Firebase bearer token and `dpdSession` header; saved-parcel
history uses `consumers/{consumerId}/parcels/{parcelCode}/events`. Manual
tracking resolves a number through `parcels/{number}/types/parcelOrCon` before
reading `parcels/{parcelCode}`. This account/session flow provides no simpler
replacement for the public tracking reads above.

## Testing

```sh
DPD_UK_TRACKING_NUMBER=... DPD_UK_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/dpd-uk
```
