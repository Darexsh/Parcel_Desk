# Maruti Air Couriers & Cargo

Maruti Air Couriers & Cargo is a domestic courier founded in Mumbai. It carries documents and
parcels between its branches across India. Tracked through the tracker its tracking page frames.
It is not Shree Maruti Courier.

## How it works

1. `direct`: one `GET https://erp.marutiair.com/TrackpageWeb/WebAWBTracking.aspx?AWB={number}`.
   `www.marutiair.com/tracking.html` frames this tracker, whose form posts the number back to the
   same page with ASP.NET's hidden fields; the page looks the number in its address up on the
   server and renders the same answer, so no form state is fetched. It needs no cookie, token,
   key or browser.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- A number without a document gets the notice `DETAIL NOT FOUND !` under the form, with the number
  left in the field. That notice is the only missing document; a notice with another number in the
  field, or none, is inconclusive. A 404, a 410 or a redirect is a moved route.
- The adapter sends one whole document number and keeps a document only when the page heads its
  one document with that number and the field holds it too. A document for another number, or
  several, are inconclusive and nothing from them is kept.
- Recognition makes the same request.

## Notes

- Every branch is in India and no clock names a zone, so times are read on India's clock. A row
  dated without a time, or at midnight, which the tracker shows for a delivery entered without
  one, keeps only its day.
- A delivery settles the document. Otherwise the newest row with a known stage decides, and the
  heading's status when no row has one.
- The names after `Delivered` and `Out for delivery` are dropped. The sender's and consignee's
  details, the receiver, the signature and the delivery image are not read.

## Limitations

- The parser reads a found document as the tracker's stylesheet lays it out: a heading with the
  docket number and its status, then a history table headed by its date and activity columns. A
  document laid out otherwise reads as a malformed reply, so the enabled fallbacks answer.
- The tracker's host drops connections from some networks, which then fail as transport errors.
- A number reaches the adapter when it is filed under Maruti Air or opened from its link: no rule
  claims its numbers, so preflight does not ask it.

## Numbers

Customers quote document numbers as plain runs of eight or nine digits, and a printed waybill
has ten. The adapter sends runs of eight to ten digits and nothing else. No rule claims them,
since many carriers print digit runs of these lengths. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracker opens one document at `erp.marutiair.com/TrackpageWeb/WebAWBTracking.aspx?AWB=`
followed by the number. The older site used `Doc_Tracking.aspx?No=`.

## Testing

`npm run test:carriers:live -- carriers/maruti-air`, with `MARUTI_AIR_TRACKING_NUMBER` and
optionally `MARUTI_AIR_UNKNOWN_NUMBER` set outside the repository.
