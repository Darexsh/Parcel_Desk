# Maple Logistics

Maple Logistics parcels use enabled universal providers. There is no dedicated adapter.

Maple Logistics (便利帶), run by 台灣便利物流, is a Taiwanese home-delivery carrier with its own stations across the
island; online shops such as PChome and momo ship with it. It hands some parcels on to another carrier, such as
T-CAT, under that carrier's number. Its site is 25431010.tw.

## Numbers

Its waybills print ten digits (宅配單號). The barcode adds a leading `0` and a check digit: each of the eleven
digits is multiplied by 7, 9, 1, 2, 3, 4, 5, 6, 7, 8 and 9 in turn, each product keeps its last digit, and the
check digit is the last digit of their sum. The tracker takes either form. Bare ten digits are shared by many
carriers, and twelve digits starting `0` are too, with a check digit the library does not compute, so there is
no rule. The public examples are years old.

## Why there is no adapter

Its tracking page calls a Next.js server action: `POST https://www.25431010.tw/tracking` with the action's id in
the `Next-Action` header, which changes with each deploy and is read from the page's script, and the number as a
JSON array body. It answers without a session or CAPTCHA with the parcel's history, its times with Taiwan's
offset, and the other carrier and its number after a hand-off. An unknown number, or one whose check digit
fails, gets HTTP 500 with only an error digest, as a server fault would. The public numbers are too old for it
to find, so no adapter has been written yet.

## Links

Its tracker has no address for a single number, so no link names it.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
