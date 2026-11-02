# CityMail Pakistan

CityMail Pakistan parcels use enabled universal providers. There is no dedicated adapter.

CityMail Pakistan (CITYMAIL LLC) is a Karachi mail management and cross-border e-commerce company, with a
second head office in Dubai. It delivers Pakistani online shops' orders to the United Arab Emirates, Saudi
Arabia, Oman, Kuwait and Bahrain with cash on delivery, and forwards parcels through its warehouses in the
UAE, Saudi Arabia, the United States and the United Kingdom. Its site is citymail.com.pk. It is not
[CityMail](../citymail/README.md), the Swedish carrier, so its aliases leave out a bare "CityMail".

## Numbers

Its consignment numbers are nine characters, the length at which its tracker sends a lookup; no page says
whether they hold letters. No public page shows one, so there is no rule.

## Why there is no adapter

Its tracker posts the number in `cn_no` to `my.citymail.com.pk/get-tracking-data-web`, without a login or
CAPTCHA but with the session cookies and CSRF token that a GET of its `/track` page gives. It answers JSON
with the parcel's history as an HTML fragment, and an unknown number with HTTP 200, status 9 and "Invalid
consignment no". No public number is known to see a found reply.

## Links

Its tracker has no address for a single number, so no link names it.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
