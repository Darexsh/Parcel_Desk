# SBS Sokuhai

SBS Sokuhai parcels use enabled universal providers. There is no dedicated adapter.

SBS Sokuhai Support (SBS即配サポート) is the SBS group’s parcel delivery company in Japan.
Its [public tracker](https://www.saqura-web.com/SBS_LTRC/) is dedicated to SBS即配便 and retains
history for two months after collection.

## Retrieval

`https://www.saqura-web.com/SBS_LTRC/KF_5020.aspx?IraNo={number}` returns the detail page as
HTML without a browser bootstrap. Shipment details and scan rows are input values. The
not-found page repeats the requested number while leaving the scan fields empty. An expired
history produces that same page, so it does not prove the parcel never existed.

Archived lookups establish the former positive layout. The current positive flow needs a
number within the retention window before a native adapter can be enabled.

## Links

Archived lookups also use `numberms` on the detail page and `number01` on the `/SBS_LTRC/`
list page. The list’s search form uses ASP.NET Web Forms state.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
