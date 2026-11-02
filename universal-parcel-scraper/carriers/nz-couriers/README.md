# New Zealand Couriers

New Zealand Couriers is a Freightways courier that picks up and delivers parcels across New
Zealand. Tracked through the lookup its tracking page makes. The lookup's tracker and parser
are the group's, in [freightways.ts](freightways.ts): Post Haste, Castle Parcels and Now
Couriers use them under their own names.

## How it works

1. `direct`: one `GET https://public-website.ep-prod.freightways.co.nz/public-website/v1/carriers/NZCouriers/tracking-events`,
   as the script of `nzcouriers.co.nz/track` asks it. A courier ticket goes as
   `?searchType=TK&ticketProductCode={code}&query={number}`, a label or a customer printed
   label's consignment number as `?query={number}`. The number loses its leading zeros, as on
   the page, unless it is a 20-digit SSCC or a consignment number. It needs no cookie, token,
   key or browser. The JSON reply is the consignment with each of its parcels'
   scans, oldest first.
2. With a tracking link that names the sender's account, the receiver site's lookup,
   `GET .../v2/carriers/NZCouriers/customers/{account}/consignments/{number}/tracking-events`,
   is asked first, and the lookup of step 1 when it gets a 204. Its reply is step 1's.

- An unknown number is an empty HTTP 204, which the page reports as not found. A 404 or a
  redirect is a moved route.
- The lookup refuses a query of fewer than six characters with HTTP 400, so a ticket number of
  five digits once its zeros are dropped is not asked as a ticket.
- A customer printed label's consignment number, a sender's letters and digits, can fit a
  ticket's layout. Such a number is asked as a ticket first, then whole when the ticket gets a
  204, in one step.
- The reply's `shortConsignmentId` must be the number asked: the ticket's product code and
  number, or the label alone. A label can also find a customer printed label whose
  consignment number it is, which is another consignment. A customer printed label's
  consignment number comes after the sender's account number, of digits
  or of letters and digits; with a link, that account must be the link's.
- A customer printed label's consignment number is found only under the network that issued
  it, so one asked under another Freightways network reads as not found.
- Recognition is off. The lookup tells a known consignment from an unknown one, but other
  carriers share eight and nine digits and SSCCs, Post Haste prints the same ticket layout,
  and the lookup answers for Freightways' other networks too, so a known answer would not show
  that a number is New Zealand Couriers'.

## Notes

- Each scan's `createdOn` is an instant in UTC and is kept as it is.
- The scan's type, with its subtype after a slash (`NOND/CARD`), is the provider code that
  stages it. A delivery scan that hands a rural parcel to the rural delivery partner,
  `Delivery Handed Over`, keeps the parcel in transit; the partner's `3P/D` scan is the
  delivery.
- A consignment of several parcels lists each parcel's scans; they are kept together, newest
  first. Like the page, the adapter shows a parcel's `Label Created` scan only when it opens the
  parcel's history. The receiver site's lookup gives that scan no type; it reads as registered.
- Each scan names the Freightways network that made it. When the newest is another catalog
  carrier's, that carrier becomes the delivery carrier.
- The reply's `ETA`, which the page does not show, is a weekday and a date without a year. It is
  dated from the parcel's first scan in New Zealand and kept only when the weekday agrees.
- Signatures with the signatory's name, delivery photos, the authority-to-leave tag, the
  barcode, postcodes, branches, drivers and runs are not kept.

## Limitations

- A customer printed label is read only by a consignment number of letters, sometimes after a
  digit, then six to eight digits; one of digits alone reads as a label. A longer run of digits
  is refused, so a number of another carrier's layout, such as Purolator's three letters and
  nine digits, is refused rather than asked and answered as unknown.
- The lookup does not find every customer printed label by its consignment number alone; the
  receiver site asks for one with the sender's account too. A tracking number does not carry
  the account, so such a label needs the link from the shipping email, an optional tracking-URL
  input. Without the link it reads as not found.
- Contract bags, manifest references and other barcodes are not read.
- A consignment the tracker no longer holds reads as not found.
- No weight or service.

## Numbers

A courier ticket or pack carries a product code of two or three letters, or a letter and two
digits, and a ticket number, which the advanced tracker takes as two fields and the single
search box as one entry with a space or hyphen; the corpus writes archived tickets with a
space. Charge labels carry eight digits and international consignments nine. Customer printed
labels pair the sender's account number with a consignment number, so they are not kept. The
track-a-parcel page gives the samples, and archived lookups on the tracker give the tickets.
Post Haste, another Freightways brand, prints tickets in the same layout, and eight or nine
digits are shared by many carriers, so no rule claims them. Nor does one claim a consignment
number: New Zealand Couriers'
[integration guide](https://help.nzcouriers.co.nz/how-to-integrate-tracking-onto-your-website)
calls it the customer's own identifier, and other carriers' consignments share its letters and
digits.

## Links

The links of the four Freightways networks take the same forms, each on its own domain:

- The search box sends a number to `nzcouriers.co.nz/track?query={number}`.
- The receiver site, `receiver.nzcouriers.co.nz`, takes a number as `?track=` or `?query=`, and a
  consignment as `?consignmentid=` with its composite id. A customer printed label's id,
  `CU..{consignment}.{letter}.{account}.{n}`, gives its consignment number, and the link is kept
  for the sender's account. A ticket's or charge label's composite id is not read.
- The older servlet, `/{code}/servlet/ITNG_TAndTServlet` on any of the domain's hosts, gives a
  customer printed label's consignment number from `consignment_id` or `consignment_id_ref`,
  and a charge label from `label_number`. With `customer_number` or `customer_id`, the
  receiver site's or the servlet's link is kept for the sender's account too. A ticket, which
  it takes as two parameters, is not read.
- A kept link is bound to its network's domain and to the consignment number, and stored as the
  receiver site's link: the composite id, or `?request_id=3&customer_number={account}&consignment_id={number}`.

## Testing

`npm run test:carriers:live -- carriers/nz-couriers`, with `NZ_COURIERS_TRACKING_NUMBER` and
optionally `NZ_COURIERS_UNKNOWN_NUMBER` set outside the repository. `FREIGHTWAYS_TRACKING_URL`,
a link of any Freightways network that names the sender's account, tracks a customer printed
label through it.
