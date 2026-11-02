# Israel Post

Israel Post tracking uses the anonymous read in its
[official Android app](https://play.google.com/store/apps/details?id=com.israelpost.israelpost).
The adapter gets `/itemtracecert/items//{number}` from `apimftprd.israelpost.co.il`
with the shared application subscription key. The app builds the doubled slash;
the read needs neither an account token nor the app's bundled client certificate.

The response must name the whole item and contain dated `Maslul` events. Empty
responses echo the identifier with a default category, so they remain inconclusive.
Dates stay as days without invented times or offsets. Repeated scans count once;
sender, recipient, address and payment fields are discarded. Registered-item tracking
covers the carrier's domestic leg, so enabled providers can supplement its history.

## Numbers

Israel Post's search page says its item numbers have thirteen characters. Registered, EMS
and ECO POST items carry UPU S10 numbers ending `IL`. Their issuer proposes Israel Post
for HTTP recognition; an identity-bound history confirms that it knows the item.
Its courier service numbers items with eleven digits and `IL`, which `israel-post-1` claims;
archived lookups on the tracker show both layouts. Other layouts looked up there, such as
eleven digits and `RG`, are not described and stay unclaimed.

Its [tracker page](https://web.archive.org/web/20201129223749/https://www.israelpost.co.il/itemtrace.nsf/mainsearchNOHE?OpenForm&L=EN)
says it follows EMS and ECO POST items sent from abroad, so a postal item going to Israel is
handed to it under the sending post's number.

## Links

The tracker reads the number from `itemcode` on its Hebrew tracking page, often with
`OpenForm` and a language parameter, so that page with `?OpenForm&itemcode={number}` opens one
item. The earlier tracker under `itemtrace.nsf` took the same parameter and now redirects. The
site refuses requests from many networks, and results load only after a CAPTCHA.
The mobile guest read uses a separate API gateway. The older My Post form at
`/umbraco/Surface/ItemTrace/GetItemTrace` requires the page's CSRF token and language id.

## Testing

Set `ISRAEL_POST_TRACKING_NUMBER` and optionally `ISRAEL_POST_SECOND_TRACKING_NUMBER`
and `ISRAEL_POST_UNKNOWN_NUMBER` outside Git, then run:

```sh
npm run test:carriers:live -- carriers/israel-post
```
