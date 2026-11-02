# BEST Express Vietnam

BEST Express Vietnam parcels use enabled universal providers. There is no dedicated adapter.

BEST Express Vietnam is the Vietnamese parcel network of BEST Inc. It runs its own tracker at
best-inc.vn; `best-transport` is an unrelated Scandinavian carrier.

## Numbers

Archived lookups on the tracker show fourteen-digit waybills and, once, TK followed by nine
digits. Fourteen digits are shared with DPD and other carriers, and a single TK lookup does not
establish a family, so no rule names BEST Express Vietnam.

## Links

`best-inc.vn/track?bills={number}` opens the tracker with the number filled in, the address
archived lookups use; the tracker script also reads `waybill`.

## Why there is no adapter

The tracker posts the waybills to `www.best-inc.vn/express-cc/express/expresslistinfoWithPhone`,
or `expresslistinfo` without its phone step. Without a solved captcha the gateway answers
`risk_001`, "request has risk", for every lookup, real or made up and from a browser too, and
the page then shows BEST's own captcha, a picture to rotate upright. The BEST Express VN
Android app (`com.best.android.vietuser`) calls the same lookup and shows the same captcha,
so BEST Express Vietnam stays on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
