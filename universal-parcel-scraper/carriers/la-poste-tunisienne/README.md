# La Poste Tunisienne

La Poste Tunisienne parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

La Poste Tunisienne and its express service Rapid-Poste track letters, parcels and EMS items,
domestic and international, by UPU S10 numbers ending in `TN`. Generic postal detection
handles these numbers, so no rule for La Poste Tunisienne claims them. International EMS
items handed to DHL also show a DHL waybill on the tracker; that number is DHL's.

## Links

The tracking form on poste.tn's home page opens
`rapidposte.poste.tn/fr/Item_Events.asp?ItemId={number}`. Rapid-Poste's tracker and the earlier
e-suivi tracker read a number from `ItemId` on `Item_Events.asp`, under `/fr/`, `/an/` and
`/ar/` for French, English and Arabic.

## Why there is no adapter

The tracker renders an item's scans on its server for a plain `GET` of that address, without an
account, token or captcha, as archived lookups show. It and poste.tn do not answer connections
from outside Tunisia: from Europe, the Americas, Asia and the Middle East the connection times
out, while a Tunisian network gets the page. La Poste Tunisienne's Android apps locate post
offices, open postal accounts and make payments; none tracks an item, so La Poste Tunisienne
stays on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
