# Hispapost

Hispapost is a private postal operator in Spain. It delivers marketplace parcels to the
mailbox, the door or a collection point, as well as letters and council notifications.
Tracked through the form of the tracking page hispapost.es links to.

## How it works

1. `direct`: `GET https://intranet.hispapost.es/tracking` for the form's
   `authenticity_token` and the `_hispapost_session` cookie it is bound to, then a
   `POST` to the same address with the token and `barcode`, and the cookie. No account,
   key or browser is needed. Without the page's session the post is sent to the staff
   sign-in, which the adapter reports as a schema error.
2. `retry`: when Hispapost cannot be reached or hangs, the lookup starts again with a new
   page once. The first try gets half of the budget.

- A known barcode gets a page headed with it, the parcel's current status and when it was set.
  The heading must name the barcode asked.
- An unknown barcode gets HTTP 422: the form again, with a message naming the barcode. Only
  that message is not found. A redirect, a 404 or another refusal is not.

## Notes

- The tracker matches the whole barcode as printed, dashes and case included. Normalized
  numbers lose the dashes of Temu numbers, so the adapter puts them back (`BG-`, sixteen
  characters, `-` and the last two digits) before it posts.
- The page has no history, so the result is one dated status marked `summary_only`, and
  enabled fallbacks are asked for the journey before Hispapost.
- The status clock is shown to the minute without a zone and read as Madrid time, where
  Hispapost works from. The page names no place, so a status in the Canary Islands cannot be
  told apart.
- The two wordings replies showed are mapped. Any other wording goes to the shared wording
  rules; the icon beside it is not read.
- Hispapost delivers numbers that marketplaces, their logistics partners and councils give
  out, and other carriers deliver the same families, so no detection rule claims them and
  recognition never asks Hispapost. A lookup reaches it when the carrier is chosen, when a
  result names Hispapost as the delivery carrier, or when a consumer routes a number a
  universal provider names Hispapost for. 17TRACK and ParcelsApp both name it "Hispapost",
  which the catalog name already maps.

## Limitations

- Current status only: no history, place, estimate or recipient.
- AliExpress economy parcels may be unknown to the tracker: Hispapost says AliExpress does not
  register them with it.

## Numbers

Its tracker reads a parcel's barcode, which is the number the marketplace or its logistics
partner gave the parcel: AliExpress economy numbers (CNES and eleven digits), Joom numbers
(BAE, five digits, H and nine digits) and Temu numbers (BG). Customers quote them in
complaints and reviews about Hispapost, and Hispapost's replies name parcels by them. Other
carriers deliver the same families, and CACESA clears the AliExpress and Joom ones through
customs, so no rule claims them for Hispapost. The tracker also knows the barcodes of council
notifications. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker posts its form, so no address opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/hispapost`, with `HISPAPOST_TRACKING_NUMBER` and
optionally `HISPAPOST_UNKNOWN_NUMBER` set outside the repository.
