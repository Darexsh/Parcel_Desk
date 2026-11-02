# SCG Express

SCG Express parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Archived lookups on SCG Express's tracker show twelve-digit numbers that start `1100` and end
in the mod 7 check digit that Yamato numbers also use; SCG Express began as a joint venture
with Yamato. A low-confidence rule takes that family, alongside the other carriers that accept
twelve digits. The tracker also takes order ids and phone numbers, which are not parcel
numbers.

## Links

scgexpress.co.th opens one parcel at `/tracking/detail/{number}/`, which redirects to its
search page with the number encoded in the `tracking_search` parameter. The tracker keeps two
months of history.

## Why there is no adapter

SCG has closed SCG Express: it first stopped delivering to consumers and running parcel points,
then ended the business. Its app is gone from both app stores, and its site is no longer
maintained.

The tracker still answers. The app looked a parcel number up without an account through
`POST https://www.scgexpress.co.th/c2-client/?api=v2&module=gethistoricalstatus2` with the JSON
body `{"token":"","search":"{number}","type":"full","shipper_code":"","language":"en"}`, and
the search page renders the same search. With two months of history and no parcels moving, it
finds none, so no answer with scans could be read to build a parser from. An adapter would
send it parcel numbers only, never the phone numbers or order ids it also takes.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
