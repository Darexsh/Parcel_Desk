# Correos de Chile

Tracks Chilean postal references through the anonymous tracking page. The
publicly documented developer API requires customer credentials and is not used.

## How it works

A fresh page request establishes a Liferay session and CSRF token. The adapter
then calls the page's tracking resource with the complete number and checks the
returned shipment's reference and identifier before projecting scans. The resource
includes a large branch directory, so each response has a strict byte limit;
only the shipment detail is retained.

## Notes

The portal supplies scan wall clocks without offsets. They remain local-time
evidence rather than invented instants. They are Santiago's: in Chile's summer
time, Correios Brazil's copies of the same scans carry `-03:00`, Santiago's
offset then. The catalog clock is therefore Santiago's. It places a provider's
copy that has no offset, and 17TRACK's rows, labelled with Chile's winter offset
in summer too, are read on it ([17TRACK](../../providers/seventeentrack/README.md)).
Providers name the carrier "Correos Chile", and ParcelsApp also "Chile Post" or "Chile Correos".

Future progress-rail markers, customer details, delivery names, identity
numbers, notices and the branch directory are excluded. Free-form status text is
replaced with a neutral update. A scan whose whole wording is a known status keeps
its wording and gets a stage. Admission, customs entry, delivery rounds and delivery
must also carry the portal's code. The scans of a parcel leaving Chile match by wording alone,
since providers and an [open-source client's example](https://github.com/josemontesp/correos-chile-npm/blob/277942058928b2101ea8a1a3777e282bfcb48252/ReadMe.md)
give them without one. The parcel app's review (`statusMap`) reads the same and marks
the neutral update a deliberate gap, whatever code comes with it: the stored scan keeps
none of the text it replaced. A direct answer with no staged scan would read to a consumer
as lost progress. A missing shipment response may also mean its
history expired, so it remains inconclusive.
Its not-found notice carries the reason `portal_not_found`, so a consumer can
tell the carrier's answer from an outage.

Radware's bot check stops every plain read of the page, sending it to its
validation host. Set `CORREOS_CHILE_BROWSER_WS_ENDPOINT` to a private Playwright
Chromium service and a lookup starts there instead, without the plain read. It
opens a fresh context, selects the offered hCaptcha text challenge, and submits
the normal verification and tracking forms. The page's separate reCAPTCHA check
still runs. A refused network or unsupported challenge remains a failure for
enabled provider fallback. Without a browser service the plain read runs and its
challenge goes to the same fallback. The browser does not enable HTTP recognition.

hCaptcha follows a refused set of questions with a fresh one at once. A lookup
answers up to three sets, another only while the rest of the lookup still fits.

Exact arithmetic, digit and string questions are answered locally. Other questions
need `CORREOS_CHILE_TEXT_MODEL_URL`, a private OpenAI-compatible chat-completions
endpoint. Only the question is sent, without parcel data, tokens or browser state.
The small model follows a few worked examples better than rules. An answer to a
question that lists words must be one of them, or the model is asked once more with
the choices. A sink-or-float question is asked as whether the thing floats, and one
asking for the listed word that is not of a kind asks about each word on its own: the
model misreads both, but answers the plainer questions far more reliably.
The optional [model Dockerfile](text-model/Dockerfile) serves a pinned,
Apache-licensed Qwen model with llama.cpp; build it from this repository and keep
port 8080 on a private network. Point the setting at `/v1/chat/completions`.
Its Prometheus `/metrics` counts the prompt and answer tokens it has processed, which
shows how often the solver asks. Allow two CPU cores and 2 GB of memory. Both services
are optional; rejected answers retain fallback, and direct history can be shorter than
provider history.

The official mobile app reads the same shipment detail, with no session, key or
bot check, from `GET https://appmovil.correos.cl/api/tracking/tracking_code/{number}/list_status`.
That host only accepts connections from Chilean networks, so the adapter does
not use it. An unknown or expired number answers there with an empty history.

## Numbers

The adapter takes thirteen digits, or an S10 number ending `CL` with a valid check digit, and
refuses other posts' numbers without a request, so a hand-off never asks it about one.

## Testing

Set `CORREOS_CHILE_TRACKING_NUMBER` to an authorized real reference and
optionally `CORREOS_CHILE_UNKNOWN_NUMBER` to a valid-looking unknown reference,
then run `npm run test:carriers:live -- carriers/correos-chile`.
