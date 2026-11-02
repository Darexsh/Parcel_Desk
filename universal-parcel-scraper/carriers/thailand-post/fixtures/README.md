Synthetic getMailing replies: the numbers, offices, clocks, staff and recipient values are
invented, and the private fields hold `PRIVATE-SYNTHETIC` markers. The shape follows the live
reply: a map keyed by the requested number, newest scan first, epoch-millisecond clocks,
labels keyed by language, and the masked phone in the contact scan's detail.
`delivered.json` is a domestic delivery. `international.json` is an outbound item whose
destination post's scans arrive as EDI rows under portal `99999`, with the markers live
foreign-post rows carry.
