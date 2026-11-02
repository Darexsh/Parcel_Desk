# Geis

Tracks consignments of Geis CZ and Geis SK, the Geis Group's general cargo (pallet) networks in
the Czech Republic and Slovakia, through the tracking pages of their country sites. Geis sold its
Czech and Slovak parcel companies to DPDgroup; their parcels are not tracked here.

## How it works

The search form on each site sends the number as `packNumber` to its detail page, which is
rendered on the server. The adapter reads the English page with one GET:
`https://www.geis-group.cz/en/detail-of-cargo?packNumber=<number>`. No account, cookie, form
token, CAPTCHA or browser is needed, and no redirect is followed. Geis CZ's site does not show
Geis SK's consignments, so a number the Czech site does not know is asked at `www.geis-group.sk`
too. The Slovak site also shows Czech consignments, but gave one delivered in Germany its Czech
origin depot as the place of delivery, so the Czech site goes first. A read that fails to reach
Geis is sent once more within the budget.

The page's heading must name the whole requested number. A number neither site knows comes back
with the notice "The shipment no. … was not found or was not handed over for transportation" on
both; only that is a missing consignment. Any other page, a notice on one site with a failure on
the other, and HTTP errors stay inconclusive with their own kinds. Recognition uses the same
lookup.

## Numbers

Geis's integration manual gives consignment numbers thirteen digits, from ranges each customer
is assigned, with no check digit and no common prefix. A label's barcode adds the piece's
two-digit position and a check digit; the tracker does not take it, so the adapter looks the
consignment up when the check digit passes. Anything else is invalid without a request, including
the eleven-digit parcel numbers the tracker showed before Geis sold its parcel service; it no
longer finds them. Thirteen digits are a bare digit run other carriers share, so no rule claims
them and the user picks Geis.

## Notes

Stages come from the status numbers, which Geis publishes in its Track & Trace status guide
(`geis-group.cz/support/Geis_T&T_Statusy_EN.pdf`); the page words them differently from the guide.
Every reason the guide lists for a failed delivery leads to another attempt. General notes, such as
a requested delivery day or a confirmed cash-on-delivery payment, and a partial delivery move
nothing, so the consignment keeps the stage before them.

Each row carries its clock with an offset. Geis's own scans are instants, but a partner's can be
its wall clock under the offset of Geis's servers. A clock is kept as an instant when the offset
is the one the row's country keeps at that time; rows without a country, which include many
partner and delivery scans, keep a local time. A partner's row can name its country before the
town ("DE town"); the code is read as the country. Identical rows are dropped. The total weight is
read; the progress rail, the category, the pieces and their references, and the name of the person
who took delivery are not.

## Limitations

No delivery estimate or sender. Proof of delivery and documents need a customer login. Geis
Poland's tracker is not asked.

## Links

The link opens the Czech page. Pasted links to the Czech, English and Slovak detail pages, and
to the earlier `sledovani-zasilky?p=` and `sledovanie-zasielok?p=` pages, are read too.

## Live test

Set `GEIS_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/geis/adapter.live.test.ts`.
Optionally set `GEIS_UNKNOWN_NUMBER` to check a number neither site knows.
