# Fixtures

The replies follow `getTrackingByNos` for one number: a JSON array with one item, its summary
status and countries in Chinese and the scans in English, newest first.

- `delivered.json` is a parcel flown to Germany and delivered there. Its rows at the destination
  open with the town, and the delivery with the postcode too; one row is listed twice.
- `in-transit.json` goes from the order data to the flight out of China.
- `not-found.json` is the answer for a number the tracker does not know.

Numbers, towns, postcodes and clocks are invented.
