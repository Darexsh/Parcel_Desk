# Fixtures

Each file follows the reply of `tracking-api.pts.net/tracking` for one number: the shipment's
summary, countries, masked address, last-mile partner and scans oldest first, or the error
envelope.

`delivered.json` is an export delivered by a partner, with a repeated scan and a delay notice.
`returned.json` is a parcel a partner left at a parcel shop, failed to deliver and sent back.
`in-transit.json` is a parcel in customs with no partner yet and a code no map knows.
`partner-number.json` is a parcel asked by its partner's number, which PTS has no scans for.
`not-found.json` is the answer to a number the tracker does not know.

Numbers, places, postcodes, addresses and clocks are invented.
