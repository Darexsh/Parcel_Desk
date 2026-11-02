# NCS Kurir

NCS Kurir parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Customers quote NCS resi numbers of twelve digits, and NCS-prefixed numbers on bank card
deliveries. Many carriers use twelve-digit waybills and one prefixed sample is too little for a
rule, so NCS has no detection rule. NCS's tracker refuses corporate AWBs, so some business
deliveries, such as bank cards, can only be followed through the sender.

## Links

ncskurir.com opens a lookup at `/ncskurir/track` with the number in the `awb` parameter; the
page fills its field from it and starts the search.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
