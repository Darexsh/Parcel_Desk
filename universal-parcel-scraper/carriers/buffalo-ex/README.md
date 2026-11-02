# BUFFALO

BUFFALO parcels use enabled universal providers. There is no dedicated adapter.

BUFFALO International Logistics ships parcels from China to South Africa, clears them through
South African customs and delivers them from its own depots or hands them to a local courier.

## Numbers

BUFFALO's tracker calls its number the order number. Archived lookups on its tracker show
BUFZA, ten digits and YQ. The high-confidence rule claims that layout: the BUFZA prefix and YQ
suffix are BUFFALO's own. The former tracker used fifteen-digit order numbers; no rule claims
them, since many carriers print bare digit runs of that length. The customs reference the
tracker shows next to the number is not a tracking number.

## Links

`buffaloex.com/tracks.html?order={number}` is the address the site's home page form submits to;
the tracker opens with an empty form. Archived lookups used the former `track.html` page and the
`express/record` page with the same `order` parameter.

## Limitations

BUFFALO's tracker asks for the last four digits of the parcel's phone number, an image code and a
Cloudflare Turnstile check before it shows a history, and its app tracks only a signed-in
customer's orders, so BUFFALO stays on universal providers. Domestic South African orders start
`BUFEX-` and belong to BUFFALO's South African site, which answers requests from Europe, the
Americas and Asia with its firewall's block page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
