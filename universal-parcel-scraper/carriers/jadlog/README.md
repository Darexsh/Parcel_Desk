# Jadlog

Jadlog parcels use enabled universal providers. There is no dedicated adapter.

Jadlog is a Brazilian parcel carrier in the Geopost group, which aggregators also list as DPD
Brazil.

## Numbers

Jadlog's API documentation names a fourteen-character tracking number, the `cte`, issued with
the consignment note, besides a fourteen-character shipment id and a shorter request code.
Archived lookups on Jadlog's tracking form show fourteen-digit `cte` values. Fourteen digits
are also DPD's parcel layout and are printed by several other carriers, so no rule claims them.
The same field takes the sender's CNPJ.

## Links

Jadlog's tracking form sends the number as `cte` to `jadlog.com.br/jadlog/captcha`, and
archived lookups show that address with `?cte=`. The page asks for a CAPTCHA before it shows a
parcel, so the library reads the number from such an address but does not build one.

The tracking widget belongs to `#formulario` and posts `cte` with its reCAPTCHA v2 answer
to `/jadlog/rastreio`. A separate contact form has another widget. The promotion dialog
can cover the tracking checkbox; dismissing it is necessary before interaction. Google's
audio challenge can refuse automated traffic even after the correct widget opens, leaving
no tracking submission. The official [myJadlog app](https://play.google.com/store/apps/details?id=com.dpdgroup.chatbot.jadlog.prod)
uses Geopost's `dpdgroup.com/concept/webservice` API. Its guest flow obtains an application
token, then reads `/v10/parcels/details/{number}` with `businessUnit=JADLOG` and
`continueWithoutVerification=true`. Guest display settings omit sender and recipient
information. A successful guest token does not establish parcel coverage; this route
has no dedicated adapter until matching history is verified. Firebase Remote Config
supplies the shared application credential; issued guest tokens are temporary.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
