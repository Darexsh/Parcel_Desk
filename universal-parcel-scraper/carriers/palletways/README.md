# Palletways

Palletways is a pallet network of independent hauliers around central hubs, in the United
Kingdom and across Europe. Tracked through the status lookup of its tracking page, from the
tracking ID alone.

## How it works

1. `direct`: one `GET https://track2.palletways.com/tt_basic.php?dc_syscon={id}`, the HTML
   fragment the [tracking page](https://track2.palletways.com/) loads into itself for the ID
   typed. It needs no cookie, token, key or browser. The adapter sends the
   `X-Requested-With: XMLHttpRequest` header and referer the page script sends.

- The fragment is a table with one row: the tracking ID and the kind of job, the day the job
  is currently due, the shipper's consignment number, the pallets and their weight, and a
  status badge. The answer is a summary without scans.
- The row counts only when its tracking ID is the whole ID asked. A row for another ID, or
  several rows, is inconclusive.
- An unknown ID gets the "Consignment not found" notice with HTTP 200, which is not found. The
  notice does not repeat the ID. The server's "Direct access not permitted" refusal and bot
  checks are challenges; a redirect, a 404 or a 410 is a moved route.
- There is no recognition: no detection rule claims eleven bare digits for Palletways, so
  preflight never asks it.

## Notes

- The badge is the network's status, untranslated whatever the page's language. A completed
  delivery job is delivered; the statuses Palletways' FAQ lists stage the others, and any
  other badge goes to the shared wording rules. Only delivery jobs have been seen, so another
  kind of job keeps its badge without a stage.
- The weight after the pallet count is the whole consignment's, not each pallet's: two-pallet
  replies weigh more than the network's heaviest single pallet.
- The due day is the expected delivery while the job is open. A completed job can keep a due
  day months after the delivery, so it is dropped then.
- The shipper's consignment number and the pallet count are not kept.

## Limitations

- No scan history, locations or delivery time. The page's full details need the delivery
  postcode, which the catalog does not ask for Palletways, so the adapter does not read them
  and enabled universal providers are asked for the history.

## Numbers

Palletways' tracking page and its replies to customers ask for the 11-digit consignment ID.
Reviews quote such IDs, usually after the shipper's own reference. Eleven bare digits are
printed by other carriers too and nothing in the number points to Palletways, so no rule claims
them. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking page loads the result into itself from the number typed and has no address for one
consignment.

## Testing

`npm run test:carriers:live -- carriers/palletways`, with `PALLETWAYS_TRACKING_NUMBER` and
optionally `PALLETWAYS_UNKNOWN_NUMBER` set outside the repository.
