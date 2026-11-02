# eLOG Luxembourg

eLOG Luxembourg parcels use enabled universal providers. There is no dedicated adapter.

eLOG Luxembourg, whose logo reads LOG, is POST Luxembourg's logistics business for online shops' parcels flown
in from Asia: it sorts them in Luxembourg, clears them through customs and hands them to partner carriers for
delivery across Europe. It also offers cross-docking, fulfilment and transport management. Its site is
elog-luxembourg.com. It is not an alias of [POST Luxembourg](../post-luxembourg/README.md): it keeps its own
order database and tracker, and POST Luxembourg's tracking service has no reason to know its numbers.

## Numbers

Its site gives no number layout: the tracker takes one or several codes, and its scan page reads Code 128
barcodes. No public page shows an eLOG Luxembourg number, so there is no rule. S10 numbers ending `LU` stay
with POST Luxembourg's rule and postal detection.

## Why there is no adapter

Its tracker is an open HTML page without a session or CAPTCHA:
`GET www.elog-luxembourg.com/tracking?q={number}`. Cloudflare fronts it without challenging a plain request
that sends a browser user agent. The page lists the orders it finds, with the consignee's options to ask for
redelivery or update customs details. An unknown number gets HTTP 200 with the heading
"We looked everywhere but could not find any results". No public number is known to see a found reply.

## Links

The tracking page opens numbers from its `q` parameter, on www.elog-luxembourg.com and the bare domain.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
