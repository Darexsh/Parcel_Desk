# ID Express

ID Express parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

ID Express waybills are `ID`, a letter and twelve or thirteen digits; complaints, ID Express's
own replies and lookups on its tracker show the `IDE`, `IDM`, `IDP`, `IDS` and `IDV` prefixes,
`IDV` for a return. Rule `idexpress-1` claims the layout with high confidence, except `IDA` and
twelve digits, which SGH Global Japan's air waybills from Los Angeles use. The tracker also
takes Tokopedia order numbers starting `TKP8` and Tokopedia booking codes starting `TKP01-`,
which other couriers on Tokopedia track too, so no rule claims them.

## Links

ID Express's site sends a search to `www.idexpress.com/lacak-paket?waybillNo={number}`, which
takes several numbers separated by commas; the library reads the number from that address.

## Limitations

ID Express's tracker and app ask for the last four digits of the recipient's phone before they
show a history, so ID Express stays on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
