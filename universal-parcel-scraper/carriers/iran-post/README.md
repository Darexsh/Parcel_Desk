# Iran Post

Iran Post parcels use enabled universal providers. There is no dedicated adapter.

The Islamic Republic of Iran Post Company runs the national post of Iran.

## Numbers

Domestic parcels carry 24-digit codes, seen in lookups saved from the official tracker. Other
carriers print 24-digit barcodes too and no published structure sets Iran Post's apart, so no
rule claims them and detection does not offer Iran Post for them. International items carry
UPU S10 numbers ending in IR, which generic postal detection handles.

## Links

The tracker at tracking.post.ir reads the number from the `id` parameter, on its root page and
on the older `search.aspx` page, and loads the history after the page opens. The root page
address opens one parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
