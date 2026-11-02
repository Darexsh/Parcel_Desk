# Paxel

Paxel parcels use enabled universal providers. There is no dedicated adapter.

Paxel (PT Global Unggul Mandiri) is an Indonesian courier for same-day and instant deliveries
within and between cities, collected and delivered by its own couriers.

## Numbers

A Paxel AWB is EM and a dot, ten capital letters and digits, then the shipment date, one digit
and six capital letters and digits, joined by hyphens. Paxel's blog and the tracker's
placeholder describe it. The library compares numbers without dots and hyphens, so `paxel-1`
claims EM, ten letters or digits, an eight-digit date starting with 20, one digit and six
letters or digits. No other carrier's numbers or rules use that layout.

## Links

`paxel.co/id/track-shipments?awb_req={number}`, the address archived lookups use, fills the
tracker's form with the number and submits it. The English page, `/en/track-shipments`, is the
same page.

## Why there is no adapter

Cloudflare puts an interactive check, a Turnstile checkbox, in front of every page on
`paxel.co` for visitors outside Indonesia, so a server elsewhere gets HTTP 403 before it
reaches the tracker. Behind the check the tracker is a server-rendered form: the page posts
the numbers, with their dot and hyphens, and its session's form token to
`/{id|en}/track-shipments`, and renders the histories in the reply.

The Paxel Android app (`com.paxel`) shows the history of the signed-in account's own
shipments only, and shares the web tracker's link for any other. The library solves no
CAPTCHA, so Paxel stays on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
