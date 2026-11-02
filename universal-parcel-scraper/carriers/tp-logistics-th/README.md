# TP Logistics

TP Logistics parcels use enabled universal providers. There is no dedicated adapter.

TP Logistics, the company behind Thaiparcels, collects and delivers parcels through its own
branches across Thailand. Its tracker is on tptrack.info.

## Numbers

Archived lookups on the tracker show fifteen-character codes: the origin branch's three letters
and two digits, the date as year, month and day, and a four-digit counter. `tp-logistics-th-1`
claims that layout with low confidence, because three letters and twelve digits are a shape
other carriers print too. The rule leaves out the letter prefixes that other carriers' rules
already claim. The tracker's second box takes e-commerce references of up to thirty
characters; they are merchants' references, so no rule claims them.

## Links

The tracker's search box opens `tptrack.info/ecom/dtrack.php?id={number}&type=a1`, and its
history button opens `tptrack.info/ecom/tdetail.php?fn=a1&code={number}`; both are read. With
`type=tk` or `fn=tk` the same pages look up an e-commerce reference, and those links are not
read.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
