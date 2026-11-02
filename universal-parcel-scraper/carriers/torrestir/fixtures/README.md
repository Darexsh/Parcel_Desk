# Fixtures

Each fixture follows Torrestir's tracker page for one code in Portuguese, `/?id={code}&lang=pt`,
without its styles, scripts and footer: the progress bar, the card with the code and the
shipment's details, then the scan table, oldest first, whose rows carry hidden fields for the
place, the clock, the wording and a warehouse's coordinates.

- `delivered.html` is a shipment delivered in winter after a failed round: the parcel is
  brought back to the warehouse and goes out again the next day. The guia's creation is at
  midnight, as on the tracker.
- `in-transit.html` is a shipment out for delivery with the estimate's day and window, one scan
  listed twice and a collection at midnight on the guia's day.
- `not-found.html` is the tracker's page for a code it holds nothing for: the card and the
  table are empty.

Codes, references, customers, towns, warehouses, coordinates and clocks are invented.
