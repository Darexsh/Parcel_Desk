# FamilyMart Taiwan

FamilyMart Taiwan parcels use enabled universal providers. There is no dedicated adapter.

FamilyMart Taiwan (全家便利商店) carries store-to-store parcels: 全家店到店 drop-offs collected at another shop,
cash-on-pickup orders and store pickups for online shops. Its logistics arm 全家日翊 runs the tracker. Its parcel
portal is famiport.com.tw.

## Numbers

Its tracker takes up to thirteen characters: a FamilyMart shipment number (寄件編號) or a shop's own order
number, so there is no fixed layout. No public page shows one, so there is no rule.

## Why there is no adapter

Its tracker asks for a picture code but checks it only in the page's script. The lookup behind it, a POST to
`list.aspx/InquiryOrders` on ecfme.fme.com.tw with the numbers in `ListEC_ORDER_NO`, answers JSON without the
code or a session and says when a number is not found. A number that matches several orders needs the
recipient's name to pick one. No public number is known to see a found reply.

## Links

The QueryBox page, and the tracker page it frames, fill the form from their `orderno` parameter; the picture
code is still needed.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
