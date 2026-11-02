# Grand Slam Express

Grand Slam Express is a Mumbai-based express courier and logistics company in India. It brings
parcels from China and elsewhere to India, clears them through customs and delivers them, and
also carries freight. Tracked through the lookup its tracking page's script makes.

## How it works

1. `direct`: one `POST https://www.grandslamexpress.in/Web/AwbNoTracking` with the form body
   `AwbNo={number}`, as the script on `Web/Track` sends it. It needs no cookie, token, key or
   browser. The JSON reply's `Error` is empty for a shipment, and its `Result` is the HTML the
   page shows: a heading with the status and the AWB number, the origin and destination, and
   the history, newest first.
2. `retry`: a request that fails to reach the site, or hangs, is sent once more within the
   budget.

- A nine-digit number without a shipment gets `Error` "Please enter valid AWB number!" and no
  HTML, which is not found. Any other message, such as the `EXPIRED` the script also handles,
  and a reply with neither a message nor a shipment are inconclusive.
- The heading and the details' anchor must both name the number asked.
- A reply that is not JSON is a schema failure, or a challenge when it is a bot check or
  firewall page. A 404 or a redirect is a moved route.

## Notes

- Each scan's clock is a wall clock to the minute, as `26-Oct-2026 13:04`, with no zone. Some
  scans are at a hub abroad, such as in China, so the clocks stay `local_time`, as for Bombino,
  rather than taking India's offset.
- The service sorts the history by its clocks. A delivery entered without its time is dated at
  midnight, so it sorts below the day's other scans, and keeps only its day. A delivery in a
  scan or in the heading settles the shipment; otherwise the newest staged scan does.
- Scans come without a code, so their wordings stage them. A manifest, a dispatch or a receipt
  at a branch is in transit, and `CUSTOM HOLD` is customs; other wordings go to the shared
  rules.
- A delivery or a delivery round loses whatever follows its wording, which could name who took
  the parcel or the staff member, and every wording loses phone numbers.
- The destination is kept as a country when it names one. The heading's reference number, the
  booking day, the piece count and the origin are not kept; the reply names no carrier for the
  reference, so it is no hand-off.

## Limitations

- No delivery time as an instant, no estimate, weight, service or sender.
- The tracker takes up to ten numbers at once; the adapter asks for one.

## Numbers

The tracker takes AWB numbers. A lookup archived from it carries a nine-digit AWB number, and
the adapter takes nine digits only. Nine-digit runs are printed by many other carriers, so no
rule claims them: a number reaches the adapter when the user, a link or a provider names the
carrier. The sample and its source are in [`numbers.json`](numbers.json).

## Links

The tracker script reads `AwbNo` from the address of `Web/Track` and looks the number up at
once, so that address opens one parcel and the number is read from it.

## Testing

`npm run test:carriers:live -- carriers/grand-slam-express`, with
`GRAND_SLAM_EXPRESS_TRACKING_NUMBER` and optionally `GRAND_SLAM_EXPRESS_UNKNOWN_NUMBER` set
outside the repository.
