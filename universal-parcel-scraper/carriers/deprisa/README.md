# Deprisa

Deprisa parcels use enabled universal providers. There is no dedicated adapter. Deprisa has
stopped taking parcels from individuals and concentrates on bulk air cargo.

## Numbers

Deprisa guías seen in archived lookups on its own tracker are twelve digits, most starting
`999`, some `505400` or `888000`. Twelve digits are printed by many carriers, so no rule
claims them. The tracker also accepts reference numbers; ten-character `CO` numbers seen
there stay quarantined until a history ties them to Deprisa.

## Links

Deprisa's former tracker read one or more comma-separated numbers from `?track=` on
`deprisa.com/Tracking/`, which older addresses wrote as `/Tracking/index/`. Those links still
name Deprisa. The current tracker at `deprisa.com/es/rastrea` takes the numbers typed into its
search box and opens no parcel from its address.

## Why there is no adapter

The tracker reads a guía's scans with `POST /api/tracking` and `/api/tracking/{number}/events`
on deprisa.com, each sent with a Google reCAPTCHA v3 token or a session token bought with one.
The sender, recipient and proof of delivery also need a code sent to the recipient's phone.
The site refuses networks in many countries, Germany, Switzerland, Mexico and Brazil among
them: Azure Front Door answers HTTP 403 with its block page, while Colombian, US and Spanish
networks get the site. The API host the former tracker read is gone, and Deprisa has no
tracking app.

Deprisa's customer portal on `conectados.deprisa.com` is the platform Sending's tracker runs
on, and its public lookup `pub/locNumSeguimiento.seam` answers from anywhere without a token.
It found none of the public sample numbers, recent ones included, so it is not known to find
Deprisa guías, and Deprisa stays on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
