# 7-ELEVEN Taiwan

7-ELEVEN Taiwan parcels use enabled universal providers. There is no dedicated adapter.

7-ELEVEN Taiwan (統一超商) carries store-to-store parcels: 交貨便 drop-offs, 賣貨便 orders and
store pickups for online shops.

## Numbers

The E-Tracking page asks for an eight-character drop-off code or an eleven-digit pickup code.
Archived lookups also show twelve-character service codes, a letter and eleven digits. No
rule claims these layouts: bare eleven digits are printed by many carriers, and a D with eleven
digits is the shape of YTO's own rule.

## Links

`eservice.7-11.com.tw/E-Tracking/search.aspx` with `CRM_PaymentNo`, `txtProductNum`,
`ProductNum` or `TrackingNo` carries the number in archived lookups, and the library reads the
number from that address. Only the seller platform's `CRM_PaymentNo` link showed a history; the
others open the search form.

## Why there is no adapter

The E-Tracking page answers only after its form is posted with a four-character picture code
tied to the page's session. The seller platform's `CRM_PaymentNo` link, with its `FLAG` and
`FROM=C2CPlatform` parameters, answers 不允許查詢 (lookup not allowed) for every number,
made-up ones too, so it says nothing about the parcel. Without `FLAG` it opens the search form.
The other E-Tracking pages either ask for the same code or are closed.

The 賣貨便 site links to the same page, and its order pages need a member's sign-in. The
7-ELEVEN Android app (`ecowork.seven`) has no parcel lookup of its own and opens the 賣貨便 site.
The OPEN POINT app (`tw.net.pic.m.openpoint`) opens the 賣貨便 platform with the member's
session. 7-ELEVEN Taiwan stays on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
