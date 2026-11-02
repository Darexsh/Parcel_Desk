# Polonez

Polonez parcels use enabled universal providers. There is no dedicated adapter yet.

Polonez Express (Polonez America LLC) ships parcels from the United States to Poland from its
New Jersey hub. Meest bought the Polonez Parcel Service trademark in 2023, and Polonez's tracking
page embeds [Meest's](../meest/README.md) tracker. In Poland, KAREX clears customs and GLS
Poland delivers under its own number, which the history names.

## Numbers

A label number is three letters, three digits, two letters and six digits. The example on
Polonez's tracking page, an example on its older site and archived lookups on its old tracker
give six numbers, and Meest's tracker answers the current one, so `polonez-1` has high
confidence. Older M and seven-digit numbers share GLS's and Loggi's layouts and get no rule.

## Tracker

Meest's tracker files the whole history under the label number, but its rows carry no status
code, which the Meest adapter refuses. An adapter can reuse Meest's lookup and read the GLS
Poland number as the delivery partner's.

## Links

Polonez's own page takes no number in its address. Meest's per-parcel page,
`tracking-iframe.meest.com/t/en/<number>`, routes to Meest.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
