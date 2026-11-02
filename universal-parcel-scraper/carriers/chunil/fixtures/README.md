# Fixtures

Each file follows the page `www.chunil.co.kr/HTrace/HTrace.jsp?transNo={number}` answers, with
its scripts, its search field holding the number and the route oldest first.

`delivered.html` goes from the sending branch's acceptance to the delivery, with the sender's,
recipient's and signer's masked names, the goods, the parcel count, the branches' phone numbers
and the page's commented-out addresses, as replies carry them. `in-transit.html` is the same
page up to the destination terminal, with the delivery result left empty; no in-transit reply
was seen, so that empty result follows the page's template. `not-found.html` is the page's
answer for a number it has no parcel for.

Numbers, names, branches, terminals, addresses, goods, phone numbers and days are invented.
