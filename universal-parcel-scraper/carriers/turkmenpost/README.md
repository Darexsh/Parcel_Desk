# Turkmenpost

Turkmenpost parcels use enabled universal providers. There is no dedicated adapter.

Turkmenpost (Türkmenpoçta) is Turkmenistan's postal operator, part of the Türkmenaragatnaşyk Agency. Its site
is post.tm.

## Numbers

Its items carry UPU S10 numbers ending `TM`, which postal detection reads. No public page shows one,
so there is no rule of its own.

## Why there is no adapter

Its tracking page reads an open JSON endpoint, as its script shows, without a login or CAPTCHA:
`GET post.tm/api/tracking?track_code={number}` with `Accept: application/json` and an `Accept-Language` of
`tk`, `ru` or `en`. Its reply groups the item's events by place, with times that carry no offset, and an
error comes as a message with a non-2xx status. The whole site answers HTTP 403 to requests from abroad, so an
adapter needs a route from inside Turkmenistan. No public number is known to see a found reply.

## Links

The tracking page opens numbers from its `q` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
