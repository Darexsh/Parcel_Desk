# Ghana Post

Ghana Post parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Ghana Post's letters, parcels and EMS items carry UPU S10 numbers ending in `GH`. Generic
postal detection handles these numbers, so no rule for Ghana Post claims them.

## Links

Ghana Post's local tracker at `epstools.ghanapost.com.gh/tracklocal.php` posts the number with
a reCAPTCHA and has no address for one item.

## Why there is no adapter

The local tracker returns an item's history only for a lookup that carries a solved Google
reCAPTCHA checkbox answer. The server checks that answer: without one, or with an empty one, it
returns "Please complete the reCAPTCHA." instead of a history. The track box on ghanapost.com.gh
only opens the tracker site, and its international tracker is the UPU's Global Track & Trace,
which the UPU provider already reads. Ghana Post's Android apps cover digital addresses, rides
and its riders' rounds; none tracks an item. The library solves no CAPTCHA, so Ghana Post stays
on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
