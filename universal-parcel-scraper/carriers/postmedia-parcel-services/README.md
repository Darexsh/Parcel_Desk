# Postmedia Parcel Services

Postmedia Parcel Services is the parcel delivery network of Postmedia, the Canadian news
publisher, and continues the parcel business of Brunswick News Inc. Amazon.ca names it BNI. It
delivers across Canada, including Amazon parcels. Its parcels are tracked by number and the
recipient's postal code through the API its tracking page asks.

## How it works

1. `direct`: one `GET https://pmparcelservicesapi.postmediaparcelservices.com/query/{number}+{postal code}`,
   the request the page on `postmediaparcelservices.com` makes when its form is submitted. It
   needs no cookie, token, key or browser. The reply is JSON with the parcel's number, its
   expected delivery day and its scans, oldest first.
2. `retry`: the same read once more when the API cannot be reached or hangs. The first try gets
   half of the budget.

- The postal code is required. It goes in capitals, and a Canadian one with the space after
  its first three characters, as the page writes a six-character code.
- A number and postal code the tracker holds nothing under get HTTP 200 with `missing_error`,
  which the page explains as a wrong number, a wrong postal code or a parcel the sender has not
  announced yet. The adapter reads it as `NotFoundError`. Another notice is a schema change; a
  redirect, a 404 or API Gateway's missing-route answer is a moved API.
- The reply must name the whole number asked; one for another parcel is inconclusive.
- No recognition: every lookup needs the postal code.

## Notes

- `event_date_time` carries no offset. The page says all its times are in GMT, and archived
  replies agree: read in any Canadian zone, their newest scans would come after the reply was
  captured. Scans are kept as instants in UTC.
- Each scan has a message in English and in French, a town and a province, given by code or
  by name. The English message is kept, the French one when the English is missing, and the
  province by name as the page shows it. A scan with neither message is left out.
- The expected delivery day is an estimate, dropped once the parcel is delivered.
- A scan saying the parcel is available for pickup carries the pickup point's address and a
  description; neither is read, since no reply with one has been seen. The order date and the
  reply's record ids are not read either.

## Numbers

Archived lookups on the tracker show BNI followed by nine digits, but each of them also carries
the recipient's postal code, so none is kept; `numbers.json` holds an invented placeholder.
Purolator's rule for three letters and nine digits leaves the BNI prefix out, and no rule claims
the layout.

## Links

The tracker's pages, `/` and `/track-your-shipment` in English and French, take the number as
`bniTrackingID` next to the postal code as `bniPostalCode`. Only the number is read from such
links, and the library builds none.

## Limitations

- Nothing can be looked up without the postal code, and a wrong postal code reads as not found.
- The tracker drops a parcel some time after its delivery, and it then reads as not found.
- No weight, service, signatory or proof of delivery.

## Testing

```sh
POSTMEDIA_PARCEL_SERVICES_TRACKING_NUMBER=... POSTMEDIA_PARCEL_SERVICES_POSTCODE=... POSTMEDIA_PARCEL_SERVICES_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/postmedia-parcel-services
```
