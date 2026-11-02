# Evdemo Lojistik

Evdemo Lojistik is a Turkish delivery network for furniture and other bulky goods, run from
Kayseri through its own branches. Tracked through its tracking page's own lookup.

## How it works

1. `direct`: one `GET https://www.evdemolojistik.com/takip?kargo_kodu={number}`, the address
   the page's form and its links open. It needs no cookie, token, key or browser. The reply is
   the HTML page: the shipment's number, its details, then a table of its scans, newest first,
   each a clock and a wording.
2. `retry`: the request once more when it fails to reach the site or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- An unknown number gets the page's form with the notice "Takip numarası hatalı olabilir,
  lütfen bilgileri kontrol ediniz.", read as not found. The page shows the same notice without
  a number, so the notice counts only under the tracker's own form.
- The page answers every number with HTTP 200, so a 404 or a redirect is a moved route.
- The page must name the whole number asked.
- Recognition makes the same request.

## Notes

- Scan clocks are wall clocks to the minute with no zone, so they stay `local_time`.
- Scans carry no place and no code; their wording stages them. The tracker has shown two sets
  of wordings, and archived pages had a progress rail with its own labels; all of them are
  mapped. The rail itself is not read.
- A shipment of several packages adds a table per package with its contents and newest scan.
  The shipment's own table is the history; the package tables are not kept.
- The sender's and recipient's masked names, the departure and arrival provinces and the
  departure date are not kept.
- The tracker matches the whole number only; a shorter or longer one gets the not-found notice.

## Limitations

- No places, estimate, weight, service, scan codes or proof of delivery.
- No instants: the page does not say which zone its clocks are in.

## Numbers

Evdemo Lojistik's tracking numbers have twelve digits: 1, the day and month the parcel was
registered, and a rising serial. Archived lookups on its tracker and customer complaints show
them. The adapter takes twelve digits.

No rule claims these numbers. Twelve-digit numbers are shared by many carriers, and the date
inside does not set Evdemo's apart. Marketplace order numbers that customers quote next to them
are not tracking numbers. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

One parcel opens on www.evdemolojistik.com at `/takip` with the number in the `kargo_kodu`
parameter. The tracking form builds that address, and the library reads the number from it.

## Testing

`npm run test:carriers:live -- carriers/evdemo-lojistik`, with `EVDEMO_LOJISTIK_TRACKING_NUMBER`
and optionally `EVDEMO_LOJISTIK_UNKNOWN_NUMBER` set outside the repository.
