# Libya Post

Libya Post parcels use enabled universal providers. There is no dedicated adapter.

Libya Post (Libya Post Company, شركة بريد ليبيا) is Libya's national post, part of the LPTIC
holding. Its site is libyapost.ly.

## Numbers

Libya Post gives items UPU S10 numbers ending `LY`, as its tracker's example shows. Generic postal
detection handles these numbers, so no rule for Libya Post claims them.

## Why there is no adapter

Its tracker is its own copy of the UPU's IPS web tracker, served on port 7040 of
tracking.libyapost.ly, and answers without a session or CAPTCHA. No public number has shown a
known item's reply yet. An adapter can follow.

## Links

The IPS web page opens numbers from its `itemid` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
