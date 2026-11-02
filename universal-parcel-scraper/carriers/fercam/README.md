# FERCAM

FERCAM parcels use enabled universal providers. There is no dedicated adapter.

FERCAM S.p.A. is a transport and logistics group based in Bolzano. Its tracking page sends
Italian shipments to the tracker of DACHSER & FERCAM Italia, its joint venture with Dachser
for groupage and home delivery in Italy.

## Numbers

DACHSER & FERCAM Italia's tracker asks for the letter O, the two-digit year and eight digits.
The layout is the tracker's own, but GLS Italy's `gls-it-digit-depot` takes any letter and ten
digits, and no public sample is known, so `fercam-1` only suggests FERCAM. FERCAM's FAQ gives
an older layout, a two-letter branch code, the year and six digits. TNT Italy's rule takes the
same shape, so no rule claims it.

## Links

The tracker opens its result in a new window after an image CAPTCHA, so no address opens one
shipment.

## Why there is no adapter

Every search needs the image CAPTCHA. The myFERCAM portal needs a customer account.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
