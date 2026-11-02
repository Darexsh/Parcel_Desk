# Mark Express

Mark Express parcels use enabled universal providers. There is no dedicated adapter.

Mark Express (Mark Express Pvt. Ltd.) is an Indian courier and cargo company with its head office in Kolkata, a
corporate office in New Delhi and franchise delivery points across India. Its site is markexpress.co.in.

## Numbers

Its air waybill numbers are digits only, as its tracking form requires; no page gives their length. The one
public example, from an archived lookup on its former tracking page, is nine digits, and its tracker no longer
finds it. Runs of digits are shared by other carriers, so there is no rule.

## Why there is no adapter

Its tracker is its own copy of the CourierInfo courier management system, an open HTML page without a session or
CAPTCHA: `GET crm.markerp.in/Frm_DocTrackWeb.aspx?docno={number}`. The home page's form opens it over plain
HTTP; HTTPS answers the same. An unknown number gets HTTP 200 with the status "Online Booking Of Specified
A.W.B. Is Not Found...", and a request without a number is redirected to a not-available page. No public
number is known to see a found reply.

## Links

The tracking page on crm.markerp.in, the host the home page's form sends numbers to, opens them from its
`docno` parameter. The host serves Mark Express alone: its tracking page carries Mark Express's logo.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
