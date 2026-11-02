# LibanPost

LibanPost parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

International mail uses UPU S10 numbers, which postal detection handles. LibanPost's tracker
also takes numbers starting `PX`; too few are public to define their layout, so detection does
not claim them.

## Links

The tracker prefills one number from
`libanpost.com/english/tools-support/track-and-trace?sn={number}`, also under `/arabic/`; the
library reads the number from both.

## Why there is no adapter

The page only prefills the number; the history comes from the page's own form postback, which
carries a Google reCAPTCHA checkbox answer. The server checks that answer: without a solved one
it returns the form with "Invalid Captcha", on the English and the Arabic page alike, and the
site's quick-track box only opens the same page. LibanPost publishes no mobile app, so LibanPost
stays on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
