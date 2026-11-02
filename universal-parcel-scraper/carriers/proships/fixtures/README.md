# Fixtures

`tracking-page.html` is the tracking page cut down to the script that looks up the number in its
address, with the nonce it sends and the theme's own nonce beside it. `delivered.json` and
`customs.json` follow the reply of the tracking plugin's WordPress action: the HTML the page
shows, with the number, the current status and the scans newest first, in the plugin's spacing.
`delivered.json` goes from the order to the delivery and lists one customs scan twice;
`customs.json` waits at customs. `not-found.json` is the answer for a number the tracker does not
know.

Numbers, nonces, keys and clocks are invented.
