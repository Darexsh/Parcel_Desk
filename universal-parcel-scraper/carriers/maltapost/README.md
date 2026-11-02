# MaltaPost

Tracks MaltaPost items, its own and those from other posts it delivers in Malta, through the
anonymous service behind its own tracking page.

## How it works

The tracking page on `www.maltapost.com/tracking` reads
`GET https://www.maltapost.com/TrackAndTraceApi/v1/trackedItems` with the number as `barcode`.
The adapter sends that one request for one number. No account, cookie, key, CAPTCHA or browser is
needed. A request that fails to reach the service is sent once more within the budget.

The reply names the item's local barcode and, for an item from abroad or a SendOn parcel, its
foreign barcode; the item answers to either. The adapter accepts the reply only when one of them
is the requested number. A reply that names neither and has no history is a missing item, which
the page words as not recognised. An item MaltaPost withholds, a known item without history, a
block page, HTTP errors and malformed replies keep their own failure kinds. Recognition uses the
same lookup.

## Numbers

The service takes MaltaPost's S10 codes, ending `MT`, and the foreign barcode of an item from
abroad, whatever its shape. The adapter takes letters and digits and removes spaces, dots and
hyphens first, since a space breaks the service's lookup; an S10 code ending `MT` must have a
valid check digit.

A code ending `MT` is MaltaPost's, but the issuer of an S10 code does not establish who delivers
it, so detection keeps such codes with the generic postal carrier. A low-confidence rule makes
preflight ask MaltaPost about them.

[Sengi Express](../sengi-express/README.md) hands parcels for Malta to MaltaPost under its own
number: five letters, nine digits and `MT`. ParcelsApp named MaltaPost beside Sengi for one, so a
low-confidence rule shared with Sengi makes recognition ask MaltaPost about that layout too.

## Notes

Each scan carries a UPU event code, MaltaPost's wording, a clock and a place. After a hold or a
failed delivery it also carries a reason and an action; both follow the wording, as on the
tracking page, and the action joins the provider code, because it decides what happens next. A
failed delivery whose action sends the item back is a return, and a later delivery reaches the
sender. A reason that only points at the action is left out. Codes the map does not know go to the
shared wording rules.

The recipient's own steps (a customs declaration or a payment submitted online), holds at the
office of exchange and forwardings between MaltaPost's own centres are not movements: they keep
the stage the item had. The tracking page's progress bar ignores forwardings too.

Clocks carry no offset. MaltaPost's own scans are on Malta's clock and read in its zone, which
the parcel's earlier scans abroad must not lend them. A foreign post's relayed events keep the
wall clock MaltaPost gives them. Places are the post office or the country of a foreign
event; MaltaPost's own name and a foreign office number are dropped. The pickup point is the
MaltaPost office an item waits at, while it waits there or once it was collected there.

The reply also carries the recipient's locality, a masked recipient name and payment flags; none of
them is read.

## Limitations

MaltaPost drops an item's history after about a year, and the item then answers like an unknown
number. Delivery to a parcel locker has not been seen; its scans are staged by their wording until
the map knows them.

## Links

MaltaPost's tracker at `www.maltapost.com/tracking` is a single-page app; its own script opens
one item at `www.maltapost.com/tracking#/tracking?barcode={number}`, and the library reads the
number from that fragment.

## Live test

Set `MALTAPOST_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/maltapost/adapter.live.test.ts`.
Optionally set `MALTAPOST_UNKNOWN_NUMBER` to check a number the service does not know.
