# Sri Lanka Post

Sri Lanka Post parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Sri Lanka Post items carry UPU S10 numbers ending in `LK`. Generic postal detection handles
them, so no rule of its own claims them. Its courier service also gives six-digit counter
references, too generic to claim.

## Links

The trackers on slpmail.slpost.gov.lk and bepost.lk take the number in a form post, so no
address opens one item.

## Why there is no adapter

The SL Post Courier tracker on slpmail.slpost.gov.lk answers only after its form is posted with
a five-letter picture code tied to the page's session. Its item-list form asks for the counter
receipt's number and passcode instead. The Cash on Delivery tracker on bepost.lk needs no code
but holds only COD items, so its "No record found" says nothing about other mail. For mail
abroad, Sri Lanka Post's site links UPU's Global Track & Trace and its PostMate app opens
ParcelsApp, both universal providers here. The library solves no CAPTCHA, so Sri Lanka Post
stays on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
