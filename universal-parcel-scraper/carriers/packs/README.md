# Packs

Packs is a next-day parcel service for the Benelux that delivers through more than sixty
partner companies. Its shipments are tracked by number and the recipient's postcode through
the form on its tracking page.

## How it works

1. `direct`: one `POST https://www.packs.nl/track-trace/` with the form's fields `zendingnr`,
   `postcode` and `searchcode`, as its submit button sends them. It needs no cookie, token or
   browser. The page comes back with the shipment's status above a progress rail, an expected
   or actual delivery, the sender and delivery address, Packs' shipment number and the status
   details.
2. `retry`: one more try when the request fails to reach Packs or hangs. The first try gets
   half of the budget.

- The postcode is required: without it the page shows its empty form. A Dutch postcode goes
  without its space, a Belgian or Luxembourg one as its four digits.
- The page's notice that it does not know the number and postcode combination is
  `NotFoundError`; a wrong postcode gets the same notice. Another notice is inconclusive.
- The tracker also finds a shipment by its barcode or the sender's reference, and answers
  under Packs' own shipment number. An eight-digit Packs number must come back as that number;
  for anything else, it is returned as `canonical_tracking_number`.
- No recognition: every lookup needs the postcode.

## Notes

- Statuses are the tracker's Dutch sentences. Notices that a delivery window was given or
  changed, or a delivery instruction added, move nothing.
- A delivery stated above the rail settles one the status details have not reached, and its
  clock is the delivery time when no status gives one. The page for an older shipment can have
  no status details; it comes back as a summary.
- The expected delivery above the rail is a day, or a day and a window.
- Clocks are wall clocks without a zone, read in Dutch time, which Belgium and Luxembourg
  share.
- The sender, the delivery address, the progress rail and the links to the delivery options
  and review pages, which carry the postcode, are never read.

## Numbers

A customer's review on Packs' Trustpilot page gives two eight-digit shipment numbers. Archived
lookups on Packs' tracker show eight digits too, and references that start with `A`, `U`,
`UTV` or `GRZ`; none is kept, because each lookup also carries the recipient's postcode. Eight
digits are a bare counter that many carriers print, so no rule claims them.

## Links

Links to the tracker carry the number as `zendingnr` next to the postcode, so the library can
read the number from one but has no template to build one.

## Limitations

- Nothing can be looked up without the postcode, and a wrong postcode reads as not found.
- The page does not repeat a sender's reference, so only the tracker's own match of reference
  and postcode binds it to the shipment.
- No scan locations, signatory or proof of delivery.

## Testing

```sh
PACKS_TRACKING_NUMBER=... PACKS_POSTCODE=... PACKS_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/packs
```
