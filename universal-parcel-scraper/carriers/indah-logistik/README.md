# Indah Logistik

Indah Logistik, also called Indah Cargo, carries parcels and cargo by land, sea and air between
its branches across Indonesia and delivers them to the door. Tracked through the lookup its
Android app makes.

## How it works

1. `direct`: one `POST https://indahonline.com/api/internal/indahonlinemobile/getresidetail?english=0`
   with the body `{"nomorResi":"{number}"}`, as the resi tab of the app
   (`com.indahlogistik.checker`) sends it. It carries the Basic login the app signs every
   request with until a customer signs in, the same for every install. It needs no cookie,
   captcha, phone digits or browser. The JSON reply has the waybill and its rows, oldest first.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- An unknown resi is HTTP 200 with `code` 203 and `Nomor Resi Tidak Ditemukan!`, which the app
  reports as not found. The lookup matches whole numbers only, in either case.
- A refused login is HTTP 401 with `code` 208 and reads as a challenge. A request the lookup
  finds incomplete gets `code` 403 and reads as a changed reply. A 404 or a redirect is a moved
  route.
- The waybill must echo the number asked, and a row is kept only when its `no_resi` does too.
- Recognition makes the same request.

## Notes

- The website's resi form asks for the last four digits of the sender's or recipient's phone
  and a Cloudflare Turnstile check. The app's resi tab asks for neither.
- `tanggal_status` is a wall clock to the second with no zone. Indonesia has three zones and
  the reply does not say which one a row uses, so rows keep `local_time`. Rows at the same
  second keep the lookup's order.
- A row's `status` is a wording, a dash and a detail. The description is the wording. Movement
  wordings, and `Transaksi`, name a town after the dash, which becomes the location. Other
  wordings are followed by the courier's name, the receiver's name and relation, or a
  scheduled delivery's note; those are left out, as is the detail of a wording the adapter does
  not know.
- `Transaksi` is the booking at the counter of a branch or drop point, which weighs and prices
  the parcel, so it reads as accepted. `PENGANTARAN TERJADWAL` books the delivery on a later
  run without an attempt, so it reads as in transit.
- The service name is the waybill's `NAMA_JASA` and its `VIA`, as in
  `Indah Logistic Cargo (Darat)`. The weight is `BERAT`, the kilograms the price is charged on.
- The reply carries the sender's and recipient's masked names, addresses and phones, prices,
  staff and driver names, plates, manifests and the courier's phone. None of them are kept. The
  app can show a receiver's photo from a row's `foto_penerima`, which the adapter would not keep
  either.

## Limitations

- No delivery estimate, only a lead time in days, which is not kept.
- No delivery instant or proof of delivery.

## Numbers

A resi starts with the sending branch's three-letter code, then `1CS` and eight or twelve
digits; older numbers have eight. The carrier's own resi page also showed a corporate customer's
twelve-digit number with `PL` after `CS`. These come from the carrier's archived resi page and
from customer questions about Indah Logistik parcels, and the lookup knows them.
`indah-logistik-1` claims these layouts at high confidence: no other carrier's numbers or rules
use them. Shorter examples from a news guide stay unclaimed; the lookup does not know them. The
adapter sends any branch code followed by letters and digits that end in six digits, since the
lookup answers only the whole number. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

`indahonline.com/services/view` opens one resi from its `NO_RESI` parameter. It shows the
waybill's details without its rows, and answers an unknown number with a server error page.

## Testing

`npm run test:carriers:live -- carriers/indah-logistik`, with `INDAH_LOGISTIK_TRACKING_NUMBER`
and optionally `INDAH_LOGISTIK_UNKNOWN_NUMBER` set outside the repository.
