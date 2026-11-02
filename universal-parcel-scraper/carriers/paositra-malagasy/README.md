# Paositra Malagasy

Paositra Malagasy parcels use enabled universal providers. There is no dedicated adapter.

Paositra Malagasy is Madagascar's national post, based in Antananarivo. Its site is
paositramalagasy.mg.

## Numbers

Paositra Malagasy gives international items UPU S10 numbers ending `MG`. Generic postal detection
handles these numbers, so no rule for Paositra Malagasy claims them. Its domestic tracker takes
the post's own references, whose example is two letters and eleven digits; they stay unclaimed.

## Why there is no adapter

Its domestic tracker asks an open JSON service on its own site without a session or CAPTCHA.
International items are looked up on the UPU's Global Track and Trace page, which the site
embeds, not on the post's own system. No public number has shown a known item's reply yet.

## Links

The tracker looks numbers up in place, so no address names one item.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
