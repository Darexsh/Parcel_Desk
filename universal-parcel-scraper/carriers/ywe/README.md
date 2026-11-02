# YWE

YWE is YanwenExpress, a US last-mile network for parcels flown in from China, whose site is
yanwenexpress.com. Universal providers name it YWE. The adapter reads the tracker's own lookup
for numbers of YWE and fourteen digits.

## How it works

1. `direct`: the tracking page asks `GET https://www.yanwenexpress.com/server?label=<number>`
   without a cookie, key or CAPTCHA, and the adapter sends the same request.
2. `retry`: one more read when the first fails to connect or hangs. The first gets half of the
   budget.

## Notes

- The reply is a list with an entry per number asked. Only the entry whose `expressCode` is the
  whole number asked is read.
- A scan is epoch milliseconds with the hub's `timeZone` offset, so every scan has an instant at
  the offset the tracker states. The page shows the same offset beside each scan.
- Scans are English wording from YWE's US hubs and delivery stations, staged by the wording
  recorded in [statuses.json](statuses.json), whatever hub code, failure reason or drop-off place
  it names, then
  the shared rules. The category the page groups parcels by is not read: it files a delivery
  station's receipt under Alert. The scan code becomes `provider_code`.
- A scan's place is its town, state and country. Its street lines, the proof-of-delivery photos,
  the delivery window and the driver's position, which the page asks for separately, are not read.
- A number the tracker has nothing for comes back with its `expressCode` alone, which is no
  history rather than a missing parcel: the tracker answers any number that way. Redirects,
  404s and browser checks are never read as a missing parcel.

## Numbers

Its labels carry YWE and fourteen digits. A lookup on YWE's own tracker, archived by the Wayback
Machine, shows a parcel's US history under such a number, and the tracker still answers it. No
other carrier's rule takes the layout, so `ywe-1` has high confidence. Colis Privé's twelve characters and a
postcode would fit it, so its rule leaves the layout out. Yanwen's own tracker did not know the
archived number; Yanwen's US last-mile numbers of `YW`, a hub code and twelve digits stay with
[Yanwen](../yanwen/README.md).

## Links

`www.yanwenexpress.com/tracking.html?label=` followed by the number opens a parcel. Such links
also turn up holding Yanwen's `YW` numbers, which YWE's tracker does not take, so the link
names YWE only for its own layout and any other number is detected on its own.

## Testing

Set `YWE_TRACKING_NUMBER` and optionally `YWE_UNKNOWN_NUMBER` outside the repository, then run
`npm run test:carriers:live -- carriers/ywe`.
