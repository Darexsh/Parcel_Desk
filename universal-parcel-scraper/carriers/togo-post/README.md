# La Poste du Togo

La Poste du Togo parcels use enabled universal providers. There is no dedicated adapter.

La Poste du Togo, the Société des Postes du Togo, is Togo's postal operator. Its site is laposte.tg.

## Numbers

Its items carry UPU S10 numbers ending `TG`, which postal detection reads. No public page shows one,
so there is no rule of its own.

## Why there is no adapter

Its tracker is its own copy of the UPU's IPS web tracker, the page La Poste Burkina Faso's adapter reads, on
webtrackingprod.laposte.tg, and takes the number without a session or CAPTCHA. That host does not answer
requests from abroad, and a web application firewall turns away scripted and browser visits to laposte.tg
alike. No public number is known to see a found reply.

## Links

The IPS web page opens numbers from its `itemid` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
